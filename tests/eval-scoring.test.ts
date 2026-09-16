import { describe, expect, it } from "vitest";
import { containsUrlIdentity, normalizedWhitespace, orderedContains, visibleDiscordText } from "../scripts/lib/eval-semantic-match.js";

describe("semantic evaluation matching", () => {
  it("matches safely encoded Markdown link destinations by URL identity", () => {
    const output = "[safe](https://example.com/a_%28b%29)";
    expect(containsUrlIdentity(output, "https://example.com/a_(b)")).toBe(true);
    expect(containsUrlIdentity(output, "https://example.com/other")).toBe(false);
  });

  it("removes visible Discord escapes outside code but preserves literal code", () => {
    const output = "[REDACTED\\_PHONE]\n\n```txt\nkeep\\_literal\n```";
    expect(visibleDiscordText(output)).toBe("[REDACTED_PHONE]\n\n```txt\nkeep\\_literal\n```");
  });

  it("matches ordered prose across message-boundary whitespace", () => {
    const output = normalizedWhitespace("first phrase \n\ncontinues here");
    expect(orderedContains(output, ["first phrase", "continues here"])).toBe(true);
  });
});
