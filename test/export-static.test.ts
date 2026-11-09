import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountTokenEnvKey } from "../src/core/auth.ts";
import { parseEnv } from "../src/core/env.ts";
import { runExport, type Snapshot } from "../src/server/export.ts";
import { createAgents, appAssetPath, makeStore, tempDir } from "./helpers.ts";

const SNAPSHOT_RE =
  /<script type="application\/json" id="report-snapshot">([\s\S]*?)<\/script>/;

function makeUiFixture(): { dir: string; cleanup: () => void } {
  const dir = tempDir("report-ui-fixture-");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>report</title>
<script src="./assets/app.js" defer></script>
<link rel="stylesheet" href="./assets/style.css">
</head>
<body>
<div id="root"></div>
</body>
</html>
`,
  );
  writeFileSync(join(dir, "assets", "app.js"), "window.__REPORT_APP__ = true;\n");
  writeFileSync(join(dir, "assets", "style.css"), "body{margin:0}\n");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readSnapshot(html: string): Snapshot {
  const match = SNAPSHOT_RE.exec(html);
  if (!match) throw new Error("report-snapshot script not found");
  return JSON.parse(match[1]!) as Snapshot;
}

describe("static export (design §2/§5)", () => {
  test("writes the app shell with an inline snapshot, relative assets and media", () => {
    const t = makeStore();
    const ui = makeUiFixture();
    try {
      const mediaBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
      const media = t.store.saveMedia(mediaBytes, "png");
      const root = t.store.commitOps({
        author: "manager",
        batchId: "B1",
        ops: [{ op: "post", body: "归档正文 @owner", media: [media.hash], tags: ["result"] }],
      }).posts[0]!;
      t.store.commitOps({
        author: "owner",
        batchId: "B2",
        ops: [{ op: "reply", parent: root.id, body: "收到" }],
      });

      const outDir = join(t.dir, "archive");
      const result = runExport({ dataDir: t.dir, outDir, uiDir: ui.dir });
      expect(result.as_of_seq).toBe(t.store.maxEventSeq());
      expect(result.threads).toBe(1);
      expect(result.media).toBe(1);
      expect(result.pages).toBe(1);

      const index = readFileSync(join(outDir, "index.html"), "utf8");
      expect(index).toContain('id="report-snapshot"');
      expect(index).toContain('src="./assets/app.js"');
      expect(index).toContain('href="./assets/style.css"');
      expect(index).not.toContain('type="module"');
      expect(existsSync(join(outDir, "assets", "app.js"))).toBe(true);
      expect(existsSync(join(outDir, "assets", "style.css"))).toBe(true);
      expect(existsSync(join(outDir, "media", `${media.hash}.png`))).toBe(true);
      // hash routing: no per-post / search / who pages any more
      expect(existsSync(join(outDir, "p"))).toBe(false);
      expect(existsSync(join(outDir, "search.html"))).toBe(false);
      expect(existsSync(join(outDir, "who.html"))).toBe(false);

      const snapshot = readSnapshot(index);
      expect(snapshot.version).toBe(1);
      expect(snapshot.viewer).toBe("owner");
      expect(snapshot.as_of_seq).toBe(t.store.maxEventSeq());
      expect(snapshot.posts.map((post) => post.id)).toContain(root.id);
      expect(snapshot.posts.find((post) => post.id === root.id)!.tags).toEqual(["result"]);
      expect(snapshot.participants[root.root_id]).toContain("manager");
      expect(snapshot.follows).toContainEqual(["owner", "manager"]);
      expect(snapshot.media).toEqual([
        { hash: media.hash, ext: "png", bytes: mediaBytes.byteLength, url: `media/${media.hash}.png` },
      ]);
      expect(
        snapshot.posts.find((post) => post.id === root.id)!.media[0]!.url,
      ).toBe(`media/${media.hash}.png`);
    } finally {
      ui.cleanup();
      t.close();
    }
  });

  test("the snapshot never contains tokens, auth values or the data dir path", () => {
    const t = makeStore();
    const ui = makeUiFixture();
    try {
      writeFileSync(join(t.dir, ".env"), "STOA_AUTH=super-secret-auth-value\n", {
        mode: 0o600,
      });
      const ownerEnv = readFileSync(join(t.dir, "accounts", "owner.env"), "utf8");
      const token = parseEnv(ownerEnv)[accountTokenEnvKey("owner")]!;
      t.store.commitOps({
        author: "owner",
        batchId: "S1",
        ops: [{ op: "post", body: "should export without credentials" }],
      });

      const outDir = join(t.dir, "archive");
      runExport({ dataDir: t.dir, outDir, uiDir: ui.dir });
      const index = readFileSync(join(outDir, "index.html"), "utf8");
      const snapshot = readSnapshot(index);

      expect(index).not.toContain("super-secret-auth-value");
      expect(index).not.toContain(token);
      expect(index).not.toContain("STOA_AUTH");
      expect(index).not.toContain("FDE2E_REPORT_AUTH");
      expect(index).not.toContain("STOA_ACCOUNT_TOKEN");
      expect(index).not.toContain("FDE2E_REPORT_ACCOUNT_TOKEN");
      expect(index).not.toContain(t.dir);
      expect(JSON.stringify(snapshot)).not.toContain("authorization");
      expect(JSON.stringify(snapshot)).not.toContain("token");
      expect(JSON.stringify(snapshot)).not.toContain("http://");
    } finally {
      ui.cleanup();
      t.close();
    }
  });

  test("exports the viewer's visibility slice (agent sees only participated threads)", () => {
    const t = makeStore();
    const ui = makeUiFixture();
    try {
      createAgents(t.store, ["a", "b"]);
      const aRoot = t.store.commitOps({
        author: "a",
        batchId: "A1",
        ops: [{ op: "post", body: "a only thread" }],
      }).posts[0]!;
      t.store.commitOps({
        author: "b",
        batchId: "B1",
        ops: [{ op: "post", body: "b only thread" }],
      });

      const outDir = join(t.dir, "archive-a");
      runExport({ dataDir: t.dir, outDir, viewer: "a", uiDir: ui.dir });
      const snapshot = readSnapshot(readFileSync(join(outDir, "index.html"), "utf8"));

      expect(snapshot.viewer).toBe("a");
      expect(snapshot.posts.every((post) => post.root_id === aRoot.root_id)).toBe(true);
      expect(Object.keys(snapshot.participants)).toEqual([aRoot.root_id]);
      // members stay complete (the who page is populated from `accounts`)
      expect(snapshot.accounts.map((account) => account.id).sort()).toEqual([
        "a",
        "b",
        "manager",
        "owner",
      ]);

      expect(() =>
        runExport({ dataDir: t.dir, outDir: join(t.dir, "archive-x"), viewer: "ghost", uiDir: ui.dir }),
      ).toThrow(/not found/);
    } finally {
      ui.cleanup();
      t.close();
    }
  });

  test("fails clearly when the frontend build is missing", () => {
    const t = makeStore();
    const ui = makeUiFixture();
    try {
      expect(() =>
        runExport({ dataDir: t.dir, outDir: join(t.dir, "archive"), uiDir: join(ui.dir, "missing") }),
      ).toThrow(/bun run build/);
    } finally {
      ui.cleanup();
      t.close();
    }
  });

  const realDist = join(import.meta.dir, "..", "dist", "index.html");
  test.skipIf(!existsSync(realDist))(
    "the real dist build exports a file:// ready self-contained index.html",
    () => {
      const t = makeStore();
      try {
        t.store.commitOps({
          author: "manager",
          batchId: "R1",
          ops: [{ op: "post", body: "real build archive", tags: ["result"] }],
        });
        const outDir = join(t.dir, "archive");
        runExport({ dataDir: t.dir, outDir });
        const index = readFileSync(join(outDir, "index.html"), "utf8");
        expect(index).toContain('id="report-snapshot"');
        expect(index).toMatch(/\.\/assets\/app(-[\w-]+)?\.js/);
        expect(index).not.toContain('type="module"');
        expect(appAssetPath(outDir)).not.toBeNull();
        const snapshot = readSnapshot(index);
        expect(snapshot.posts.some((post) => post.body_md === "real build archive")).toBe(true);
      } finally {
        t.close();
      }
    },
  );
});

describe("static export · longform (report-longform A10/P1-18)", () => {
  test("article snapshot carries kind + raw markdown (blocks stay in body_md; no pre-rendered HTML)", () => {
    const t = makeStore();
    const ui = makeUiFixture();
    try {
      const articleBody =
        "# 长文报告\n\n正文段落。\n\n````fde2e:stats\n{ \"items\": [{ \"label\": \"断言\", \"value\": \"95/95\", \"hint\": \"PASS\" }] }\n````\n\n````fde2e:callout\n{ \"tone\": \"success\", \"body\": \"结论\" }\n````";
      const article = t.store.commitOps({
        author: "manager",
        batchId: "LB1",
        ops: [{ op: "post", body: articleBody, kind: "article", tags: ["result"] }],
      }).posts[0]!;
      const note = t.store.commitOps({
        author: "manager",
        batchId: "LB2",
        ops: [{ op: "post", body: "短帖" }],
      }).posts[0]!;
      t.store.commitOps({
        author: "owner",
        batchId: "LB3",
        ops: [{ op: "reply", parent: article.id, body: "讨论回复" }],
      });

      const outDir = join(t.dir, "archive-longform");
      runExport({ dataDir: t.dir, outDir, uiDir: ui.dir });
      const snapshot = readSnapshot(readFileSync(join(outDir, "index.html"), "utf8"));

      const exported = snapshot.posts.find((post) => post.id === article.id)!;
      expect(exported.kind).toBe("article");
      // 单一信源：块就在 body_md 的 fenced 内容里，快照不存预渲染 HTML / blocks 数组
      expect(exported.body_md).toBe(articleBody);
      expect("blocks" in exported).toBe(false);
      expect(JSON.stringify(exported)).not.toContain("<div");
      // 静态讨论区数据源：回复行随快照导出
      expect(snapshot.posts.some((post) => post.parent_id === article.id)).toBe(true);
      // 旧数据缺省 note
      expect(snapshot.posts.find((post) => post.id === note.id)!.kind).toBe("note");
      // 既有 read/read_at 透传不受影响
      expect(exported.read_at === undefined || exported.read_at === null || typeof exported.read_at === "number").toBe(true);
    } finally {
      ui.cleanup();
      t.close();
    }
  });
});
