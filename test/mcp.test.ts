/**
 * `stoa mcp` 单测（stoa-adapters P1-2/P1-3）：
 *  1. 工具清单与 JSON schema 完整性（八工具；post/reply 的 body|file 与 kind|format|article 同义组）；
 *  2. 配置解析顺序：flags > STOA_* > REPORT_CHANNEL_* / FDE2E_REPORT_* > 配置文件 > 旧配置回退 > 默认；
 *  3. 错误语义：tools/call 一律 isError 文本 `{ok:false, tool, error}`；未知资源 -32602；
 *  4. 凭据不回显：stdout/stderr/错误文本/面板 HTML 都不含 token（401 / 网络错误 / 成功路径）；
 *  5. 面板资源：resources/list（ui://stoa/board.html）与 resources/read 的 HTML 配置注入。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { accountTokenEnvKey } from "../src/core/auth.ts";
import { parseEnv } from "../src/core/env.ts";
import {
  DEFAULT_BASE_URL,
  DEFAULT_PUBLIC_URL,
  describeConfig,
  loadToken,
  resolveMcpConfig,
} from "../src/mcp/config.ts";
import { MCP_PROTOCOL_VERSION, runMcpServer } from "../src/mcp/server.ts";
import { TOOLS, callTool, cfgFor, resolveKind } from "../src/mcp/tools.ts";
import { PANEL_MIME, PANEL_RESOURCE, PANEL_URI, renderPanelHtml } from "../src/mcp/panel.ts";
import {
  initWorkspace,
  parseJsonLines,
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

// ── 面板资源（侧栏面板移植，UI 资源 ui://stoa/board.html）────────────────────
describe("面板资源", () => {
  test("清单条目：URI 更名 ui://stoa/board.html，其余字段不变", () => {
    expect(PANEL_URI).toBe("ui://stoa/board.html");
    expect(PANEL_MIME).toBe("text/html;profile=mcp-app");
    expect(PANEL_RESOURCE).toEqual({
      uri: "ui://stoa/board.html",
      name: "公示板",
      title: "公示板（侧栏面板）",
      mimeType: "text/html;profile=mcp-app",
    });
  });

  test("HTML 注入 baseUrl/publicUrl/account；桥与降级行为保留；无凭据", () => {
    const prevStateDir = process.env.STOA_DAEMON_STATE_DIR;
    // 隔离 daemon 发现：显式指向不存在的状态目录 → 面板不注入 daemon 入口。
    process.env.STOA_DAEMON_STATE_DIR = join(tmpdir(), "stoa-panel-no-daemon");
    try {
      const cfg = resolveMcpConfig({
        flags: {
          baseUrl: "http://127.0.0.1:13687/",
          account: "manager",
          publicUrl: "https://board.example/",
        },
        env: {},
        home: "/nonexistent-home",
      });
      const html = renderPanelHtml(cfg);
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html.endsWith("</html>")).toBe(true);
      const boot = JSON.stringify({
        baseUrl: "http://127.0.0.1:13687",
        publicUrl: "https://board.example",
        account: "manager",
        daemonUrl: null,
      });
      expect(html.includes(`const BOOT = ${boot};`)).toBe(true);
    // MCP Apps 桥（ui/initialize → initialized → tools/call / ui/open-link）保留。
    expect(html.includes("ui/initialize")).toBe(true);
    expect(html.includes("ui/notifications/initialized")).toBe(true);
    expect(html.includes("ui/open-link")).toBe(true);
    // 桥不通时的降级说明 + 直链（绝不留白屏）。
    expect(html.includes("面板桥未就绪")).toBe(true);
    expect(html.includes("board_peek")).toBe(true);
    // 面板与凭据无关：HTML 里没有任何 token 字段或值。
    expect(html.includes("token")).toBe(false);
    expect(html.includes("Bearer")).toBe(false);
    // MCP Apps 桥身份中性化：appInfo.name = stoa（旧插件为 report-channel）。
      expect(html.includes('appInfo: { name: "stoa"')).toBe(true);
      expect(html.includes("report-channel")).toBe(false);
      // daemon 不存在：入口按钮留在 DOM 里但默认隐藏（stoa-daemon design §4）。
      expect(html.includes('<button id="daemon" style="display:none">')).toBe(true);
    } finally {
      if (prevStateDir === undefined) delete process.env.STOA_DAEMON_STATE_DIR;
      else process.env.STOA_DAEMON_STATE_DIR = prevStateDir;
    }
  });

  test("daemon 控制台入口：daemon.json 存在时注入 daemonUrl 并显示按钮", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "stoa-panel-daemon-"));
    const prevStateDir = process.env.STOA_DAEMON_STATE_DIR;
    process.env.STOA_DAEMON_STATE_DIR = stateDir;
    try {
      writeFileSync(
        join(stateDir, "daemon.json"),
        JSON.stringify({
          pid: 4321,
          port: 13679,
          url: "http://127.0.0.1:13679",
          stateDir,
          version: "0.2.0",
          startedAt: 1,
        }),
      );
      const cfg = resolveMcpConfig({ flags: { baseUrl: "http://127.0.0.1:13687", account: "manager" }, env: {}, home: "/nonexistent-home" });
      const html = renderPanelHtml(cfg);
      expect(html.includes('"daemonUrl":"http://127.0.0.1:13679"')).toBe(true);
      expect(html.includes("Daemon 控制台")).toBe(true);
      expect(html.includes("BOOT.daemonUrl")).toBe(true);
    } finally {
      if (prevStateDir === undefined) delete process.env.STOA_DAEMON_STATE_DIR;
      else process.env.STOA_DAEMON_STATE_DIR = prevStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
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

  test("cfgFor：args.as > CLI --as（accountOverride）> FORCE_ACCOUNT（双前缀）> 配置账号", () => {
    const base = resolveMcpConfig({ flags: {}, env: {}, home: "/nonexistent-home" });
    expect(cfgFor(base, {}, {}).account).toBe("manager");
    expect(cfgFor(base, {}, { REPORT_CHANNEL_FORCE_ACCOUNT: "forced" }).account).toBe("forced");
    expect(cfgFor(base, {}, { STOA_FORCE_ACCOUNT: "forced-new" }).account).toBe("forced-new");
    expect(
      cfgFor(base, { as: "explicit" }, { STOA_FORCE_ACCOUNT: "forced-new" }).account,
    ).toBe("explicit");
    const cliAs = { ...base, accountOverride: "cli-as" };
    expect(cfgFor(cliAs, {}, { STOA_FORCE_ACCOUNT: "forced-new" }).account).toBe("cli-as");
    expect(cfgFor(cliAs, { as: "tool-as" }, { STOA_FORCE_ACCOUNT: "forced-new" }).account).toBe(
      "tool-as",
    );
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
        // 协议版本协商：不认识的版本回服务端支持版本，认识的版本回显。
        { jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion: "1999-01-01" } },
        { jsonrpc: "2.0", id: 6, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      ],
    );
    expect(run.code).toBe(0);
    expect(run.responses.get(1)?.result?.protocolVersion).toBe("2024-11-05");
    const capabilities = run.responses.get(1)?.result?.capabilities as Record<string, unknown>;
    expect(capabilities?.tools).toEqual({});
    // P2-7：提供 resources/list|read，capabilities 必须声明 resources。
    expect(capabilities?.resources).toEqual({});
    expect(run.responses.get(5)?.result?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(run.responses.get(6)?.result?.protocolVersion).toBe("2025-06-18");
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

  test("resources/list + resources/read：面板清单 / HTML 注入 / 未知 URI 错误", async () => {
    const run = await runMcpSession(
      {
        HOME: ws.root,
        STOA_DAEMON_STATE_DIR: join(ws.root, "no-daemon"),
        STOA_BASE_URL: server.url,
        STOA_ACCOUNT: "owner",
        STOA_DATA_DIR: ws.dataDir,
      },
      [
        { jsonrpc: "2.0", id: 1, method: "resources/list", params: {} },
        { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: PANEL_URI } },
        { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "ui://stoa/nope.html" } },
      ],
    );
    const resources = run.responses.get(1)?.result?.resources as Array<Record<string, unknown>>;
    expect(resources).toEqual([PANEL_RESOURCE]);
    const contents = run.responses.get(2)?.result?.contents as Array<Record<string, unknown>>;
    expect(contents).toHaveLength(1);
    expect(contents[0]!.uri).toBe(PANEL_URI);
    expect(contents[0]!.mimeType).toBe("text/html;profile=mcp-app");
    const html = String(contents[0]!.text ?? "");
    const boot = JSON.stringify({
      baseUrl: server.url,
      publicUrl: DEFAULT_PUBLIC_URL,
      account: "owner",
      daemonUrl: null,
    });
    expect(html.includes(`const BOOT = ${boot};`)).toBe(true);
    expect(html.includes(ownerToken)).toBe(false);
    expect(html.includes(managerToken)).toBe(false);
    expect(run.stdout.includes(ownerToken)).toBe(false);
    // 未知资源：-32602 + 固定文案（与旧插件逐字一致）。
    expect(run.responses.get(3)?.error).toEqual({
      code: -32602,
      message: "unknown resource: ui://stoa/nope.html",
    });
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

  test("非法 JSON 回 -32700；非法请求回 -32600（id:null）", async () => {
    const raw = [
      "not json at all",
      JSON.stringify({ jsonrpc: "2.0" }),
      "42",
      JSON.stringify({ jsonrpc: "2.0", id: 9 }),
    ].join("\n");
    const run = await runCli(["mcp"], {
      stdin: `${raw}\n`,
      env: {
        ...CLEAN_ENV,
        HOME: ws.root,
        STOA_BASE_URL: server.url,
        STOA_ACCOUNT: "manager",
        STOA_DATA_DIR: ws.dataDir,
      },
      timeoutMs: 15_000,
    });
    expect(run.code).toBe(0);
    const lines = parseJsonLines(run.stdout);
    expect(lines[0]).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(lines[1]).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
    expect(lines[2]).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
    // 有 id 但缺 method：仍是 Invalid Request，错误回显该 id。
    expect(lines[3]).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32600, message: "Invalid Request" },
    });
  });

  test("--env-files 参与配置与凭据；--as 覆盖账号（最高优先，高于 FORCE_ACCOUNT）", async () => {
    const envFile = join(ws.root, "mcp-cli-flags.env");
    writeFileSync(
      envFile,
      [
        `STOA_BASE_URL=${server.url}`,
        `STOA_DATA_DIR=${ws.dataDir}`,
        `STOA_TOKEN_OWNER=${ownerToken}`,
        "STOA_FORCE_ACCOUNT=manager",
        "",
      ].join("\n"),
    );
    const run = await runMcpSession({ HOME: ws.root }, [statusCall(1)], [
      "--env-files",
      envFile,
      "--as",
      "owner",
    ]);
    expect(run.code).toBe(0);
    const { payload, isError } = callPayload(run.responses.get(1));
    expect(isError).toBe(false);
    expect(payload.ok).toBe(true);
    expect(payload.as).toBe("owner");
    const config = payload.config as Record<string, unknown>;
    expect(config.account).toBe("owner");
    expect(config.token).toBe("present");
    expect(config.baseUrl).toBe(server.url);
    expect(run.stdout.includes(ownerToken)).toBe(false);
    expect(run.stderr.includes(ownerToken)).toBe(false);
  });

  test("board_inbox 长轮询期间 ping 立即响应（tools/call 并发，不阻塞 stdio 循环）", async () => {
    const cfg = resolveMcpConfig({
      flags: { baseUrl: server.url, account: "manager", token: managerToken },
      env: {},
      home: "/nonexistent-home",
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: Array<Record<string, unknown>> = [];
    let buffer = "";
    output.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("timed out waiting for MCP response");
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const session = runMcpServer(cfg, { input, output, env: {} });
    try {
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "board_inbox", arguments: { timeout_seconds: 15 } },
        })}\n`,
      );
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} })}\n`);
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "resources/read",
          params: { uri: PANEL_URI },
        })}\n`,
      );
      await waitFor(
        () => messages.some((m) => m.id === 2) && messages.some((m) => m.id === 3),
        5000,
      );
      // ping/resources 已回但 inbox 仍在长轮询：证明 tools/call 没有串行阻塞后续消息。
      expect(messages.some((m) => m.id === 1)).toBe(false);
      expect(messages.find((m) => m.id === 2)?.result).toEqual({});
      const panel = messages.find((m) => m.id === 3)?.result as
        | { contents?: Array<{ uri?: string }> }
        | undefined;
      expect(panel?.contents?.[0]?.uri).toBe(PANEL_URI);
      const wake = await fetch(`${server.url}/api/posts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-report-account": "owner",
          authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ body: "@manager wake for inbox", kind: "note", media: [], tags: [] }),
      });
      expect(wake.ok).toBe(true);
      await waitFor(() => messages.some((m) => m.id === 1), 15_000);
      input.end();
      await session;
      const inbox = messages.find((m) => m.id === 1)!;
      const result = inbox.result as
        | { content?: Array<{ text?: string }>; isError?: boolean }
        | undefined;
      expect(result?.isError).not.toBe(true);
      const payload = JSON.parse(result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
      expect(payload.ok).toBe(true);
      expect(Number(payload.count)).toBeGreaterThanOrEqual(1);
    } finally {
      input.end();
      await session;
    }
  }, 30_000);

  test("CLI 直连模式：无 data-dir 指针时 read/status/wait-notifications 走 --base-url/env + --as", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "stoa-direct-cwd-"));
    try {
      const cleanEnv = { ...CLEAN_ENV, HOME: ws.root };
      const status = await runCli(
        ["status", "--base-url", server.url, "--account", "manager", "--token", managerToken],
        { cwd, env: cleanEnv },
      );
      expect(status.code).toBe(0);
      const statusBody = JSON.parse(status.stdout) as {
        ok: boolean;
        mode: string;
        running: boolean;
        server: { url: string; account: string };
      };
      expect(statusBody.ok).toBe(true);
      expect(statusBody.mode).toBe("direct");
      expect(statusBody.running).toBe(true);
      expect(statusBody.server.url).toBe(server.url);
      expect(statusBody.server.account).toBe("manager");

      // env 层：STOA_BASE_URL + STOA_TOKEN_OWNER（无 --token）；--as 覆盖 --account。
      const read = await runCli(
        ["read", "--as", "owner", "--account", "manager", "--limit", "1"],
        {
          cwd,
          env: { ...cleanEnv, STOA_BASE_URL: server.url, STOA_TOKEN_OWNER: ownerToken },
        },
      );
      expect(read.code).toBe(0);
      expect((JSON.parse(read.stdout) as { ok: boolean }).ok).toBe(true);

      // 给 owner 造一条通知，再用直连 wait-notifications 消费。
      const posted = await fetch(`${server.url}/api/posts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-report-account": "manager",
          authorization: `Bearer ${managerToken}`,
        },
        body: JSON.stringify({ body: "@owner direct mode ping", kind: "note", media: [], tags: [] }),
      });
      expect(posted.ok).toBe(true);
      const waited = await runCli(
        [
          "wait-notifications",
          "--base-url",
          server.url,
          "--as",
          "owner",
          "--token",
          ownerToken,
          "--timeout",
          "10",
        ],
        { cwd, env: cleanEnv, timeoutMs: 20_000 },
      );
      expect(waited.code).toBe(0);
      const lines = parseJsonLines(waited.stdout);
      expect(lines.some((line) => line.type === "post.created")).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
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
