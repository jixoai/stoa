/**
 * instance-client 契约（daemon-unified-port design §1.2/§1.4，P1）：
 *   - UDS 通道用 `node:http` + `socketPath`（**不是** `fetch({unix})`：Node 的 fetch 会忽略它
 *     并静默拨 127.0.0.1:80，实测 Node 26）；
 *   - 同一 helper 在 **bun 与 node 两个 runtime** 都必须返回 200 + 实例 JSON；
 *   - TCP 通道（standalone 实例）回落普通 fetch；
 *   - 不可达统一抛 `InstanceUnreachableError`（ENOENT/ECONNREFUSED 可识别）；
 *   - `server.json` 新旧兼容（port|null + unix，至少一个）；
 *   - socket 目录必须 0700、超长路径 fallback 到 tmpdir 短目录。
 *
 * 隔离纪律：socket 全在 mkdtemp 目录里，测试结束删目录；不碰任何既有端口/实例。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  instanceFetch,
  instanceBaseUrl,
  instanceRequestPath,
  instanceUsesUnix,
  isInstanceUnreachable,
  unreachableCodeOf,
} from "../src/server/instance-client.ts";
import {
  prepareSocketPath,
  readServerInfo,
  removeSocketFile,
  serverInfoPath,
  SOCKET_PATH_SOFT_LIMIT,
  type ServerInfo,
} from "../src/server/discovery.ts";

const dirs: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterAll(() => {
  for (const server of servers.reverse()) {
    try {
      server.stop(true);
    } catch {
      // already stopped
    }
  }
  for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 一个真实的 UDS 实例（Bun.serve({unix})，与 serve 侧同一形态）。 */
function startUnixInstance(dir: string) {
  const socketPath = join(dir, "instance.sock");
  const server = Bun.serve({
    unix: socketPath,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, dataDir: "/tmp/board", instanceId: "abc123", port: null });
      }
      if (url.pathname === "/echo") {
        const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
        return Response.json({
          method: req.method,
          body,
          headers: Object.fromEntries(req.headers),
        });
      }
      if (url.pathname === "/nocontent") {
        return new Response(null, { status: 205 });
      }
      if (url.pathname === "/upload") {
        const bytes = await req.arrayBuffer();
        return Response.json({ bytes: bytes.byteLength });
      }
      if (url.pathname === "/sse") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let index = 0;
            const timer = setInterval(() => {
              controller.enqueue(new TextEncoder().encode(`data: ${index}\n\n`));
              index += 1;
              if (index >= 3) {
                clearInterval(timer);
                controller.close();
              }
            }, 120);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { socketPath, server };
}

describe("instanceFetch UDS 通道", () => {
  test("GET /healthz 走 socket 返回实例 JSON", async () => {
    const dir = tempDir("stoa-uds-");
    const { socketPath } = startUnixInstance(dir);
    expect(existsSync(socketPath)).toBe(true);
    const res = await instanceFetch({ unix: socketPath }, "/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; instanceId: string };
    expect(body.ok).toBe(true);
    expect(body.instanceId).toBe("abc123");
  });

  test("205/HEAD 的 body 必须是 null（跨 runtime 契约）", async () => {
    const dir = tempDir("stoa-uds-");
    const { socketPath } = startUnixInstance(dir);
    const noContent = await instanceFetch({ unix: socketPath }, "/nocontent");
    expect(noContent.status).toBe(205);
    expect(noContent.body).toBeNull();
    const head = await instanceFetch({ unix: socketPath }, "/healthz", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
  });

  test("POST body 与自定义头原样到达实例（不额外加压缩协商）", async () => {
    const dir = tempDir("stoa-uds-");
    const { socketPath } = startUnixInstance(dir);
    const res = await instanceFetch({ unix: socketPath }, "/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "x-report-account": "owner", "accept-encoding": "gzip" },
      body: JSON.stringify({ hello: "世界" }),
    });
    const body = (await res.json()) as { method: string; body: string; headers: Record<string, string> };
    expect(body.method).toBe("POST");
    expect(body.body).toBe('{"hello":"世界"}');
    expect(body.headers["x-report-account"]).toBe("owner");
    // identity 协商：上游不应看到 accept-encoding（代理层按 §3.2 删 content-encoding）。
    expect(body.headers["accept-encoding"]).toBeUndefined();
  });

  test("2 MiB 请求体经 socket 完整到达", async () => {
    const dir = tempDir("stoa-uds-");
    const { socketPath } = startUnixInstance(dir);
    const payload = "x".repeat(2 * 1024 * 1024);
    const res = await instanceFetch({ unix: socketPath }, "/upload", { method: "POST", body: payload });
    expect((await res.json()) as { bytes: number }).toEqual({ bytes: payload.length });
  });

  test("SSE 逐块到达（无缓冲）：三块时间戳彼此拉开", async () => {
    const dir = tempDir("stoa-uds-");
    const { socketPath } = startUnixInstance(dir);
    const res = await instanceFetch({ unix: socketPath }, "/sse", {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const stamps: number[] = [];
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stamps.push(Date.now());
      chunks.push(decoder.decode(value, { stream: true }));
    }
    expect(chunks.join("")).toContain("data: 2");
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    // 上游每 120ms 一块：若被整体缓冲，三块会同时到达（spread≈0）。
    expect(stamps.at(-1)! - stamps[0]!).toBeGreaterThanOrEqual(150);
  });
});

describe("instanceFetch TCP 回落 + 不可达映射", () => {
  test("port-only 端点走 TCP（standalone 实例）", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ok: true, via: "tcp" }),
    });
    servers.push(server);
    const res = await instanceFetch({ port: server.port, url: null, unix: null }, "/healthz");
    expect((await res.json()) as { ok: boolean; via: string }).toMatchObject({ ok: true, via: "tcp" });
    expect(instanceBaseUrl({ url: null, port: server.port })).toBe(`http://127.0.0.1:${server.port}`);
  });

  test("socket 缺失 → InstanceUnreachableError(ENOENT)", async () => {
    const missing = join(tempDir("stoa-uds-"), "missing.sock");
    let caught: unknown = null;
    try {
      await instanceFetch({ unix: missing }, "/healthz");
    } catch (err) {
      caught = err;
    }
    expect(isInstanceUnreachable(caught)).toBe(true);
    expect(unreachableCodeOf(caught)).toBe("ENOENT");
  });

  test("socket 文件存在但无人监听 → ECONNREFUSED", async () => {
    const dir = tempDir("stoa-uds-");
    const stale = join(dir, "stale.sock");
    // 建一个普通文件冒充残留 socket 文件：connect 会拿到 ECONNREFUSED。
    writeFileSync(stale, "");
    let caught: unknown = null;
    try {
      await instanceFetch({ unix: stale }, "/healthz");
    } catch (err) {
      caught = err;
    }
    expect(isInstanceUnreachable(caught)).toBe(true);
    expect(["ECONNREFUSED", "ENOTSOCK", "ENOENT"]).toContain(unreachableCodeOf(caught)!);
  });

  test("没有任何端点 → NO_ENDPOINT", async () => {
    let caught: unknown = null;
    try {
      await instanceFetch({}, "/healthz");
    } catch (err) {
      caught = err;
    }
    expect(unreachableCodeOf(caught)).toBe("NO_ENDPOINT");
  });

  test("目标写法：path 与绝对 URL 等价；unix 判定只看 socket", () => {
    expect(instanceRequestPath("/api/who?x=1")).toBe("/api/who?x=1");
    expect(instanceRequestPath("http://127.0.0.1:13679/api/who?a=1")).toBe("/api/who?a=1");
    // 绝对 URL 只取 pathname+search（前缀由调用方自己剥，helper 不改写路径语义）。
    expect(instanceRequestPath("http://127.0.0.1:13679/i/board/api/who")).toBe("/i/board/api/who");
    expect(instanceUsesUnix({ unix: "/tmp/x.sock" })).toBe(true);
    expect(instanceUsesUnix({ unix: "  " })).toBe(false);
    expect(instanceUsesUnix({ unix: null })).toBe(false);
  });
});

describe("server.json 契约（port|null + unix）", () => {
  function writeInfo(dataDir: string, info: Record<string, unknown>): void {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(serverInfoPath(dataDir), JSON.stringify(info, null, 2));
  }
  const base = {
    pid: 123,
    url: "http://127.0.0.1:13679/i/board/",
    startedAt: 1,
    dataDir: "/tmp/board",
    instanceId: "abc",
    version: "0.7.0",
    host: "127.0.0.1",
    envFiles: [],
    openMode: false,
  };

  test("新形态：port=null + unix 有效", () => {
    const dir = tempDir("stoa-json-");
    writeInfo(dir, { ...base, port: null, unix: "/tmp/sockets/svc-x.sock" });
    const info = readServerInfo(dir) as ServerInfo;
    expect(info.port).toBeNull();
    expect(info.unix).toBe("/tmp/sockets/svc-x.sock");
  });

  test("旧形态：只有 port（无 unix）继续有效", () => {
    const dir = tempDir("stoa-json-");
    writeInfo(dir, { ...base, port: 13684, url: "http://127.0.0.1:13684" });
    const info = readServerInfo(dir) as ServerInfo;
    expect(info.port).toBe(13684);
    expect(info.unix ?? null).toBeNull();
  });

  test("port 与 unix 都缺失 → 视为无效（旧脏文件不冒充实例）", () => {
    const dir = tempDir("stoa-json-");
    writeInfo(dir, { ...base, port: null });
    expect(readServerInfo(dir)).toBeNull();
  });
});

describe("socket 规划（目录 0700 + 超长 fallback）", () => {
  test("短路径：建 0700 父目录并原样返回", () => {
    const dir = tempDir("stoa-sock-plan-");
    const requested = join(dir, "sockets", "svc-1.sock");
    const chosen = prepareSocketPath(requested);
    expect(chosen).toBe(requested);
    const mode = statSync(join(dir, "sockets")).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("超长路径（>90）fallback 到 tmpdir 短目录，名字保持稳定", () => {
    const dir = tempDir("stoa-sock-plan-");
    const long = join(dir, "a".repeat(60), "b".repeat(40), "svc-long.sock");
    expect(long.length).toBeGreaterThan(SOCKET_PATH_SOFT_LIMIT);
    const chosen = prepareSocketPath(long);
    expect(chosen).not.toBe(long);
    expect(chosen.length).toBeLessThanOrEqual(SOCKET_PATH_SOFT_LIMIT);
    expect(chosen.startsWith(dir)).toBe(false);
    expect(chosen.endsWith("svc-long.sock")).toBe(true);
    expect(prepareSocketPath(long)).toBe(chosen);
    expect(existsSync(resolve(chosen, ".."))).toBe(true);
  });

  test("removeSocketFile 幂等", () => {
    const dir = tempDir("stoa-sock-plan-");
    const file = join(dir, "x.sock");
    writeFileSync(file, "");
    removeSocketFile(file);
    expect(existsSync(file)).toBe(false);
    removeSocketFile(file);
    removeSocketFile(null);
  });
});

describe("跨 runtime（bun / node）一致性", () => {
  const nodeBin = Bun.which("node");
  test.skipIf(!nodeBin)("同一 instanceFetch 在 node 下对同一 UDS 返回 200 + 实例 JSON", async () => {
    const dir = tempDir("stoa-uds-");
    const { socketPath } = startUnixInstance(dir);
    const clientPath = resolve(import.meta.dir, "../src/server/instance-client.ts");
    const scriptPath = join(dir, "node-client.mjs");
    writeFileSync(
      scriptPath,
      [
        `import { instanceFetch } from ${JSON.stringify(clientPath)};`,
        `const res = await instanceFetch({ unix: process.argv[2] }, "/healthz");`,
        `const body = await res.json();`,
        `process.stdout.write(JSON.stringify({ status: res.status, body }));`,
        "",
      ].join("\n"),
    );
    const proc = Bun.spawn([nodeBin!, scriptPath, socketPath], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(stderr).not.toContain("Error");
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as {
      status: number;
      body: { ok: boolean; dataDir: string; instanceId: string; port: number | null };
    };
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      ok: true,
      dataDir: "/tmp/board",
      instanceId: "abc123",
      port: null,
    });
  }, 20_000);
});
