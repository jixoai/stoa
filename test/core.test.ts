import { describe, expect, test } from "bun:test";
import { parseMarkdown, renderMarkdownHtml } from "../src/core/markdown.ts";
import { extractMentions } from "../src/core/mentions.ts";
import { parseEnv } from "../src/core/env.ts";
import { newUlid } from "../src/core/ids.ts";
import { parseBatchLine, validateWriteOp } from "../src/core/validation.ts";
import { ReportError } from "../src/core/errors.ts";
import { parseTime } from "../src/core/pagination.ts";

describe("markdown subset (P1.9)", () => {
  test("parses headings, lists, tables, quotes, code and links", () => {
    const md = `# Title

Paragraph with **bold**, *em*, \`code\` and [link](https://example.com).

- one
- two

1. first
2. second

> quoted text

| a | b |
| --- | --- |
| 1 | 2 |

\`\`\`ts
const x = 1 < 2;
\`\`\`
`;
    const blocks = parseMarkdown(md);
    const types = blocks.map((b) => b.type);
    expect(types).toContain("heading");
    expect(types).toContain("list");
    expect(types).toContain("quote");
    expect(types).toContain("table");
    expect(types).toContain("code");
    const html = renderMarkdownHtml(md);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<table>");
    // code content is escaped
    expect(html).toContain("const x = 1 &lt; 2;");
  });

  test("rejects javascript: links", () => {
    const html = renderMarkdownHtml("[x](javascript:alert(1))");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("javascript:alert(1)"); // rendered as inert text
  });
});

describe("mentions", () => {
  test("extracts deduped ids, ignores emails and code", () => {
    const ids = extractMentions("hi @a and @b, @a again, mail x@y.com\n```\n@inside\n```\n`@inline`");
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("env files (layered override)", () => {
  test("parses quotes/exports/comments", () => {
    const values = parseEnv(`# c\nexport A=1\nB="two words"\nC='three'\nD=\n`);
    expect(values).toEqual({ A: "1", B: "two words", C: "three", D: "" });
  });
});

describe("batch line parsing", () => {
  test("commit marker vs op vs malformed", () => {
    expect(parseBatchLine('{"commit":true}').kind).toBe("commit");
    expect(parseBatchLine('{"op":"post","body":"x"}').kind).toBe("op");
    expect(() => parseBatchLine("not json")).toThrow(ReportError);
    expect(() => parseBatchLine('{"op":"reply","parent":"p","body":""}')).toThrow(ReportError);
    expect(() =>
      validateWriteOp({ op: "post", body: "x", media: ["nope"] }),
    ).toThrow(ReportError);
  });
});

describe("ids and time", () => {
  test("ULIDs are monotonic even within one millisecond", () => {
    const ids = Array.from({ length: 50 }, () => newUlid(1_700_000_000_000));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("parseTime accepts epoch, ISO and relative offsets", () => {
    expect(parseTime("1700000000000")).toBe(1_700_000_000_000);
    expect(parseTime("1700000000")).toBe(1_700_000_000_000);
    expect(parseTime("2026-01-01T00:00:00Z")).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(parseTime("2h", 10_000_000)).toBe(10_000_000 - 2 * 3_600_000);
    expect(() => parseTime("yesterday-ish")).toThrow(ReportError);
  });
});
