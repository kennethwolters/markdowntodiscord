import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { convertMarkdown } from "../src/convert.js";

const markdownAlphabet = [
  "a", "Z", "0", " ", "\n", "\r\n", "*", "_", "~", "`", "|", "#", ">", "-", "+", ".",
  "[", "]", "(", ")", "<", ">", "\\", ":", "/", "@", "$", "é", "e\u0301", "😀", "👨‍👩‍👧‍👦", "\u00a0"
];

describe("deterministic robustness properties", () => {
  it("never throws, exceeds the limit, or changes across repeated conversion", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...markdownAlphabet), { maxLength: 1_200 }).map((parts) => parts.join("")),
        fc.boolean(),
        (source, neutralizeMentions) => {
          const first = convertMarkdown(source, { neutralizeMentions });
          const second = convertMarkdown(source, { neutralizeMentions });
          expect(second).toEqual(first);
          expect(first.messages.length).toBeGreaterThan(0);
          expect(first.messages.every((message) => Array.from(message).length <= 2_000)).toBe(true);
        }
      ),
      { numRuns: 500, seed: 20_260_313 }
    );
  });
});
