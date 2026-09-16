import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
addFormats(ajv);
const schema = JSON.parse(readFileSync("data/schema/loop-case.schema.json", "utf8"));
const validate = ajv.compile(schema);
const cases = readFileSync("data/loop/baseline-v1/cases.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
const invariantCase = cases.find((item) => item.labelClass === "invariant-only");
const goldCase = cases.find((item) => item.labelClass === "gold");

describe("loop case schema authority boundaries", () => {
  it("accepts generated invariant and policy-gold records", () => {
    expect(validate(invariantCase)).toBe(true);
    expect(validate(goldCase)).toBe(true);
  });

  it("forbids attaching gold to an invariant-only record", () => {
    const invalid = structuredClone(invariantCase);
    invalid.gold = structuredClone(goldCase.gold);
    expect(validate(invalid)).toBe(false);
  });

  it("requires observed gold to use an observed source and complete observation identity", () => {
    const invalid = structuredClone(goldCase);
    invalid.gold.origin = "observed";
    delete invalid.gold.observationIdentity;
    expect(validate(invalid)).toBe(false);

    invalid.gold.observationIdentity = {
      clientSurface: "web",
      clientVersion: "1",
      releaseChannel: "stable",
      operatingSystem: "test",
      locale: "en-US",
      capturedAt: "2026-01-01T00:00:00Z",
      settings: "default",
      mentionPolicy: "disabled",
      sourceSha256: "0".repeat(64),
      payloadSha256: "1".repeat(64),
      artifactSha256: "2".repeat(64)
    };
    expect(validate(invalid)).toBe(false);
    invalid.source.kind = "observed";
    expect(validate(invalid)).toBe(true);
  });
});
