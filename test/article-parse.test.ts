/**
 * report-longform P1-6：`src/core/article.ts` 解析器单测。
 *
 * 覆盖：指令块识别与降级（未知块/坏 JSON/schema 错/类型错/超限），P1 四块 schema
 * 边界（stats/steps/compare/callout），标题/摘要/阅读时长/slug（NFKC/CJK/去重），
 * 3/4 反引号 fence 与闭合长度、块起始行号，以及「任何输入不抛异常 + 512KB <50ms」。
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_DIRECTIVE_BLOCKS,
  articleBlockTemplate,
  articleHeadingIdList,
  articleSummary,
  parseArticle,
  slugifyHeading,
  type ArticleDoc,
} from "../src/core/article.ts";
import { parseMarkdown } from "../src/core/markdown.ts";

function fence(name: string, json: string, ticks = 4): string {
  const bar = "`".repeat(ticks);
  return `${bar}fde2e:${name}\n${json}\n${bar}`;
}

function markdownDoc(...parts: string[]): string {
  return parts.join("\n\n");
}

/** 便捷：取第 index（0-based）个 directive 节点。 */
function directive(doc: ArticleDoc, index = 0) {
  const nodes = doc.nodes.filter((node) => node.kind === "directive");
  const node = nodes[index];
  if (!node || node.kind !== "directive") throw new Error(`no directive #${index}`);
  return node;
}

describe("article fence 识别（fde2e:<name>）", () => {
  test("普通 ```js / ```json / ```text 代码块行为不变", () => {
    const doc = parseArticle(markdownDoc("```js\nconsole.log(1)\n```", "```json\n{\"a\":1}\n```", "```text\nhi\n```"));
    expect(doc.nodes).toHaveLength(3);
    for (const node of doc.nodes) expect(node.kind).toBe("markdown");
    expect(doc.stats.directives).toBe(0);
    expect(doc.issues).toHaveLength(0);
  });

  test("info string 精确匹配才升级：`fde2e:statsx` 不是指令（合法名但未知→降级），`fde2e:` 空名不是指令", () => {
    const unknown = parseArticle(fence("statsx", `{ "items": [{ "label": "a", "value": "1" }] }`));
    expect(directive(unknown).name).toBe("statsx");
    expect(directive(unknown).data).toBeNull();
    expect(directive(unknown).issues.some((issue) => issue.severity === "warning")).toBe(true);

    // `fde2e:`（空名）不匹配命名空间 → 普通代码块
    const plain = parseArticle("```fde2e:\n{}\n```");
    expect(plain.nodes[0]!.kind).toBe("markdown");
    expect(plain.stats.directives).toBe(0);
  });

  test("3/4 反引号 fence 与闭合长度：4 反引号块可包含 3 反引号示例；闭合 run 必须 ≥ 开启 run", () => {
    const inner = markdownDoc(
      "# T",
      fence("callout", '{ "body": "包含示例", "code": "```js\\nx\\n```" }', 4),
    );
    const doc = parseArticle(inner);
    expect(directive(doc).data).not.toBeNull();

    // 4 反引号未正确闭合（被 3 反引号行提前当作闭合？）——闭合 run < 开启 run 不算闭合：
    const tricky = "````fde2e:callout\n{ \"body\": \"x\" }\n```\nstill inside\n````";
    const blocks = parseMarkdown(tricky);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("code");
    if (blocks[0]!.type === "code") expect(blocks[0]!.text).toContain("still inside");
  });

  test("带前导空格的 fence 不是指令块（按现有 markdown 规则为段落）", () => {
    const doc = parseArticle("  ```fde2e:stats\n  {}\n  ```");
    expect(doc.stats.directives).toBe(0);
  });

  test("块起始行号（1-based）与块序号", () => {
    const src = markdownDoc("# T", "para", fence("stats", `{ "items": [{ "label": "a", "value": "1" }] }`));
    const doc = parseArticle(src);
    // 行：1 `# T`、2 空、3 para、4 空、5 `````fde2e:stats`
    expect(directive(doc).line).toBe(5);
    expect(directive(doc).issues[0]?.block ?? 1).toBe(1);
  });
});

describe("stats 块", () => {
  const statsOf = (json: unknown) => parseArticle(fence("stats", JSON.stringify(json)));

  test("1..8 项；value 与 before/after 双形态；tone/better 归一", () => {
    const doc = statsOf({
      items: [
        { label: "断言", value: "95/95", hint: "PASS", tone: "success" },
        { label: "耗时", before: "1820", after: "940", unit: "ms", better: "lower" },
      ],
    });
    const data = directive(doc).data;
    expect(data?.name).toBe("stats");
    if (data?.name !== "stats") throw new Error("wrong block");
    expect(data.items[0]).toMatchObject({ label: "断言", value: "95/95", tone: "success", better: null });
    expect(data.items[1]).toMatchObject({ before: "1820", after: "940", unit: "ms", better: "lower" });
    expect(directive(doc).issues).toHaveLength(0);
  });

  test("0 项 / >8 项 / 缺 value 与 before+after / 超长截断", () => {
    expect(directive(statsOf({ items: [] })).data).toBeNull();
    const many = statsOf({
      items: Array.from({ length: 10 }, (_, i) => ({ label: `l${i}`, value: String(i) })),
    });
    expect(directive(many).issues.some((i) => /truncated to 8/.test(i.message))).toBe(true);

    const missing = statsOf({ items: [{ label: "a" }] });
    expect(directive(missing).data).toBeNull();
    expect(directive(missing).issues.some((i) => i.severity === "error")).toBe(true);

    const long = statsOf({
      items: [
        {
          label: "x".repeat(41),
          value: "y".repeat(33),
          unit: "u".repeat(13),
          hint: "h".repeat(81),
        },
      ],
    });
    const items = directive(long).data;
    if (items?.name !== "stats") throw new Error("wrong block");
    expect(items.items[0]!.label).toHaveLength(40);
    expect(items.items[0]!.value).toHaveLength(32);
    expect(directive(long).issues.filter((i) => i.severity === "warning").length).toBeGreaterThanOrEqual(3);
  });

  test("未知 tone → neutral + warning（不阻止渲染）", () => {
    const doc = statsOf({ items: [{ label: "a", value: "1", tone: "purple" }] });
    const data = directive(doc).data;
    if (data?.name !== "stats") throw new Error("wrong block");
    expect(data.items[0]!.tone).toBe("neutral");
    expect(directive(doc).issues.some((i) => /unknown tone/.test(i.message))).toBe(true);
  });

  test("类型不符（value 为数字）→ error 且该块降级", () => {
    const doc = statsOf({ items: [{ label: "a", value: 1 }] });
    expect(directive(doc).data).toBeNull();
    expect(directive(doc).issues.some((i) => i.severity === "error")).toBe(true);
  });
});

describe("steps 块", () => {
  const stepsOf = (json: unknown) => parseArticle(fence("steps", JSON.stringify(json)));

  test("1..20 项、五态 status、expect/detail/command/output/media", () => {
    const doc = stepsOf({
      steps: [
        { title: "构建", status: "done", expect: "**通过**", detail: "断言 ok", command: "bun build", output: "ok" },
        { title: "降级步骤", status: "degraded" },
        { title: "跳过", status: "skipped" },
        { title: "失败", status: "failed" },
        { title: "默认" },
      ],
    });
    const data = directive(doc).data;
    if (data?.name !== "steps") throw new Error("wrong block");
    expect(data.steps.map((s) => s.status)).toEqual(["done", "degraded", "skipped", "failed", "pending"]);
    expect(data.steps[0]).toMatchObject({ command: "bun build", output: "ok", expect: "**通过**" });
    expect(directive(doc).issues).toHaveLength(0);
  });

  test("title 必填；未知 status → pending + warning；>20 截断", () => {
    const noTitle = stepsOf({ steps: [{ status: "done" }] });
    expect(directive(noTitle).data).toBeNull();

    const unknownStatus = stepsOf({ steps: [{ title: "a", status: "running" }] });
    const data = directive(unknownStatus).data;
    if (data?.name !== "steps") throw new Error("wrong block");
    expect(data.steps[0]!.status).toBe("pending");
    expect(directive(unknownStatus).issues.some((i) => /unknown status/.test(i.message))).toBe(true);

    const many = stepsOf({ steps: Array.from({ length: 22 }, (_, i) => ({ title: `s${i}` })) });
    expect(directive(many).issues.some((i) => /truncated to 20/.test(i.message))).toBe(true);
  });

  test("expect/detail/command/output 超限截断并记 warning；media 只收本地 /api/media/<hash>", () => {
    const doc = stepsOf({
      steps: [
        {
          title: "x".repeat(121),
          expect: "e".repeat(1001),
          detail: "d".repeat(2001),
          command: "c".repeat(4 * 1024 + 1),
          output: "o".repeat(8 * 1024 + 1),
          media: "/api/media/" + "a".repeat(64),
          mediaAlt: "alt",
        },
      ],
    });
    const data = directive(doc).data;
    if (data?.name !== "steps") throw new Error("wrong block");
    expect(data.steps[0]!.title).toHaveLength(120);
    expect(data.steps[0]!.expect).toHaveLength(1000);
    expect(data.steps[0]!.detail).toHaveLength(2000);
    expect(data.steps[0]!.command).toHaveLength(4 * 1024);
    expect(data.steps[0]!.output).toHaveLength(8 * 1024);
    expect(data.steps[0]!.media).toBe("/api/media/" + "a".repeat(64));
    expect(directive(doc).issues.filter((i) => i.severity === "warning").length).toBeGreaterThanOrEqual(5);

    // 外链 media → error（该步的 media 被丢弃；编辑器据此禁止提交）——
    // 块本身仍降级渲染其余字段，不整块丢弃（design §3.4「不静默丢内容」）。
    const remote = stepsOf({ steps: [{ title: "a", media: "https://example.com/a.png" }] });
    const remoteData = directive(remote).data;
    if (remoteData?.name !== "steps") throw new Error("wrong block");
    expect(remoteData.steps[0]!.media).toBeUndefined();
    expect(directive(remote).issues.some((i) => i.severity === "error")).toBe(true);
  });
});

describe("compare 块", () => {
  const compareOf = (json: unknown) => parseArticle(fence("compare", JSON.stringify(json)));
  const side = (over: Record<string, unknown> = {}) => ({
    media: "/api/media/" + "b".repeat(64),
    label: "Before",
    viewport: "1280x800",
    ...over,
  });

  test("before/after 必填；label/caption/title/note/viewport 上限", () => {
    expect(directive(compareOf({ before: side() })).data).toBeNull();
    expect(directive(compareOf({ after: side() })).data).toBeNull();

    const doc = compareOf({
      before: side({ caption: "c".repeat(201), viewport: "v".repeat(41) }),
      after: side(),
      title: "t".repeat(121),
      note: "n".repeat(301),
    });
    const data = directive(doc).data;
    if (data?.name !== "compare") throw new Error("wrong block");
    expect(data.title).toHaveLength(120);
    expect(data.note).toHaveLength(300);
    expect(data.before.caption).toHaveLength(200);
    expect(data.before.viewport).toHaveLength(40);
  });

  test("两侧 viewport 不一致 → warning；media 非本地 → error", () => {
    const mismatch = compareOf({ before: side({ viewport: "1280x800" }), after: side({ viewport: "390x844" }) });
    expect(directive(mismatch).data).not.toBeNull();
    expect(directive(mismatch).issues.some((i) => /viewport/.test(i.message) && i.severity === "warning")).toBe(true);

    const bad = compareOf({ before: side({ media: "media/x.png" }), after: side() });
    const badData = directive(bad).data;
    if (badData?.name !== "compare") throw new Error("wrong block");
    expect(badData.before.media).toBe("");
    expect(directive(bad).issues.some((i) => i.severity === "error")).toBe(true);
  });
});

describe("callout 块", () => {
  const calloutOf = (json: unknown) => parseArticle(fence("callout", JSON.stringify(json)));

  test("tone/body/items/code；未知 tone → info + warning；空块 → error", () => {
    const doc = calloutOf({ tone: "success", title: "结论", body: "**ok**", items: ["a", "b"], code: "x" });
    const data = directive(doc).data;
    if (data?.name !== "callout") throw new Error("wrong block");
    expect(data).toMatchObject({ tone: "success", title: "结论", body: "**ok**", items: ["a", "b"], code: "x" });

    const unknownTone = calloutOf({ tone: "purple", body: "x" });
    const unknownData = directive(unknownTone).data;
    if (unknownData?.name !== "callout") throw new Error("wrong block");
    expect(unknownData.tone).toBe("info");
    expect(directive(unknownTone).issues.some((i) => /unknown tone/.test(i.message))).toBe(true);

    expect(directive(calloutOf({})).data).toBeNull();
  });

  test("body 2000 / items 0..8×300 / code 4KiB 截断", () => {
    const doc = calloutOf({
      body: "b".repeat(2001),
      items: ["i".repeat(301), ...Array.from({ length: 9 }, (_, i) => `x${i}`)],
      code: "c".repeat(4 * 1024 + 1),
    });
    const data = directive(doc).data;
    if (data?.name !== "callout") throw new Error("wrong block");
    expect(data.body).toHaveLength(2000);
    expect(data.items).toHaveLength(8);
    expect(data.items[0]).toHaveLength(300);
    expect(data.code).toHaveLength(4 * 1024);
  });
});

describe("降级与安全", () => {
  test("未知块：data=null + warning + 原文与行号保留", () => {
    const raw = `{ "hello": "world" }`;
    const doc = parseArticle(markdownDoc("# T", fence("unknown", raw)));
    const node = directive(doc);
    expect(node.name).toBe("unknown");
    expect(node.data).toBeNull();
    expect(node.raw).toBe(raw);
    expect(node.line).toBe(3);
    expect(node.issues.some((i) => /unsupported directive block/.test(i.message))).toBe(true);
  });

  test("坏 JSON → error；数组/标量 → error", () => {
    const badJson = parseArticle(fence("stats", '{ "items": }'));
    expect(directive(badJson).data).toBeNull();
    expect(directive(badJson).issues[0]?.severity).toBe("error");
    expect(directive(badJson).issues[0]?.message).toMatch(/not valid JSON/);

    // 非 `{...}` 形体（不闭合/数组/标量）→ 「必须是单个 JSON 对象」
    const truncated = parseArticle(fence("stats", "{ not json"));
    expect(directive(truncated).data).toBeNull();
    expect(directive(truncated).issues[0]?.message).toMatch(/single JSON object/);

    const arrayBody = parseArticle(fence("stats", "[1,2,3]"));
    expect(directive(arrayBody).data).toBeNull();
    expect(directive(arrayBody).issues[0]?.message).toMatch(/single JSON object/);
  });

  test("块数 >200 与单块 >16KiB：降级 + warning，不静默丢内容", () => {
    const many = Array.from({ length: 201 }, () => fence("callout", `{ "body": "x" }`, 3)).join("\n\n");
    const doc = parseArticle(many);
    expect(doc.stats.directives).toBe(201);
    expect(doc.issues.some((i) => new RegExp(`too many directive blocks \\(max ${MAX_DIRECTIVE_BLOCKS}\\)`).test(i.message))).toBe(true);

    const huge = parseArticle(fence("callout", `{ "body": "${"x".repeat(17 * 1024)}" }`));
    expect(directive(huge).data).toBeNull();
    expect(directive(huge).issues.some((i) => /exceeds 16384 bytes/.test(i.message))).toBe(true);
  });

  test("任何输入不抛异常（含空串/随机字节/半截 fence）", () => {
    const inputs = ["", "```", "````fde2e:", "```fde2e:stats", "\u0000\u0001", "#".repeat(500), "[]{}()<>", "```fde2e:stats\n{\"items\":null}\n```"];
    for (const input of inputs) {
      expect(() => parseArticle(input)).not.toThrow();
    }
  });
});

describe("标题 / 摘要 / slug / 阅读时长", () => {
  test("首个非空 block 是 H1 时用其标题并从正文跳过索引计算", () => {
    const doc = parseArticle(markdownDoc("# 主标题", "第一段摘要内容。", "## 章节"));
    expect(doc.stats.title).toBe("主标题");
    expect(doc.stats.excerpt).toBe("第一段摘要内容。");
  });

  test("首个 block 非 H1：不抢标题（取首段前 60 字）", () => {
    const doc = parseArticle(markdownDoc("开篇段落就是标题来源。", "# 后面的 H1 不当标题"));
    expect(doc.stats.title).toBe("开篇段落就是标题来源。");
  });

  test("无 H1 无段落 → 回退「长文」；H1 会被截断到 60 字", () => {
    const empty = parseArticle(fence("callout", `{ "body": "x" }`));
    expect(empty.stats.title).toBe("长文");
    const long = parseArticle(`# ${"标题".repeat(40)}`);
    expect(Array.from(long.stats.title).length).toBeLessThanOrEqual(61); // 60 + 省略号
  });

  test("slug：NFKC、CJK、去重 -2/-3、空串 section；H2/H3 入 TOC（H1 不入）", () => {
    expect(slugifyHeading("Hello World")).toBe("hello-world");
    expect(slugifyHeading("中文 标题！")).toBe("中文-标题");
    expect(slugifyHeading("!!!")).toBe("section");
    const doc = parseArticle(markdownDoc("# H1", "## x", "## x", "### x", "## 中文"));
    expect(doc.headings.map((h) => h.id)).toEqual(["x", "x-2", "x-3", "中文"]);
    expect(doc.headings.map((h) => h.index)).toEqual([1, 2, 3, 4]);
    const ids = articleHeadingIdList(doc);
    expect(ids[0]).toBeNull(); // H1 不分配锚点
    expect(ids[1]).toBe("x");
  });

  test("阅读时长：chars 不含指令块 JSON；minutes = clamp(ceil(chars/400), 1, 99)", () => {
    const small = parseArticle("短");
    expect(small.stats.minutes).toBe(1);
    const big = parseArticle("字".repeat(4000));
    expect(big.stats.minutes).toBe(10);
    const withBlocks = parseArticle(markdownDoc("x".repeat(400), fence("callout", `{ "body": "${"y".repeat(2000)}" }`)));
    expect(withBlocks.stats.chars).toBe(400);
    expect(articleSummary("字".repeat(1200)).minutes).toBe(3);
  });

  test("块模板插入后可直接解析（编辑器「插入区块」契约）", () => {
    for (const name of ["stats", "steps", "compare", "callout"] as const) {
      const template = articleBlockTemplate(name);
      const doc = parseArticle(markdownDoc("# T", template));
      // compare 模板带占位 media（全 0 哈希），仍应通过 schema。
      expect(doc.stats.directives).toBe(1);
      expect(directive(doc).issues.filter((i) => i.severity === "error")).toHaveLength(0);
    }
  });
});

describe("性能预算", () => {
  test("512KB（多块混合）解析 <50ms", () => {
    const paragraph = `${"正文内容 ".repeat(40)}\n\n`;
    const body = `${"# 大文档\n\n"}${paragraph.repeat(2000)}${fence("steps", JSON.stringify({ steps: Array.from({ length: 20 }, (_, i) => ({ title: `步骤 ${i}`, command: "bun test", output: "ok" })) }))}`;
    expect(body.length).toBeGreaterThan(100_000);
    const started = performance.now();
    const doc = parseArticle(body);
    const elapsed = performance.now() - started;
    expect(doc.stats.directives).toBe(1);
    expect(elapsed).toBeLessThan(50);
  });
});
