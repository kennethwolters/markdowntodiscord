# /// script
# requires-python = ">=3.11"
# dependencies = ["pyarrow==25.0.1"]
# ///

import argparse
import gzip
import hashlib
import json
import re
from pathlib import Path

import pyarrow.parquet as pq

MANIFEST_PATH = Path("data/manifests/wildchat-1m-7d6490e.json")
RAW_ROOT = Path("data/raw/wildchat-1m")
CHECKPOINT_PATH = Path("data/work/wildchat-feature-scan.checkpoint.json")
REPORT_PATH = Path("data/reports/wildchat-feature-report.json")

PATTERNS = {
    "fenced_code": re.compile(r"(^|\n)\s*(`{3,}|~{3,})", re.M),
    "inline_code": re.compile(r"(^|[^`])`[^`\n]+`"),
    "gfm_table_candidate": re.compile(r"(^|\n)\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}", re.M),
    "task_list": re.compile(r"(^|\n)\s*[-+*]\s+\[[ xX]\]\s", re.M),
    "markdown_image": re.compile(r"!\[[^\]]*\]\([^\n)]+\)"),
    "inline_link": re.compile(r"(^|[^!])\[[^\]]+\]\([^\n)]+\)"),
    "reference_link": re.compile(r"\[[^\]]+\]\[[^\]]*\]"),
    "footnote": re.compile(r"\[\^[^\]]+\]"),
    "heading": re.compile(r"(^|\n)\s{0,3}#{1,6}\s+\S", re.M),
    "deep_heading": re.compile(r"(^|\n)\s{0,3}#{4,6}\s+\S", re.M),
    "blockquote": re.compile(r"(^|\n)\s{0,3}>\s?", re.M),
    "html": re.compile(r"</?[a-zA-Z][^>]*>"),
    "details_html": re.compile(r"<details\b", re.I),
    "mermaid": re.compile(r"(^|\n)\s*`{3,}mermaid\b", re.I | re.M),
    "latex": re.compile(r"\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]"),
    "discord_mention": re.compile(r"@(everyone|here)\b|<@[!&]?\d+>", re.I),
    "spoiler": re.compile(r"\|\|[^\n|]+\|\|"),
    "horizontal_rule": re.compile(r"(^|\n)\s{0,3}([-*_])(?:\s*\2){2,}\s*($|\n)", re.M),
    "ordered_list": re.compile(r"(^|\n)\s{0,3}\d+[.)]\s+\S", re.M),
    "unordered_list": re.compile(r"(^|\n)\s{0,3}[-+*]\s+\S", re.M),
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-shards", type=positive_int)
    parser.add_argument("--stop-after-groups", type=positive_int)
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text())
    manifest_hash = sha256(MANIFEST_PATH)
    files = manifest["files"]
    shard_limit = min(args.max_shards or len(files), len(files))
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    state = initial_state(manifest_hash) if args.reset else load_state(manifest_hash)
    verify_completed_shards(files, state["nextShard"])
    processed_this_run = 0

    for shard_index in range(state["nextShard"], shard_limit):
        file = files[shard_index]
        path = RAW_ROOT / Path(file["path"]).name
        if not path.exists():
            write_report(manifest, manifest_hash, state, "partial-missing-shard")
            print(f"Missing shard {shard_index}: {path}. Fetch more shards, then resume.")
            return
        verify_shard(path, file)
        parquet = pq.ParquetFile(path)
        start_group = state["nextRowGroup"] if shard_index == state["nextShard"] else 0
        for group_index in range(start_group, parquet.num_row_groups):
            table = parquet.read_row_group(group_index, columns=["conversation", "model"])
            for row in table.to_pylist():
                state["conversations"] += 1
                model = row.get("model") or "unknown"
                state["modelCounts"][model] = state["modelCounts"].get(model, 0) + 1
                for turn in row.get("conversation") or []:
                    if turn.get("role") == "assistant" and isinstance(turn.get("content"), str):
                        analyze(turn["content"], turn.get("language") or "unknown", state)
            state["nextShard"] = shard_index
            state["nextRowGroup"] = group_index + 1
            processed_this_run += 1
            atomic_json(CHECKPOINT_PATH, state)
            if processed_this_run % 10 == 0:
                print(f"checkpoint shard={shard_index + 1}/{len(files)} row_group={group_index + 1}/{parquet.num_row_groups} assistant={state['assistantTurns']:,}")
            if args.stop_after_groups and processed_this_run >= args.stop_after_groups:
                write_report(manifest, manifest_hash, state, "partial-deliberate-stop")
                print("Stopped deliberately at a row-group checkpoint. Re-run to resume.")
                return
        state["nextShard"] = shard_index + 1
        state["nextRowGroup"] = 0
        state["verifiedShards"][str(shard_index)] = file["sha256"]
        atomic_json(CHECKPOINT_PATH, state)

    status = "complete" if state["nextShard"] == len(files) else "partial-shard-limit"
    state["complete"] = status == "complete"
    atomic_json(CHECKPOINT_PATH, state)
    write_report(manifest, manifest_hash, state, status)
    print(f"{status}: conversations={state['conversations']:,} assistant_turns={state['assistantTurns']:,} shards={state['nextShard']}/{len(files)}")


def analyze(text: str, language: str, state: dict) -> None:
    state["assistantTurns"] += 1
    state["languageCounts"][language] = state["languageCounts"].get(language, 0) + 1
    length = len(text)
    bucket = "0-100" if length <= 100 else "101-500" if length <= 500 else "501-2000" if length <= 2000 else "2001+"
    state["lengthBuckets"][bucket] += 1
    for name, pattern in PATTERNS.items():
        if pattern.search(text):
            state["featureCounts"][name] = state["featureCounts"].get(name, 0) + 1
    if unbalanced_fence_candidate(text):
        name = "unbalanced_fence_candidate"
        state["featureCounts"][name] = state["featureCounts"].get(name, 0) + 1


def unbalanced_fence_candidate(text: str) -> bool:
    opened = None
    for line in text.splitlines():
        match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if not match:
            continue
        marker, length = match.group(1)[0], len(match.group(1))
        if opened is None:
            opened = (marker, length)
        elif marker == opened[0] and length >= opened[1]:
            opened = None
    return opened is not None


def initial_state(manifest_hash: str) -> dict:
    return {
        "schemaVersion": 1,
        "manifestSha256": manifest_hash,
        "nextShard": 0,
        "nextRowGroup": 0,
        "verifiedShards": {},
        "conversations": 0,
        "assistantTurns": 0,
        "featureCounts": {},
        "languageCounts": {},
        "modelCounts": {},
        "lengthBuckets": {"0-100": 0, "101-500": 0, "501-2000": 0, "2001+": 0},
        "complete": False,
    }


def load_state(manifest_hash: str) -> dict:
    if not CHECKPOINT_PATH.exists():
        return initial_state(manifest_hash)
    state = json.loads(CHECKPOINT_PATH.read_text())
    if state["manifestSha256"] != manifest_hash:
        raise RuntimeError("Checkpoint manifest differs; verify the new input and use --reset.")
    print(f"Resuming shard={state['nextShard']} row_group={state['nextRowGroup']}")
    return state


def verify_completed_shards(files: list, completed: int) -> None:
    for index in range(completed):
        path = RAW_ROOT / Path(files[index]["path"]).name
        verify_shard(path, files[index])


def verify_shard(path: Path, file: dict) -> None:
    if path.stat().st_size != file["bytes"]:
        raise RuntimeError(f"Size mismatch: {path}")
    actual = sha256(path)
    if actual != file["sha256"]:
        raise RuntimeError(f"Checksum mismatch: {path}: {actual}")
    print(f"verified {path.name} {actual}")


def write_report(manifest: dict, manifest_hash: str, state: dict, status: str) -> None:
    report = {
        "schemaVersion": 1,
        "dataset": manifest["dataset"],
        "revision": manifest["revision"],
        "manifestSha256": manifest_hash,
        "status": status,
        "processedShards": state["nextShard"],
        "nextRowGroup": state["nextRowGroup"],
        "conversations": state["conversations"],
        "assistantTurns": state["assistantTurns"],
        "featureCounts": sorted_counts(state["featureCounts"]),
        "lengthBuckets": state["lengthBuckets"],
        "languageCounts": sorted_counts(state["languageCounts"]),
        "modelCounts": sorted_counts(state["modelCounts"]),
        "countSemantics": "conversations counts Parquet rows; assistantTurns counts assistant-role turns with string content; every feature rate uses assistantTurns as its denominator.",
        "privacy": "Aggregate counts only. IP hashes, headers, geography, user text, and assistant text are not retained.",
        "featureDetection": "Lexical prevalence heuristics, not parser-validity or user-expectation labels.",
    }
    atomic_json(REPORT_PATH, report)


def sorted_counts(value: dict) -> dict:
    return dict(sorted(value.items(), key=lambda item: (-item[1], item[0])))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


if __name__ == "__main__":
    main()
