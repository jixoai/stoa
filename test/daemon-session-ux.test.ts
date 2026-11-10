/**
 * stoa-session-ux 测试：会话位置（自动/临时/自定义）、访问口令读写、目录选择器、
 * 口令链接，以及「挂载即认证 → 口令登录 → 轮换后旧 token 失效」的真实进程闭环。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonRequest, probeDaemon } from "../src/daemon/client.ts";
import { pickerCommand, pickerSupported } from "../src/daemon/picker.ts";
import {
  findAuthKey,
  generateAuthKey,
  keyLink,
  newSessionDirName,
  resolveSessionDataDir,
  sessionsRoot,
  setAuthKey,
  slugify,
  validateAuthKey,
} from "../src/daemon/sessions.ts";
import { readServices } from "../src/daemon/state.ts";
import { BUN, CLI, initWorkspace, type TestWorkspace } from "./helpers.ts";
import { portIsListening } from "../src/server/ports.ts";

const RESERVED = new Set([13689, 13690, 13696, 13697]);
const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
});

async function pickFreePort(min: number, max: number, exclude: Set<number>): Promise<number> {
  for (let port = max; port >= min; port--) {
    if (exclude.has(port)) continue;
    // Bun 对已占用端口不抛错（会静默共享），所以用 TCP 探测判定空闲。
    if (await portIsListening("127.0.0.1", port)) continue;
    return port;
  }
  throw new Error(`no free port in ${min}-${max}`);
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function registerCleanup(ws: TestWorkspace, dirs: string[], pids: Array<number | null | undefined>): void {
  cleanups.push(() => {
    const stateDir = dirs[0]!;
    for (const record of readServices(stateDir)) {
      if (record.pid) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
    for (const pid of pids) {
      if (!pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    ws.cleanup();
  });
}

describe("session dirs", () => {
  test("slugify + newSessionDirName 可读且稳定前缀", () => {
    expect(slugify("My Board!")).toBe("my-board");
    expect(slugify("")).toBe("board");
    expect(slugify("中文名")).toBe("board");
    expect(newSessionDirName("My Board", "ABCDEF123456")).toBe("my-board-abcdef");
    expect(sessionsRoot("/home/x")).toBe(join("/home/x", ".stoa", "sessions"));
  });

  test("resolveSessionDataDir：auto 落 ~/.stoa/sessions；temp 标记 ephemeral；path 建目录", () => {
    const home = mkdtempSync(join(tmpdir(), "stoa-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "stoa-cwd-"));
    try {
      const auto = resolveSessionDataDir({ location: "auto", name: "demo", home });
      expect(auto.dataDir.startsWith(join(home, ".stoa", "sessions", "demo-"))).toBe(true);
      expect(existsSync(auto.dataDir)).toBe(true);
      expect(auto.ephemeral).toBe(false);
      expect(auto.created).toBe(true);

      const temp = resolveSessionDataDir({ location: "temp", home });
      expect(temp.ephemeral).toBe(true);
      expect(existsSync(temp.dataDir)).toBe(true);
      rmSync(temp.dataDir, { recursive: true, force: true });

      const custom = resolveSessionDataDir({ location: "path", dataDir: "nested/dir", cwd, home });
      expect(custom.dataDir).toBe(join(cwd, "nested", "dir"));
      expect(existsSync(custom.dataDir)).toBe(true);
      expect(custom.created).toBe(true);

      expect(() => resolveSessionDataDir({ location: "path", home })).toThrow(/requires dataDir/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("auth keys", () => {
  test("generate/validate", () => {
    const key = generateAuthKey();
    expect(key.length).toBe(24);
    expect(validateAuthKey("  abcdef  ")).toBe("abcdef");
    expect(() => validateAuthKey("short")).toThrow(/6-128/);
    expect(() => validateAuthKey("has space")).toThrow(/whitespace/);
  });

  test("setAuthKey 重写/追加并保留其它行；findAuthKey 按序取首个", () => {
    const dir = mkdtempSync(join(tmpdir(), "stoa-env-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "STOA_SECRET=abc\nFDE2E_REPORT_AUTH=legacy\n# comment\n", { mode: 0o600 });
      setAuthKey(file, "first-key");
      let text = readFileSync(file, "utf8");
      expect(text.includes("STOA_SECRET=abc")).toBe(true);
      expect(text.includes("# comment")).toBe(true);
      expect(text.includes("FDE2E_REPORT_AUTH=legacy")).toBe(false);
      expect(text.includes("STOA_AUTH=first-key")).toBe(true);
      setAuthKey(file, "second-key");
      text = readFileSync(file, "utf8");
      expect(text.includes("STOA_AUTH=second-key")).toBe(true);
      expect(text.includes("first-key")).toBe(false);

      const second = join(dir, "other.env");
      writeFileSync(second, "STOA_AUTH=other-key\n");
      expect(findAuthKey([join(dir, "missing.env"), second, file])).toEqual({
        file: second,
        key: "other-key",
      });
      expect(findAuthKey([join(dir, "missing.env")])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keyLink 用 publicUrl 优先，fragment 形态", () => {
    expect(keyLink({ url: "http://127.0.0.1:13680/", publicUrl: null }, "a b")).toBe(
      "http://127.0.0.1:13680/#key=a%20b",
    );
    expect(keyLink({ url: "http://127.0.0.1:13680", publicUrl: "https://board.example/" }, "k1")).toBe(
      "https://board.example/#key=k1",
    );
    expect(keyLink({ url: null, publicUrl: null }, "k1")).toBeNull();
  });
});

describe("directory picker", () => {
  test("pickerCommand: 三平台命令形状，其它平台 null", () => {
    expect(pickerCommand("darwin")?.cmd).toBe("osascript");
    expect(pickerCommand("darwin")?.args.join(" ")).toContain("choose folder");
    expect(pickerCommand("linux")?.cmd).toBe("zenity");
    expect(pickerCommand("win32")?.cmd).toBe("powershell");
    expect(pickerCommand("freebsd")).toBeNull();
    expect(pickerSupported("darwin")).toBe(true);
    expect(pickerSupported("freebsd")).toBe(false);
  });
});

test(
  "auto 会话：自动初始化→默认开口令→口令登录→轮换失效旧 token→publicUrl 影响链接",
  async () => {
    const ws = initWorkspace({ open: true });
    const stateDir = mkdtempSync(join(tmpdir(), "stoa-daemon-state-"));
    const home = mkdtempSync(join(tmpdir(), "stoa-daemon-home-"));
    const daemonPort = await pickFreePort(13670, 13679, RESERVED);
    const pickedDir = join(home, "picked-dir");
    const url = `http://127.0.0.1:${daemonPort}`;
    const proc = Bun.spawn({
      cmd: [BUN, CLI, "daemon", "run", "--port", String(daemonPort), "--state-dir", stateDir],
      cwd: ws.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        STOA_DAEMON_STATE_DIR: stateDir,
        STOA_DIR_PICKER_RESULT: pickedDir,
      },
    });
    registerCleanup(ws, [stateDir, home], [proc.pid]);
    await waitFor(async () => Boolean(await probeDaemon(url, 400)), 15_000, "daemon healthz");

    // 目录选择器（测试钩子）：返回配置路径；取消（空串）返回 null
    const picked = await daemonRequest<{ ok: boolean; path: string | null }>(
      url,
      "/api/daemon/pick-directory",
      { method: "POST" },
    );
    expect(picked.ok).toBe(true);
    expect(picked.path).toBe(pickedDir);

    // 自动会话：无 dataDir，建在 $HOME/.stoa/sessions 下并初始化
    const mounted = await daemonRequest<{
      service: {
        id: string;
        name: string;
        dataDir: string;
        url: string;
        ephemeral?: boolean;
        envFiles?: string[];
      };
      warnings: string[];
    }>(url, "/api/daemon/services", {
      method: "POST",
      body: { location: "auto", name: "Auto Board" },
    });
    const service = mounted.service;
    expect(service.name).toBe("Auto Board");
    expect(service.dataDir.startsWith(join(home, ".stoa", "sessions", "auto-board-"))).toBe(true);
    expect(existsSync(join(service.dataDir, "report.sqlite"))).toBe(true);
    expect(service.ephemeral).toBe(false);
    expect(mounted.warnings).toEqual([]);

    // 口令：模式 auth、可读、链接形态正确
    const secret = await daemonRequest<{
      mode: string;
      key: string | null;
      key_link: string | null;
      source: string | null;
    }>(url, `/api/daemon/services/${service.id}/secret`);
    expect(secret.mode).toBe("auth");
    expect((secret.key ?? "").length).toBeGreaterThanOrEqual(20);
    expect(secret.key_link).toBe(`${service.url}/#key=${encodeURIComponent(secret.key!)}`);
    expect(secret.source).toBe(join(service.dataDir, ".env"));

    // 用该口令登录并访问受保护接口
    const login = await fetch(`${service.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: secret.key }),
    });
    expect(login.status).toBe(200);
    const token = ((await login.json()) as { token: string }).token;
    const before = await fetch(`${service.url}/api/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.status).toBe(200);

    // 重复挂载同 dataDir：幂等复用（不新建目录、不换 pid）
    const again = await daemonRequest<{ service: { id: string; pid: number }; reused: boolean }>(
      url,
      "/api/daemon/services",
      { method: "POST", body: { dataDir: service.dataDir } },
    );
    expect(again.reused).toBe(true);
    expect(again.service.id).toBe(service.id);

    // 轮换口令：旧 token 立即失效，新口令可登录（daemon 拉起的服务写文件即生效）
    const rotated = await daemonRequest<{
      key: string;
      key_link: string;
      applied: boolean;
      restarted: boolean;
    }>(url, `/api/daemon/services/${service.id}/secret`, { method: "PUT", body: { generate: true } });
    expect(rotated.key).not.toBe(secret.key);
    expect(rotated.applied).toBe(true);
    const oldToken = await fetch(`${service.url}/api/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(oldToken.status).toBe(401);
    const relogin = await fetch(`${service.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: rotated.key }),
    });
    expect(relogin.status).toBe(200);

    // publicUrl（隧道域名）写入后，口令链接改用公网地址
    const patched = await daemonRequest<{ service: { publicUrl?: string | null } }>(
      url,
      `/api/daemon/services/${service.id}`,
      { method: "PATCH", body: { publicUrl: "https://board.example/" } },
    );
    expect(patched.service.publicUrl).toBe("https://board.example");
    const secret2 = await daemonRequest<{ key_link: string | null }>(
      url,
      `/api/daemon/services/${service.id}/secret`,
    );
    expect(secret2.key_link).toBe(`https://board.example/#key=${encodeURIComponent(rotated.key)}`);

    // 开放模式目录挂载：自动生成口令并给出提示
    const openMount = await daemonRequest<{
      service: { id: string; dataDir: string };
      warnings: string[];
    }>(url, "/api/daemon/services", {
      method: "POST",
      body: { dataDir: ws.dataDir },
    });
    expect(openMount.warnings.join(" ")).toContain("开放模式");
    const openSecret = await daemonRequest<{ mode: string; key: string | null }>(
      url,
      `/api/daemon/services/${openMount.service.id}/secret`,
    );
    expect(openSecret.mode).toBe("auth");
    expect(typeof openSecret.key).toBe("string");

    // 收口：停掉全部并关 daemon
    await daemonRequest(url, `/api/daemon/services/${openMount.service.id}/stop`, { method: "POST" });
    await daemonRequest(url, `/api/daemon/services/${service.id}/stop`, { method: "POST" });
    await daemonRequest(url, "/api/daemon/shutdown", { method: "POST" });
    await waitFor(async () => !(await probeDaemon(url, 300)), 20_000, "daemon exit");
    // auto 会话目录保留（非临时）
    expect(existsSync(join(service.dataDir, "report.sqlite"))).toBe(true);
  },
  120_000,
);
