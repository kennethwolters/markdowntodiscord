# /// script
# requires-python = ">=3.11"
# dependencies = ["pyarrow==25.0.1"]
# ///

"""Build a private, lineage-aware WildChat candidate pool.

The output is gitignored. Only aggregate counts are committed.
"""

import argparse
import hashlib
import json
import re
from pathlib import Path

import pyarrow.parquet as pq

MANIFEST_PATH = Path("data/manifests/wildchat-1m-7d6490e.json")
RAW_ROOT = Path("data/raw/wildchat-1m")
OUTPUT_PATH = Path("data/work/wildchat-candidates.private.jsonl")
SUMMARY_PATH = Path("data/reports/wildchat-candidate-sample-summary.json")

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
    parser.add_argument("--per-feature", type=positive_int, default=40)
    parser.add_argument("--representative", type=positive_int, default=250)
    parser.add_argument("--max-shards", type=positive_int)
    args = parser.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text())
    files = manifest["files"][: args.max_shards or len(manifest["files"])]
    pools: dict[str, list[dict]] = {}
    assistant_turns = 0

    for shard_index, entry in enumerate(files):
        path = RAW_ROOT / Path(entry["path"]).name
        verify(path, entry)
        parquet = pq.ParquetFile(path)
        for group_index in range(parquet.num_row_groups):
            table = parquet.read_row_group(group_index, columns=["conversation_hash", "conversation", "model", "language"])
            for row_index, row in enumerate(table.to_pylist()):
                conversation_hash = str(row.get("conversation_hash") or f"{shard_index}:{group_index}:{row_index}")
                for turn_index, turn in enumerate(row.get("conversation") or []):
                    text = turn.get("content")
                    if turn.get("role") != "assistant" or not isinstance(text, str) or not text.strip():
                        continue
                    assistant_turns += 1
                    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
                    redacted, redactions = redact_direct_identifiers(normalized)
                    text_hash = digest(redacted)
                    features = detect_features(redacted)
                    code_points = len(redacted)
                    record = {
                        "textSha256": text_hash,
                        "sourceRow": assistant_turns,
                        "sourceRecordId": str(turn.get("turn_identifier") or f"{conversation_hash}:{turn_index}"),
                        "lineageId": conversation_hash,
                        "language": str(turn.get("language") or row.get("language") or "unknown"),
                        "model": str(row.get("model") or "unknown"),
                        "codePoints": code_points,
                        "features": features,
                        "text": redacted,
                        "automaticRedactions": redactions,
                        "sourcePiiLabel": None,
                        "requiresHumanPiiReview": True,
                    }
                    offer(pools, "representative", record, args.representative, manifest["revision"])
                    for feature in features:
                        offer(pools, f"feature:{feature}", record, args.per_feature, manifest["revision"])
                    if code_points > 2_000:
                        offer(pools, "length:over-2000", record, args.per_feature * 2, manifest["revision"])
                    if code_points > 4_000:
                        offer(pools, "length:over-4000", record, args.per_feature, manifest["revision"])
                    if len(features) >= 2:
                        offer(pools, "interaction:two-plus", record, args.per_feature * 2, manifest["revision"])
        print(f"sampled {path.name}: assistant_turns={assistant_turns:,}")

    merged: dict[str, dict] = {}
    for stratum, items in pools.items():
        for item in items:
            record = merged.setdefault(item["textSha256"], {k: v for k, v in item.items() if k != "priority"} | {"samplingStrata": []})
            record["samplingStrata"].append(stratum)
    records = sorted(merged.values(), key=lambda item: (item["lineageId"], item["sourceRecordId"]))
    for record in records:
        record["samplingStrata"] = sorted(set(record["samplingStrata"]))

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    atomic_text(OUTPUT_PATH, "".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in records))
    stratum_counts = {key: len(value) for key, value in sorted(pools.items())}
    feature_counts: dict[str, int] = {}
    for record in records:
        for feature in record["features"]:
            feature_counts[feature] = feature_counts.get(feature, 0) + 1
    summary = {
        "schemaVersion": 1,
        "dataset": manifest["dataset"],
        "revision": manifest["revision"],
        "processedShards": len(files),
        "assistantTurns": assistant_turns,
        "uniqueCandidates": len(records),
        "selectedByStratum": stratum_counts,
        "candidateFeatureCounts": dict(sorted(feature_counts.items(), key=lambda item: (-item[1], item[0]))),
        "privateOutput": str(OUTPUT_PATH),
        "privacy": "Private review candidates only. Direct identifier patterns are redacted; every retained case still requires independent privacy review.",
    }
    atomic_text(SUMMARY_PATH, json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(records):,} unique private candidates to {OUTPUT_PATH}")


def offer(pools: dict[str, list[dict]], stratum: str, record: dict, limit: int, revision: str) -> None:
    items = pools.setdefault(stratum, [])
    priority = digest(f"wildchat-semantic-v1\0{revision}\0{stratum}\0{record['textSha256']}")
    if any(item["textSha256"] == record["textSha256"] for item in items):
        return
    items.append(record | {"priority": priority})
    items.sort(key=lambda item: item["priority"])
    del items[limit:]


def detect_features(text: str) -> list[str]:
    result = [name for name, pattern in PATTERNS.items() if pattern.search(text)]
    if unbalanced_fence(text):
        result.append("unbalanced_fence_candidate")
    return sorted(result)


def unbalanced_fence(text: str) -> bool:
    opened = None
    for line in text.splitlines():
        match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if not match:
            continue
        marker = (match.group(1)[0], len(match.group(1)))
        if opened is None:
            opened = marker
        elif marker[0] == opened[0] and marker[1] >= opened[1]:
            opened = None
    return opened is not None


def redact_direct_identifiers(text: str) -> tuple[str, list[str]]:
    patterns = [
        (re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I), "[REDACTED_EMAIL]", "email"),
        (re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b"), "[REDACTED_IPV4]", "ipv4"),
        (re.compile(r"(?<![\w])(?:\+?\d[\d .()-]{8,}\d)(?![\w])"), "[REDACTED_PHONE]", "phone-like"),
    ]
    kinds = []
    output = text
    for pattern, replacement, kind in patterns:
        output, count = pattern.subn(replacement, output)
        if count:
            kinds.append(kind)
    return output, sorted(kinds)


def verify(path: Path, entry: dict) -> None:
    if not path.exists() or path.stat().st_size != entry["bytes"]:
        raise RuntimeError(f"missing or wrong-size shard: {path}")
    if sha256_file(path) != entry["sha256"]:
        raise RuntimeError(f"checksum mismatch: {path}")


def sha256_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def atomic_text(path: Path, value: str) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(value)
    temporary.replace(path)


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


if __name__ == "__main__":
    main()
