/**
 * `stoa mcp` 单测（stoa-adapters P1-2/P1-3）：
 *  1. 工具清单与 JSON schema 完整性（八工具；post/reply 的 body|file 与 kind|format|article 同义组）；
 *  2. 配置解析顺序：flags > STOA_* > REPORT_CHANNEL_* / FDE2E_REPORT_* > 配置文件 > 旧配置回退 > 默认；
 *  3. 错误语义：tools/call 一律 isError 文本 `{ok:false, tool, error}`；
 *  4. 凭据不回显：stdout/stderr/错误文本都不含 token（401 / 网络错误 / 成功路径）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountTokenEnvKey } from "../src/core/auth.ts";
import { parseEnv } from "../src/core/env.ts";
import {
  DEFAULT_BASE_URL,
  DEFAULT_PUBLIC_URL,
  describeConfig,
  loadToken,
  resolveMcpConfig,
} from "../src/mcp/config.ts";
import { TOOLS, callTool, cfgFor, resolveKind } from "../src/mcp/tools.ts";
import {
  initWorkspace,
  runCli,
  startTestServer,
  type RunningTestServer,
  type TestWorkspace,
} from "./helpers.ts";

const TOOL_NAMES = [
  "board_post",
  "board_reply",
  "board_read",
  "board_inbox",
  "board_peek",
  "board_bookmark",
  "board_bookmarks",
  "board_status",
];

/** 中和开发者 shell 里可能存在的 stoa/仓库 env（空值＝未设，与解析契约一致）。 */
const CLEAN_ENV: Record<string, string> = {
  STOA_BASE_URL: "",
  STOA_TOKEN: "",
  STOA_ACCOUNT: "",
  STOA_DATA_DIR: "",
  STOA_PUBLIC_URL: "",
  STOA_CONFIG: "",
  STOA_FORCE_ACCOUNT: "",
  STOA_TOKEN_OWNER: "",
  STOA_TOKEN_MANAGER: "",
  REPORT_CHANNEL_BASE_URL: "",
  REPORT_CHANNEL_ACCOUNT: "",
  REPORT_CHANNEL_DATA_DIR: "",
  REPORT_CHANNEL_PUBLIC_URL: "",
  REPORT_CHANNEL_CONFIG: "",
  REPORT_CHANNEL_FORCE_ACCOUNT: "",
  FDE2E_REPORT_TOKEN_OWNER: "",
  FDE2E_REPORT_TOKEN_MANAGER: "",
};

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "mcp-test-home-"));
}

interface JsonRpcResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function runMcpSession(
  env: Record<string, string | undefined>,
  requests: Array<Record<string, unknown>>,
  extraArgs: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string; responses: Map<number, JsonRpcResponse> }> {
  const stdin = requests.map((request) => `${JSON.stringify(request)}\n`).join("");
  const run = await runCli(["mcp", ...extraArgs], {
    stdin,
    env: { ...CLEAN_ENV, ...env },
    timeoutMs: 30_000,
  });
  const responses = new Map<number, JsonRpcResponse>();
  for (const line of run.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const message = JSON.parse(trimmed) as JsonRpcResponse;
    if (typeof message.id === "number") responses.set(message.id, message);
  }
  return { ...run, responses };
}

function statusCall(id = 3, args: Record<string, unknown> = {}): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "board_status", arguments: args } };
}

function callPayload(response: JsonRpcResponse | undefined): {
  payload: Record<string, unknown>;
  isError: boolean;
  text: string;
} {
  const result = response?.result as
    | { content?: Array<{ type: string; text: string }>; isError?: boolean }
    | undefined;
  const text = result?.content?.[0]?.text ?? "";
  return { payload: JSON.parse(text) as Record<string, unknown>, isError: Boolean(result?.isError), text };
}

// ── 1. 工具清单与 schema 完整性 ───────────────────────────────────────────────
describe("tools/list 工具面", () => {
  test("八工具、名称与 schema 关键面逐字齐备", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
    const post = TOOLS.find((tool) => tool.name === "board_post")!;
    expect(Object.keys(post.inputSchema.properties)).toEqual([
      "body",
      "file",
      "kind",
      "format",
      "article",
      "tags",
      "quote",
      "as",
    ]);
    const reply = TOOLS.find((tool) => tool.name === "board_reply")!;
    expect(reply.inputSchema.required).toEqual(["post_id"]);
    const kind = post.inputSchema.properties.kind as Record<string, unknown>;
    const format = post.inputSchema.properties.format as Record<string, unknown>;
    expect(kind.enum).toEqual(["note", "article"]);
    expect(format.enum).toEqual(["note", "article"]);
    expect(reply.inputSchema.properties.kind).toEqual(kind);
    const bookmark = TOOLS.find((tool) => tool.name === "board_bookmark")!;
    expect(bookmark.inputSchema.required).toEqual(["post_id"]);
    const peek = TOOLS.find((tool) => tool.name === "board_peek")!;
    expect(Object.keys(peek.inputSchema.properties)).toEqual(["cursor", "limit", "as"]);
    const status = TOOLS.find((tool) => tool.name === "board_status")!;
    expect(Object.keys(status.inputSchema.properties)).toEqual(["as"]);
  });

  test("kind|format|article 同义归一化（收敛语义）", () => {
    expect(resolveKind({})).toBe("note");
    expect(resolveKind({ kind: "article" })).toBe("article");
    expect(resolveKind({ format: "article" })).toBe("article");
    expect(resolveKind({ article: true })).toBe("article");
    expect(resolveKind({ article: false })).toBe("note");
    expect(resolveKind({ kind: "article", article: true })).toBe("article");
    expect(() => resolveKind({ kind: "article", format: "note" })).toThrow(/conflicting kind\/format\/article/);
    expect(() => resolveKind({ kind: "nope" })).toThrow(/kind must be "note" or "article"/);
  });
});

// ── 2. 配置解析顺序 ──────────────────────────────────────────────────────────
describe("配置解析顺序（先到先得，空值＝未设）", () => {
  test("全空 → 默认值（13689 / manager / 主配置路径 / 无 token）", () => {
    const home = tempHome();
    try {
      const cfg = resolveMcpConfig({ flags: {}, env: {}, home });
      expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
      expect(cfg.account).toBe("manager");
      expect(cfg.publicUrl).toBe(DEFAULT_PUBLIC_URL);
      expect(cfg.dataDir).toBe("");
      expect(cfg.path).toBe(join(home, ".config/stoa/report-channel.json"));
      expect(loadToken(cfg, {})).toBeNull();
      expect(describeConfig(cfg, {}).token).toBe("absent");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("flags > STOA_* > REPORT_CHANNEL_*", () => {
    const env = {
      STOA_BASE_URL: "http://stoa-env",
      STOA_ACCOUNT: "stoa-acct",
      STOA_DATA_DIR: "/stoa-dir",
      STOA_PUBLIC_URL: "https://stoa-env-pub",
      REPORT_CHANNEL_BASE_URL: "http://legacy-env",
      REPORT_CHANNEL_ACCOUNT: "legacy-acct",
      REPORT_CHANNEL_DATA_DIR: "/legacy-dir",
      REPORT_CHANNEL_PUBLIC_URL: "https://legacy-env-pub",
    };
    const home = tempHome();
    try {
      const fromEnv = resolveMcpConfig({ flags: {}, env, home });
      expect(fromEnv.baseUrl).toBe("http://stoa-env");
      expect(fromEnv.account).toBe("stoa-acct");
      expect(fromEnv.dataDir).toBe("/stoa-dir");
      expect(fromEnv.publicUrl).toBe("https://stoa-env-pub");

      const fromFlags = resolveMcpConfig({
        flags: {
          baseUrl: "http://flag-url/",
          account: "flag-acct",
          dataDir: "/flag-dir",
          publicUrl: "https://flag-pub/",
          token: "flag-token",
        },
        env,
        home,
      });
      expect(fromFlags.baseUrl).toBe("http://flag-url");
      expect(fromFlags.account).toBe("flag-acct");
      expect(fromFlags.dataDir).toBe("/flag-dir");
      expect(fromFlags.publicUrl).toBe("https://flag-pub");
      expect(loadToken(fromFlags, env)).toBe("flag-token");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("空值＝未设：STOA_* 空串回落 REPORT_CHANNEL_*", () => {
    const cfg = resolveMcpConfig({
      flags: {},
      env: {
        STOA_BASE_URL: "",
        STOA_ACCOUNT: "  ",
        REPORT_CHANNEL_BASE_URL: "http://legacy-env",
        REPORT_CHANNEL_ACCOUNT: "legacy-acct",
      },
      home: "/nonexistent-home",
    });
    expect(cfg.baseUrl).toBe("http://legacy-env");
    expect(cfg.account).toBe("legacy-acct");
  });

  test("旧配置（~/.config/fde2e/report-channel.json）零迁移回退", () => {
    const home = tempHome();
    try {
      mkdirSync(join(home, ".config/fde2e"), { recursive: true });
      writeFileSync(
        join(home, ".config/fde2e/report-channel.json"),
        JSON.stringify({ baseUrl: "http://legacy-file", account: "legacy-file-acct", dataDir: "/legacy-file-dir" }),
      );
      const cfg = resolveMcpConfig({ flags: {}, env: {}, home });
      expect(cfg.baseUrl).toBe("http://legacy-file");
      expect(cfg.account).toBe("legacy-file-acct");
      expect(cfg.dataDir).toBe("/legacy-file-dir");
      expect(cfg.path).toBe(join(home, ".config/fde2e/report-channel.json"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("主配置文件优先；缺失键由旧配置文件补位", () => {
    const home = tempHome();
    try {
      mkdirSync(join(home, ".config/stoa"), { recursive: true });
      mkdirSync(join(home, ".config/fde2e"), { recursive: true });
      writeFileSync(
        join(home, ".config/stoa/report-channel.json"),
        JSON.stringify({ baseUrl: "http://new-file" }),
      );
      writeFileSync(
        join(home, ".config/fde2e/report-channel.json"),
        JSON.stringify({ baseUrl: "http://old-file", account: "old-file-acct", dataDir: "/old-dir" }),
      );
      const cfg = resolveMcpConfig({ flags: {}, env: {}, home });
      expect(cfg.baseUrl).toBe("http://new-file");
      expect(cfg.account).toBe("old-file-acct");
      expect(cfg.dataDir).toBe("/old-dir");
      expect(cfg.path).toBe(join(home, ".config/stoa/report-channel.json"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("REPORT_CHANNEL_CONFIG（旧 env）显式指向的配置文件生效；STOA_CONFIG 优先", () => {
    const home = tempHome();
    const alt = tempHome();
    try {
      mkdirSync(join(home, ".config/stoa"), { recursive: true });
      writeFileSync(
        join(home, ".config/stoa/report-channel.json"),
        JSON.stringify({ baseUrl: "http://default-file" }),
      );
      const altPath = join(alt, "alt.json");
      writeFileSync(altPath, JSON.stringify({ baseUrl: "http://alt-file", account: "alt-acct" }));
      const legacy = resolveMcpConfig({ flags: {}, env: { REPORT_CHANNEL_CONFIG: altPath }, home });
      expect(legacy.baseUrl).toBe("http://alt-file");
      expect(legacy.account).toBe("alt-acct");
      expect(legacy.path).toBe(altPath);
      const stoaAlt = join(alt, "stoa.json");
      writeFileSync(stoaAlt, JSON.stringify({ baseUrl: "http://stoa-alt" }));
      const both = resolveMcpConfig({
        flags: {},
        env: { STOA_CONFIG: stoaAlt, REPORT_CHANNEL_CONFIG: altPath },
        home,
      });
      expect(both.baseUrl).toBe("http://stoa-alt");
      expect(both.path).toBe(stoaAlt);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(alt, { recursive: true, force: true });
    }
  });

  test("token 层内次序：显式 > 环境键 > tokenFile > accounts env 文件", () => {
    const root = tempHome();
    try {
      const dataDir = join(root, "data");
      const accountsDir = join(dataDir, "accounts");
      mkdirSync(accountsDir, { recursive: true });
      writeFileSync(join(accountsDir, "manager.env"), "STOA_TOKEN_MANAGER=from-accounts\n");
      const tokenFile = join(root, "tokenfile.env");
      writeFileSync(tokenFile, "FDE2E_REPORT_TOKEN_MANAGER=from-tokenfile\n");
      const home = join(root, "home");
      mkdirSync(join(home, ".config/stoa"), { recursive: true });
      writeFileSync(
        join(home, ".config/stoa/report-channel.json"),
        JSON.stringify({ baseUrl: "http://x", account: "manager", dataDir, tokenFile }),
      );
      const cfg = resolveMcpConfig({ flags: {}, env: {}, home });
      expect(loadToken(cfg, {})).toBe("from-tokenfile");
      expect(loadToken(cfg, { FDE2E_REPORT_TOKEN_MANAGER: "legacy-env" })).toBe("legacy-env");
      expect(loadToken(cfg, { STOA_TOKEN_MANAGER: "new-env" })).toBe("new-env");
      expect(
        loadToken(cfg, { STOA_TOKEN_MANAGER: "new-env", FDE2E_REPORT_TOKEN_MANAGER: "legacy-env" }),
      ).toBe("new-env");
      expect(loadToken(cfg, { STOA_TOKEN: "flat" })).toBe("flat");
      const flagged = { ...cfg, explicitToken: "explicit" };
      expect(loadToken(flagged, { STOA_TOKEN: "flat" })).toBe("explicit");
      // 无 tokenFile 时回退 accounts env 文件（含 legacy 别名键）。
      const noTokenFile = { ...cfg, tokenFile: "" };
      expect(loadToken(noTokenFile, {})).toBe("from-accounts");
      writeFileSync(join(accountsDir, "manager.env"), "FDE2E_REPORT_TOKEN_MANAGER=legacy-accounts\n");
      expect(loadToken(noTokenFile, {})).toBe("legacy-accounts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cfgFor：args.as > FORCE_ACCOUNT（双前缀）> 配置账号", () => {
    const base = resolveMcpConfig({ flags: {}, env: {}, home: "/nonexistent-home" });
    expect(cfgFor(base, {}, {}).account).toBe("manager");
    expect(cfgFor(base, {}, { REPORT_CHANNEL_FORCE_ACCOUNT: "forced" }).account).toBe("forced");
    expect(cfgFor(base, {}, { STOA_FORCE_ACCOUNT: "forced-new" }).account).toBe("forced-new");
    expect(
      cfgFor(base, { as: "explicit" }, { STOA_FORCE_ACCOUNT: "forced-new" }).account,
    ).toBe("explicit");
  });
});

// ── 3+4. stdio 集成：握手 / 成功路径 / 错误语义 / 凭据不回显 ────────────────
describe("stoa mcp stdio 集成（隔离后端）", () => {
  let ws: TestWorkspace;
  let server: RunningTestServer;
  let managerToken: string;
  let ownerToken: string;

  beforeAll(async () => {
    ws = initWorkspace();
    server = await startTestServer({ workspace: ws });
    const values = parseEnv(
      await Bun.file(join(ws.dataDir, "accounts", "manager.env")).text(),
    );
    managerToken = values[accountTokenEnvKey("manager")] ?? values["FDE2E_REPORT_TOKEN_MANAGER"] ?? "";
    expect(managerToken).not.toBe("");
    const ownerValues = parseEnv(
      await Bun.file(join(ws.dataDir, "accounts", "owner.env")).text(),
    );
    ownerToken = ownerValues[accountTokenEnvKey("owner")] ?? values["FDE2E_REPORT_TOKEN_OWNER"] ?? "";
    expect(ownerToken).not.toBe("");
  });

  afterAll(async () => {
    await server.stop();
    ws.cleanup();
  });

  test("initialize / tools/list / ping 握手 + board_status ok（token 从 accounts env 文件读）", async () => {
    const run = await runMcpSession(
      {
        HOME: ws.root,
        STOA_BASE_URL: server.url,
        STOA_ACCOUNT: "owner",
        STOA_DATA_DIR: ws.dataDir,
      },
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        statusCall(3, { as: "manager" }),
        { jsonrpc: "2.0", id: 4, method: "ping", params: {} },
      ],
    );
    expect(run.code).toBe(0);
    expect(run.responses.get(1)?.result?.protocolVersion).toBe("2024-11-05");
    expect((run.responses.get(1)?.result?.capabilities as Record<string, unknown>)?.tools).toEqual({});
    const tools = run.responses.get(2)?.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(run.responses.get(4)?.result).toEqual({});
    const { payload, isError } = callPayload(run.responses.get(3));
    expect(isError).toBe(false);
    expect(payload.ok).toBe(true);
    // `as` 覆盖 + 该账号 token 从 accounts env 文件读（env 里没有任何 token 键）。
    expect(payload.as).toBe("manager");
    const config = payload.config as Record<string, unknown>;
    expect(config.account).toBe("manager");
    expect(config.token).toBe("present");
    expect(config.baseUrl).toBe(server.url);
    expect(config.dataDir).toBe(ws.dataDir);
    expect(config.configPath).toBe(join(ws.root, ".config/stoa/report-channel.json"));
    // 凭据不回显：stdout/stderr 里不得出现任一账号 token。
    expect(run.stdout.includes(managerToken)).toBe(false);
    expect(run.stdout.includes(ownerToken)).toBe(false);
    expect(run.stderr.includes(managerToken)).toBe(false);
    expect(run.stderr.includes(ownerToken)).toBe(false);
  });

  test("未知工具：isError 文本（{ok:false, tool, error} 语义）", async () => {
    const run = await runMcpSession(
      { HOME: ws.root, STOA_BASE_URL: server.url, STOA_ACCOUNT: "manager", STOA_DATA_DIR: ws.dataDir },
      [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "board_nope", arguments: {} } }],
    );
    const { payload, isError } = callPayload(run.responses.get(1));
    expect(isError).toBe(true);
    expect(payload).toEqual({ ok: false, tool: "board_nope", error: "unknown tool: board_nope" });
  });

  test("缺参/冲突在发请求前收敛为 isError 文本（body|file 与同义组）", async () => {
    const run = await runMcpSession(
      { HOME: ws.root, STOA_BASE_URL: server.url, STOA_ACCOUNT: "manager", STOA_DATA_DIR: ws.dataDir },
      [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "board_post", arguments: { body: "x", file: "y" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "board_post", arguments: {} } },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "board_reply", arguments: { post_id: "p", body: "x", kind: "article", format: "note" } },
        },
      ],
    );
    const first = callPayload(run.responses.get(1));
    expect(first.isError).toBe(true);
    expect(first.payload.error).toBe("pass either body or file, not both");
    expect(first.payload.tool).toBe("board_post");
    const second = callPayload(run.responses.get(2));
    expect(second.isError).toBe(true);
    expect(second.payload.error).toBe("body or file is required");
    const third = callPayload(run.responses.get(3));
    expect(third.isError).toBe(true);
    expect(String(third.payload.error)).toContain("conflicting kind/format/article");
  });

  test("401：isError 文本，不包含 token/认证头内容", async () => {
    const wrongToken = ["not", "a", "real", "account", "token", "401"].join("-");
    const run = await runMcpSession(
      {
        HOME: ws.root,
        STOA_BASE_URL: server.url,
        STOA_ACCOUNT: "manager",
        STOA_TOKEN: wrongToken,
      },
      [statusCall(1)],
    );
    const { payload, isError, text } = callPayload(run.responses.get(1));
    expect(isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.tool).toBe("board_status");
    expect(text.includes(wrongToken)).toBe(false);
    expect(run.stdout.includes(wrongToken)).toBe(false);
    expect(run.stderr.includes(wrongToken)).toBe(false);
    // 错误文本可以说「需要认证」（服务端指引语），但不得携带任何凭据本体。
    expect(String(payload.error)).toContain("authentication required");
  });

  test("网络错误：isError 文本，不包含 token", async () => {
    const token = "not-a-real-token-network-case";
    const run = await runMcpSession(
      {
        HOME: ws.root,
        // 丢弃口（connection refused），固定不可达：不占用端口池、不带任何凭据。
        STOA_BASE_URL: "http://127.0.0.1:9",
        STOA_ACCOUNT: "manager",
        STOA_TOKEN: token,
      },
      [statusCall(1, { as: "manager" })],
    );
    const { payload, isError, text } = callPayload(run.responses.get(1));
    expect(isError).toBe(true);
    expect(String(payload.error)).toContain("service unavailable");
    expect(text.includes(token)).toBe(false);
    expect(run.stdout.includes(token)).toBe(false);
    expect(run.stderr.includes(token)).toBe(false);
  });
});

// ── callTool 纯错误路径（无请求发出 / 只对不可达地址）────────────────────────
describe("callTool 参数护栏（发请求前抛错）", () => {
  // 显式指向不可达地址（丢弃口）：绝不落到默认 13689（生产板，只读红线）。
  const cfg = resolveMcpConfig({
    flags: { baseUrl: "http://127.0.0.1:9" },
    env: {},
    home: "/nonexistent-home",
  });

  test("file 读不到 / 超 2 MiB；缺参；cursor 非法；未知工具", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-test-files-"));
    try {
      const small = join(root, "small.md");
      writeFileSync(small, "# hello\n");
      const big = join(root, "big.md");
      writeFileSync(big, "x".repeat(2 * 1024 * 1024 + 1));
      // file 读到之后才发请求 → 对不可达后端表现为 service unavailable（证明读文件成功）。
      await expect(callTool("board_post", { file: small }, cfg, { env: {} })).rejects.toThrow(
        /service unavailable/,
      );
      await expect(callTool("board_post", { file: big }, cfg, { env: {} })).rejects.toThrow(
        /file too large \(max 2 MiB utf-8/,
      );
      await expect(callTool("board_post", { file: join(root, "missing.md") }, cfg, { env: {} })).rejects.toThrow(
        /cannot read file/,
      );
      await expect(callTool("board_peek", { cursor: -1 }, cfg, { env: {} })).rejects.toThrow(
        /cursor must be a non-negative integer/,
      );
      await expect(callTool("board_nope", {}, cfg, { env: {} })).rejects.toThrow(/unknown tool: board_nope/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("describeConfig 只报 present/absent，绝不回显 token 本体", () => {
    const cfgWithToken = { ...cfg, explicitToken: "super-secret-value" };
    const described = describeConfig(cfgWithToken, {});
    expect(described.token).toBe("present");
    expect(JSON.stringify(described).includes("super-secret-value")).toBe(false);
  });
});
