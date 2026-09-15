import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertMarkdown } from "../src/convert.js";
import { validateBenchmarkFixture } from "../src/fixtures/schema.js";

const fixtures = readFileSync("data/fixtures/discord-policy-v1.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => validateBenchmarkFixture(JSON.parse(line)));

describe("Discord policy fixtures", () => {
  it("has unique identifiers", () => {
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length);
  });

  for (const fixture of fixtures) {
    it(fixture.id, () => {
      const result = convertMarkdown(fixture.sourceMarkdown, fixture.options);
      expect(result.messages).toEqual(fixture.expectedDiscordMessages);
      expect(result.messages.every((message) => Array.from(message).length <= (fixture.options?.maxMessageLength ?? 2_000))).toBe(true);
      if (fixture.expectedWarningCodes) {
        expect([...new Set(result.warnings.map((warning) => warning.code))].sort()).toEqual([...fixture.expectedWarningCodes].sort());
      }
    });
  }
});

describe("fixture schema", () => {
  it("rejects missing provenance", () => {
    expect(() => validateBenchmarkFixture({ schemaVersion: 1, id: "bad" })).toThrow("provenance");
  });

  it("rejects properties outside the published schema", () => {
    const fixture = structuredClone(fixtures[0]) as unknown as Record<string, unknown>;
    fixture.unexpected = true;
    expect(() => validateBenchmarkFixture(fixture)).toThrow("unknown properties");
  });

  it("rejects duplicate or empty category and warning values", () => {
    const duplicateCategories = { ...structuredClone(fixtures[0]), categories: ["inline", "inline"] };
    expect(() => validateBenchmarkFixture(duplicateCategories)).toThrow("unique values");
    const emptyWarning = { ...structuredClone(fixtures[0]), expectedWarningCodes: [""] };
    expect(() => validateBenchmarkFixture(emptyWarning)).toThrow("non-empty");
  });

  it("rejects unknown nested properties", () => {
    const fixture = structuredClone(fixtures[0]);
    const invalid = { ...fixture, provenance: { ...fixture.provenance, extra: "no" } };
    expect(() => validateBenchmarkFixture(invalid)).toThrow("provenance contains unknown");
  });
});
