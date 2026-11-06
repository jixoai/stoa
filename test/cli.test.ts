import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUN,
  CLI,
  initWorkspace,
  parseJsonLines,
  runCli,
  startTestServer,
  type RunningTestServer,
  type TestWorkspace,
} from "./helpers.ts";

let ws: TestWorkspace;
let server: RunningTestServer;

const base = () => ["--data-dir", ws.dataDir];

async function createAccount(id: string): Promise<void> {
  const res = await runCli(["accounts", "create", id, ...base(), "--as", "manager"]);
  expect(res.code).toBe(0);
}

async function draftsFor(account: string): Promise<Array<{ id: string; items: unknown[] }>> {
  const res = await fetch(`${server.url}/api/drafts`, {
    headers: { "x-report-account": account },
  });
  const body = (await res.json()) as { drafts: Array<{ id: string; items: unknown[] }> };
  return body.drafts;
}

async function cursorFor(account: string): Promise<number> {
  const res = await fetch(`${server.url}/api/cursor`, {
    headers: { "x-report-account": account },
  });
  const body = (await res.json()) as { cursor: number };
  return body.cursor;
}

async function peekFor(account: string): Promise<Array<{ seq: number; type: string }>> {
  const res = await fetch(`${server.url}/api/notifications?peek=1`, {
    headers: { "x-report-account": account },
  });
  const body = (await res.json()) as { events: Array<{ seq: number; type: string }> };
  return body.events;
}

beforeAll(async () => {
  ws = initWorkspace({ open: true });
  server = await startTestServer({ workspace: ws });
  await createAccount("a");
  await createAccount("b");
  await createAccount("c");
});

afterAll(async () => {
  await server.stop();
  ws.cleanup();
});

describe("CLI surface (design §15, P3)", () => {
  test("version and capabilities", async () => {
    const version = await runCli(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const caps = await runCli(["capabilities", ...base()]);
    expect(caps.code).toBe(0);
    const parsed = JSON.parse(caps.stdout) as { product: string; protocol: number };
    expect(parsed.product).toBe("fde2e-report-worker");
    expect(parsed.protocol).toBe(1);
    // --data-dir is required except for --version.
    // Run in an isolated cwd: a .report-pointer left by a previous init in the
    // repo root would otherwise satisfy the lookup and make this assertion
    // environment-dependent.
    const bare = mkdtempSync(join(tmpdir(), "report-nocwd-"));
    try {
      const missing = await runCli(["capabilities"], {
        cwd: bare,
        env: { FDE2E_REPORT_DATA_DIR: undefined },
      });
      expect(missing.code).not.toBe(0);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }, 30000);

  test("batch: one transaction can build a whole self-thread via $prev / $ref", async () => {
    const jsonl = [
      JSON.stringify({ op: "post", ref: "r", body: "report part 1/3 @b" }),
      JSON.stringify({ op: "reply", parent: "$prev", body: "part 2/3" }),
      JSON.stringify({ op: "reply", parent: "$prev", body: "part 3/3" }),
      JSON.stringify({ commit: true }),
    ].join("\n") + "\n";
    const run = await runCli(["post", "--batch", ...base(), "--as", "a"], { stdin: jsonl });
    expect(run.code).toBe(0);
    const res = JSON.parse(run.stdout) as {
      posts: Array<{ id: string; parent_id: string | null; self_thread_id: string }>;
    };
    expect(res.posts).toHaveLength(3);
    const [root, second, third] = res.posts;
    expect(second!.parent_id).toBe(root!.id);
    expect(third!.parent_id).toBe(second!.id);
    expect(new Set(res.posts.map((p) => p.self_thread_id))).toEqual(new Set([root!.id]));

    // one wake delivers the whole committed batch as a single chain
    const waited = await runCli(["wait-notifications", ...base(), "--as", "b"], { timeoutMs: 30_000 });
    expect(waited.code).toBe(0);
    const created = parseJsonLines(waited.stdout).filter((l) => l.type === "post.created");
    expect(created).toHaveLength(3);
    expect(new Set(created.map((l) => l.batch_id)).size).toBe(1);

    const thread = await runCli(["read", "--thread", root!.id, ...base(), "--as", "a"]);
    const body = JSON.parse(thread.stdout) as {
      thread: { spine_complete: boolean; posts: Array<{ i?: number; n?: number; is_spine: boolean }> };
    };
    const spine = body.thread.posts.filter((p) => p.is_spine);
    expect(spine.map((p) => p.i)).toEqual([1, 2, 3]);
    expect(spine.map((p) => p.n)).toEqual([3, 3, 3]);
  }, 60000);

  test("a rejected batch discards its draft and does not block the next batch", async () => {
    const bad = [
      JSON.stringify({ op: "post", body: "first ok" }),
      JSON.stringify({ op: "reply", parent: "__missing__", body: "nope" }),
      JSON.stringify({ commit: true }),
    ].join("\n") + "\n";
    const rejected = await runCli(["post", "--batch", ...base(), "--as", "a"], { stdin: bad });
    expect(rejected.code).not.toBe(0);

    const drafts = await runCli(["draft", "ls", ...base(), "--as", "a"]);
    expect(drafts.code).toBe(0);
    const listed = JSON.parse(drafts.stdout) as { drafts: unknown[] };
    expect(listed.drafts).toHaveLength(0);

    const retry = await runCli(["post", "after rejection", ...base(), "--as", "a"]);
    expect(retry.code).toBe(0);
  }, 60000);

  test("end-to-end: post → wait-notifications → reply → read --thread → export", async () => {
    const posted = await runCli([
      "post",
      "hello @b from a",
      ...base(),
      "--as",
      "a",
    ]);
    expect(posted.code).toBe(0);
    const postResult = JSON.parse(posted.stdout) as { posts: Array<{ id: string; root_id: string }> };
    const rootId = postResult.posts[0]!.id;

    const waited = await runCli(["wait-notifications", ...base(), "--as", "b"], {
      timeoutMs: 30_000,
    });
    expect(waited.code).toBe(0);
    const lines = parseJsonLines(waited.stdout);
    expect(lines.map((l) => l.type)).toContain("post.created");
    expect(lines.map((l) => l.type)).toContain("thread.invited");
    expect(lines.map((l) => l.type)).toContain("thread.snapshot");
    // stdout is JSONL only
    expect(waited.stdout.trim().split("\n").every((line) => line.startsWith("{"))).toBe(true);

    const replied = await runCli(["reply", rootId, "b received", ...base(), "--as", "b"]);
    expect(replied.code).toBe(0);

    const thread = await runCli(["read", "--thread", rootId, ...base(), "--as", "a"]);
    expect(thread.code).toBe(0);
    const threadBody = JSON.parse(thread.stdout) as {
      thread: { posts: Array<{ id: string; author: string; depth: number }> };
    };
    expect(threadBody.thread.posts.map((p) => p.author)).toEqual(["a", "b"]);
    expect(threadBody.thread.posts[1]!.depth).toBe(1);

    const exported = await runCli(["export", ...base()]);
    expect(exported.code).toBe(0);
    const exportBody = JSON.parse(exported.stdout) as { out_dir: string; threads: number };
    expect(exportBody.threads).toBeGreaterThanOrEqual(1);
    expect(await Bun.file(join(ws.dataDir, "export", "index.html")).exists()).toBe(true);
    expect(await Bun.file(join(ws.dataDir, "export", "assets", "app.js")).exists()).toBe(true);
    const archive = await Bun.file(join(ws.dataDir, "export", "index.html")).text();
    expect(archive).toContain('id="report-snapshot"');
    expect(archive).toContain(rootId);
  }, 60000);

  test("bare EOF fails, keeps the draft, then --draft resumes and commits", async () => {
    await createAccount("batch-eof");
    const bare = await runCli(
      ["post", "--batch", ...base(), "--as", "batch-eof"],
      {
        stdin: '{"op":"post","body":"line one"}\n{"op":"post","body":"line two"}\n',
      },
    );
    expect(bare.code).not.toBe(0);
    expect(bare.stdout).toBe("");
    const error = JSON.parse(bare.stderr) as { error: string; draft_id: string; items: number };
    expect(error.error).toContain("bare EOF");
    expect(error.items).toBe(2);
    const drafts = await draftsFor("batch-eof");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.items).toHaveLength(2);

    const resumed = await runCli(
      ["post", "--batch", "--draft", error.draft_id, ...base(), "--as", "batch-eof"],
      { stdin: '{"op":"post","body":"line three"}\n{"commit":true}\n' },
    );
    expect(resumed.code).toBe(0);
    const result = JSON.parse(resumed.stdout) as { posts: Array<{ id: string }> };
    expect(result.posts).toHaveLength(3);
    expect(await draftsFor("batch-eof")).toHaveLength(0);

    // replaying the commit is idempotent
    const replay = await runCli(["draft", "commit", error.draft_id, ...base(), "--as", "batch-eof"]);
    expect(replay.code).toBe(0);
    expect((JSON.parse(replay.stdout) as { idempotent: boolean }).idempotent).toBe(true);
  }, 60000);

  test("SIGKILL mid-batch leaves a resumable draft (per-line durability)", async () => {
    await createAccount("batch-kill");
    const proc = Bun.spawn({
      cmd: [BUN, CLI, "post", "--batch", ...base(), "--as", "batch-kill"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: ws.cwd,
    });
    proc.stdin.write('{"op":"post","body":"survives SIGKILL"}\n');
    await proc.stdin.flush();
    const deadline = Date.now() + 10_000;
    let draftId: string | null = null;
    while (Date.now() < deadline) {
      const drafts = await draftsFor("batch-kill");
      if (drafts.length === 1 && drafts[0]!.items.length === 1) {
        draftId = drafts[0]!.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(draftId).not.toBeNull();
    proc.kill(9);
    await proc.exited;
    const afterKill = await draftsFor("batch-kill");
    expect(afterKill).toHaveLength(1);
    expect(afterKill[0]!.items).toHaveLength(1);

    const committed = await runCli(
      ["post", "--batch", "--draft", draftId!, ...base(), "--as", "batch-kill"],
      { stdin: '{"commit":true}\n' },
    );
    expect(committed.code).toBe(0);
    const result = JSON.parse(committed.stdout) as { posts: Array<{ id: string }> };
    expect(result.posts).toHaveLength(1);
    const read = await runCli(["read", "--thread", result.posts[0]!.id, ...base(), "--as", "batch-kill"]);
    expect(read.stdout).toContain("survives SIGKILL");
  }, 60000);

  test("EPIPE on stdout does not advance the cursor", async () => {
    await createAccount("epipe");
    const cursorBefore = await cursorFor("epipe");
    await runCli(["post", "for @epipe", ...base(), "--as", "a"]);
    expect((await peekFor("epipe")).length).toBeGreaterThan(0);
    expect(await cursorFor("epipe")).toBe(cursorBefore);

    const script = `set -o pipefail; exec ${JSON.stringify(BUN)} ${JSON.stringify(CLI)} wait-notifications ${base()
      .map((a) => JSON.stringify(a))
      .join(" ")} --as epipe | head -c 0`;
    const proc = Bun.spawn({ cmd: ["bash", "-c", script], stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    expect(code).not.toBe(0);
    // cursor untouched, events still deliverable
    expect(await cursorFor("epipe")).toBe(cursorBefore);
    expect((await peekFor("epipe")).length).toBeGreaterThan(0);
  }, 60000);

  test("draft show/resume/discard and accounts rotate/rm", async () => {
    await createAccount("draft-dead");
    const created = await runCli(["draft", "ls", ...base(), "--as", "draft-dead"]);
    expect(created.code).toBe(0);
    const bare = await runCli(["post", "--batch", ...base(), "--as", "draft-dead"], {
      stdin: '{"op":"post","body":"discard me"}\n',
    });
    expect(bare.code).not.toBe(0);
    const draftId = (JSON.parse(bare.stderr) as { draft_id: string }).draft_id;
    const show = await runCli(["draft", "show", draftId, ...base(), "--as", "draft-dead"]);
    expect(show.code).toBe(0);
    const resume = await runCli(["draft", "resume", draftId, ...base(), "--as", "draft-dead"]);
    expect(resume.code).toBe(0);
    expect((JSON.parse(resume.stdout) as { resume_command: string }).resume_command).toContain(draftId);
    const discard = await runCli(["draft", "discard", draftId, ...base(), "--as", "draft-dead"]);
    expect(discard.code).toBe(0);
    expect((await draftsFor("draft-dead")).length).toBe(0);

    const createdAcc = await runCli(["accounts", "create", "doomed", ...base(), "--as", "manager"]);
    expect(createdAcc.code).toBe(0);
    const rotated = await runCli(["accounts", "rotate", "doomed", ...base(), "--as", "manager"]);
    expect(rotated.code).toBe(0);
    const removed = await runCli(["accounts", "rm", "doomed", ...base(), "--as", "manager"]);
    expect(removed.code).toBe(0);
    const recreate = await runCli(["accounts", "create", "doomed", ...base(), "--as", "manager"]);
    expect(recreate.code).not.toBe(0);
    expect(recreate.stderr).toContain("tombstone");
  }, 60000);

  test("--as is mandatory (no implicit default) for write commands", async () => {
    const res = await runCli(["post", "no as", ...base()]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("--as");
  }, 30000);

  test("status and auth status are machine-readable", async () => {
    const status = await runCli(["status", ...base()]);
    expect(status.code).toBe(0);
    const statusBody = JSON.parse(status.stdout) as { ok: boolean; running: boolean };
    expect(statusBody.ok).toBe(true);
    expect(statusBody.running).toBe(true);
    const auth = await runCli(["auth", "status", ...base()]);
    expect(auth.code).toBe(0);
    const authBody = JSON.parse(auth.stdout) as { mode: string; auth_value_masked: string };
    expect(authBody.mode).toBe("open");
    expect(authBody.auth_value_masked).toBe("(unset)");
  }, 30000);
});

describe("attachments, search, eof-commit, SSE", () => {
  test("--attach uploads content-addressed media and CLI search finds it", async () => {
    await createAccount("attach");
    const file = join(ws.cwd, "shot.png");
    writeFileSync(file, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
    const posted = await runCli([
      "post",
      "with attachment token-xyz",
      "--attach",
      file,
      ...base(),
      "--as",
      "attach",
    ]);
    expect(posted.code).toBe(0);
    const summary = (JSON.parse(posted.stdout) as { posts: Array<{ id: string; media: string[] }> })
      .posts[0]!;
    expect(summary.media).toHaveLength(1);
    const read = await runCli(["read", "--thread", summary.id, ...base(), "--as", "attach"]);
    const thread = JSON.parse(read.stdout) as {
      thread: { posts: Array<{ media: Array<{ hash: string; url: string }> }> };
    };
    expect(thread.thread.posts[0]!.media[0]!.hash).toBe(summary.media[0]!);
    expect(thread.thread.posts[0]!.media[0]!.url).toBe(`/api/media/${summary.media[0]}`);
    const search = await runCli(["search", "token-xyz", ...base(), "--as", "attach"]);
    expect(search.code).toBe(0);
    expect((JSON.parse(search.stdout) as { posts: unknown[] }).posts.length).toBeGreaterThanOrEqual(1);
  }, 60000);

  test("--eof-commit explicitly commits at EOF", async () => {
    await createAccount("eofc");
    const eof = await runCli(["post", "--batch", "--eof-commit", ...base(), "--as", "eofc"], {
      stdin: '{"op":"post","body":"eof commit"}\n',
    });
    expect(eof.code).toBe(0);
    expect((JSON.parse(eof.stdout) as { posts: unknown[] }).posts).toHaveLength(1);
  }, 30000);

  test("SSE streams a hello event with proxy-safe headers", async () => {
    const controller = new AbortController();
    const res = await fetch(`${server.url}/api/stream?as=a`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: hello");
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      // aborted
    }
  }, 30000);
});

describe("manager auto-export", () => {
  test("runs after delivery; a failing export does not swallow messages or break exit code", async () => {
    const autoWs = initWorkspace({ open: true });
    const autoServer = await startTestServer({ workspace: autoWs });
    try {
      const created = await runCli([
        "accounts",
        "create",
        "a",
        "--data-dir",
        autoWs.dataDir,
        "--as",
        "manager",
      ]);
      expect(created.code).toBe(0);
      const posted = await runCli(["post", "auto export me", "--data-dir", autoWs.dataDir, "--as", "a"]);
      expect(posted.code).toBe(0);

      // break the export target on purpose
      const exportPath = join(autoWs.dataDir, "export");
      rmSync(exportPath, { recursive: true, force: true });
      writeFileSync(exportPath, "not a directory");

      const waited = await runCli(
        ["wait-notifications", "--data-dir", autoWs.dataDir, "--as", "manager"],
        { timeoutMs: 30_000 },
      );
      expect(waited.code).toBe(0);
      expect(waited.stdout).toContain("post.created");
      expect(waited.stderr).toContain("auto-export failed");

      const status = (await (
        await fetch(`${autoServer.url}/api/status`, { headers: { "x-report-account": "manager" } })
      ).json()) as { pending_export: boolean; counts: { posts: number } };
      expect(status.pending_export).toBe(true);
      expect(status.counts.posts).toBe(1);

      // fix the target, deliver the next event -> export succeeds and clears the flag
      rmSync(exportPath, { force: true });
      mkdirSync(exportPath);
      await runCli(["post", "second event", "--data-dir", autoWs.dataDir, "--as", "a"]);
      const second = await runCli(
        ["wait-notifications", "--data-dir", autoWs.dataDir, "--as", "manager"],
        { timeoutMs: 30_000 },
      );
      expect(second.code).toBe(0);
      expect(await Bun.file(join(exportPath, "index.html")).exists()).toBe(true);
      const status2 = (await (
        await fetch(`${autoServer.url}/api/status`, { headers: { "x-report-account": "manager" } })
      ).json()) as { pending_export: boolean };
      expect(status2.pending_export).toBe(false);
    } finally {
      await autoServer.stop();
      autoWs.cleanup();
    }
  }, 90000);
});

describe("CLI in auth mode (account tokens)", () => {
  test("token files drive the CLI; no login needed", async () => {
    const authWs = initWorkspace();
    const authServer = await startTestServer({ workspace: authWs });
    try {
      const managerEnv = join(authWs.dataDir, "accounts", "manager.env");
      const created = await runCli([
        "accounts",
        "create",
        "a",
        "--data-dir",
        authWs.dataDir,
        "--as",
        "manager",
        "--env-files",
        managerEnv,
      ]);
      expect(created.code).toBe(0);
      const aEnv = join(authWs.dataDir, "accounts", "a.env");
      const posted = await runCli([
        "post",
        "secure post",
        "--data-dir",
        authWs.dataDir,
        "--as",
        "a",
        "--env-files",
        aEnv,
      ]);
      expect(posted.code).toBe(0);
      const rootId = (JSON.parse(posted.stdout) as { posts: Array<{ id: string }> }).posts[0]!.id;

      // no token -> actionable failure
      const noToken = await runCli(["read", "--data-dir", authWs.dataDir, "--as", "a"]);
      expect(noToken.code).not.toBe(0);
      expect(noToken.stderr).toContain("account token");

      const read = await runCli([
        "read",
        "--thread",
        rootId,
        "--data-dir",
        authWs.dataDir,
        "--as",
        "a",
        "--env-files",
        aEnv,
      ]);
      expect(read.code).toBe(0);

      // web login uses FDE2E_REPORT_AUTH; old access token dies when A changes
      const login = await fetch(`${authServer.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: authWs.authValue }),
      });
      expect(login.status).toBe(200);
      const token = ((await login.json()) as { token: string }).token;
      expect(
        (
          await fetch(`${authServer.url}/api/who`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(200);
    } finally {
      await authServer.stop();
      authWs.cleanup();
    }
  }, 90000);
});
