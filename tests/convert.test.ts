import { describe, expect, it } from "vitest";
import { convertMarkdown, splitDiscordMessages } from "../src/convert.js";

describe("convertMarkdown", () => {
  it("preserves supported formatting and all heading levels", () => {
    const result = convertMarkdown("#### Notes\n\nThis is **bold**, *italic*, and ~~old~~.");
    expect(result.messages).toEqual(["#### Notes\n\nThis is **bold**, *italic*, and ~~old~~."]);
  });

  it("keeps escaped Markdown literal in Discord", () => {
    expect(convertMarkdown("\\*literal\\* and foo_bar_baz").messages[0]).toBe("\\*literal\\* and foo\\_bar\\_baz");
  });

  it("preserves Discord spoiler syntax as an intentional extension", () => {
    expect(convertMarkdown("Keep ||this hidden|| please").messages[0]).toBe("Keep ||this hidden|| please");
  });

  it("keeps escaped block markers literal", () => {
    expect(convertMarkdown("\\> not a quote\n\\- not a list").messages[0]).toBe("\\> not a quote\n\\- not a list");
  });

  it("turns GFM tasks into readable symbols", () => {
    const result = convertMarkdown("- [x] Install\n- [ ] Configure");
    expect(result.messages[0]).toBe("- ☑ Install\n- ☐ Configure");
  });

  it("turns tables into fenced aligned text", () => {
    const result = convertMarkdown("| Plan | Price |\n|---|---:|\n| Pro | $20 |");
    expect(result.messages[0]).toContain("```text\nPlan | Price");
    expect(result.messages[0]).toContain("Pro  | $20");
    expect(result.warnings.map((warning) => warning.code)).toContain("lossy-table");
  });

  it("never truncates long table cell content", () => {
    const longCell = "important-".repeat(12);
    const result = convertMarkdown(`| Name | Value |\n|---|---|\n| Key | ${longCell} |`);
    expect(result.messages.join("\n")).toContain(longCell);
  });

  it("preserves single-dollar text without mistaking currency for math", () => {
    expect(convertMarkdown("It costs $20 and $30 today.").messages[0]).toBe("It costs $20 and $30 today.");
    expect(convertMarkdown("Use $x^2$ here.").messages[0]).toBe("Use $x^2$ here.");
  });

  it("degrades block LaTeX to readable code", () => {
    const block = convertMarkdown("$$\nx^2 + y^2\n$$");
    expect(block.messages[0]).toBe("```text\n$$\nx^2 + y^2\n$$\n```");
  });

  it("converts images to visible links", () => {
    expect(convertMarkdown("![Diagram](https://example.com/a.png)").messages[0])
      .toBe("[Image: Diagram](https://example.com/a.png)");
  });

  it("neutralizes active mentions by default", () => {
    const result = convertMarkdown("Hello @everyone and <@123456789012345678>");
    expect(result.messages[0]).toBe("Hello @\u200Beveryone and <@\u200B123456789012345678>");
    expect(result.warnings.map((warning) => warning.code)).toContain("mentions-neutralized");
  });

  it("does not alter inert mentions inside code", () => {
    const result = convertMarkdown("Outside @here.\n\n```text\n@everyone <@123>\n```");
    expect(result.messages[0]).toContain("Outside @\u200Bhere.");
    expect(result.messages[0]).toContain("```text\n@everyone <@123>\n```");
  });

  it("can preserve mentions explicitly", () => {
    expect(convertMarkdown("@here <@123>", { neutralizeMentions: false }).messages[0]).toBe("@here <@123>");
  });

  it("resolves reference links", () => {
    expect(convertMarkdown("Read [the docs][docs].\n\n[docs]: https://example.com/docs").messages[0])
      .toBe("Read [the docs](https://example.com/docs).");
  });

  it("uses the first duplicate reference definition and accepts an empty destination", () => {
    expect(convertMarkdown("[foo]\n\n[foo]: first\n[foo]: second").messages[0]).toBe("foo (first)");
    expect(convertMarkdown("[foo]: <>\n\n[foo]").messages[0]).toBe("foo ()");
  });

  it("preserves multiline heading semantics on every Discord line", () => {
    expect(convertMarkdown("Foo\nBar\n---").messages[0]).toBe("## Foo\n## Bar");
  });

  it("escapes the ordered-list delimiter rather than the first digit", () => {
    expect(convertMarkdown("1\\. not a list").messages[0]).toBe("1\\. not a list");
  });

  it("encodes Markdown delimiters inside clickable link destinations", () => {
    expect(convertMarkdown("<https://foo.bar.`baz>").messages[0]).toBe("[https://foo.bar.\\`baz](https://foo.bar.%60baz)");
  });

  it("retains CDATA character data and removes processing instructions", () => {
    expect(convertMarkdown("foo <![CDATA[>&<]]>").messages[0]).toBe("foo \\>&<");
    expect(convertMarkdown("<?php echo '>'; ?>\n\nokay").messages[0]).toBe("okay");
  });

  it("removes unsafe link targets", () => {
    const result = convertMarkdown("[Run this](javascript:alert(1))");
    expect(result.messages[0]).toBe("Run this [unsafe URL removed]");
    expect(result.warnings.map((warning) => warning.code)).toContain("unsafe-url");
  });

  it("makes relative links readable but non-clickable", () => {
    expect(convertMarkdown("[Guide](/docs/start)").messages[0]).toBe("Guide (/docs/start)");
  });
});

describe("splitDiscordMessages", () => {
  it("splits at block boundaries without losing the separator", () => {
    const source = "a".repeat(20) + "\n\n" + "b".repeat(20);
    const messages = splitDiscordMessages(source, 32);
    expect(messages).toHaveLength(2);
    expect(messages.join("")).toBe(source);
  });

  it("does not discard whitespace at hard split boundaries", () => {
    const source = "a ".repeat(100);
    const messages = splitDiscordMessages(source, 32);
    expect(messages.join("")).toBe(source);
    expect(messages.every((message) => Array.from(message).length <= 32)).toBe(true);
  });

  it("preserves blank-line separation between adjacent oversized blocks", () => {
    const source = `${"a".repeat(40)}\n\n${"b".repeat(40)}`;
    const messages = splitDiscordMessages(source, 32);
    expect(messages.join("")).toBe(source);
    expect(messages.every((message) => Array.from(message).length <= 32)).toBe(true);
  });

  it("closes and reopens oversized code fences", () => {
    const messages = splitDiscordMessages(`\`\`\`js\n${"x".repeat(80)}\n\`\`\``, 40);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.startsWith("```js\n") && message.endsWith("\n```"))).toBe(true);
    expect(messages.every((message) => Array.from(message).length <= 40)).toBe(true);
  });

  it("keeps blank lines inside fenced code while splitting", () => {
    const body = `${"a".repeat(40)}\n\n${"b".repeat(40)}`;
    const messages = splitDiscordMessages(`\`\`\`txt\n${body}\n\`\`\``, 40);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.startsWith("```txt\n") && message.endsWith("\n```"))).toBe(true);
    const recovered = messages.map((message) => message.slice(7, -4)).join("");
    expect(recovered).toBe(body);
  });

  it("closes and reopens formatting around oversized formatted blocks", () => {
    const result = convertMarkdown(`**${"word ".repeat(599)}word**`);
    expect(result.messages.length).toBeGreaterThan(1);
    expect(result.messages.every((message) => message.startsWith("**") && message.endsWith("**"))).toBe(true);
    expect(result.messages.every((message) => Array.from(message).length <= 2_000)).toBe(true);
  });

  it("handles code containing a backtick run near the message limit", () => {
    const result = convertMarkdown(`~~~txt\n${"`".repeat(80)}\n~~~`, { maxMessageLength: 32 });
    expect(result.messages.length).toBeGreaterThan(1);
    expect(result.messages.every((message) => Array.from(message).length <= 32)).toBe(true);
    expect(result.messages.every((message) => /^`{3,}txt\n/.test(message) && /\n`{3,}$/.test(message))).toBe(true);
  });

  it("rejects a limit too small for safe splitting", () => {
    expect(() => splitDiscordMessages("text", 0)).toThrow(RangeError);
  });

  it("does not split surrogate pairs", () => {
    const messages = splitDiscordMessages("😀".repeat(40), 32);
    expect(messages.join("")).toBe("😀".repeat(40));
    expect(messages.every((message) => Array.from(message).length <= 32)).toBe(true);
  });

  it("does not split combining marks or ZWJ emoji sequences", () => {
    const family = "👨‍👩‍👧‍👦";
    const combined = "e\u0301";
    const messages = splitDiscordMessages((family + combined).repeat(12), 32);
    expect(messages.join("")).toBe((family + combined).repeat(12));
    expect(messages.every((message) => !message.startsWith("\u200d") && !message.endsWith("\u200d") && !message.startsWith("\u0301"))).toBe(true);
    expect(messages.every((message) => Array.from(message).length <= 32)).toBe(true);
  });
});
