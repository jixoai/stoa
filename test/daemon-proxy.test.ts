/**
 * daemon 反向代理语义（daemon-unified-port design §3，P1）：
 *   - GET/HEAD 不传 body；POST/上传原样转发；
 *   - 请求头：删 hop-by-hop → 删客户端自带 `x-stoa-service`/`x-stoa-daemon-proxy`/`cookie`
 *     → 注入 `x-stoa-service:<slug>`、`x-stoa-daemon-proxy:<serviceId>`；不注入 `x-forwarded-*`；
 *     `authorization`/`x-report-account` 在 P1 透传（凭据注入是 P2/S3-4）；
 *   - 响应：删 `content-encoding`/`content-length` 与 hop-by-hop；**不注入 CORS**；
 *   - SSE 逐块不缓冲；hub 503 原样；普通请求超时 → 502；实例不可达 → 502 + 可读原因。
 *
 * 全部在 mkdtemp 状态目录 + 真实 UDS 上游上跑；不碰既有 daemon/端口。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonRouter, PROXY_TIMEOUT_MS } from "../src/daemon/router.ts";
import { writeServices, type ServiceRecord } from "../src/daemon/state.ts";

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

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** 上游桩：记录最后一次请求（含头与 body），并按路径返回不同响应。 */
function startUpstream(dir: string): { socketPath: string; last: () => Seen | null } {
  const socketPath = join(dir, "up.sock");
  let last: Seen | null = null;
  const server = Bun.serve({
    unix: socketPath,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      last = {
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(req.headers),
        body,
      };
      switch (url.pathname) {
        case "/echo":
          return Response.json({ ok: true, method: req.method, length: body.length });
        case "/compressed":
          // 上游自称 gzip/定长（模拟不当压缩/头与体不一致）：代理必须删这两个头。
          return new Response("hello", {
            status: 200,
            headers: { "content-encoding": "gzip", "content-length": "5" },
          });
        case "/nocontent":
          return new Response(null, { status: 205 });
        case "/range":
          return new Response("part", {
            status: 206,
            headers: { "content-range": "bytes 0-3/10", "accept-ranges": "bytes" },
          });
        case "/busy":
          // hub 连接上限：503 必须原样透传，不能被改写成 502。
          return Response.json({ ok: false, error: "hub is at capacity" }, { status: 503 });
        case "/sse": {
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
          return new Response(stream, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          });
        }
        case "/slow":
          await new Promise((resolve) => setTimeout(resolve, 700));
          return Response.json({ ok: true, slow: true });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  servers.push(server);
  return { socketPath, last: () => last };
}

function seed(socketPath: string, overrides: Partial<ServiceRecord> = {}): string {
  const stateDir = tempDir("stoa-proxy-state-");
  writeServices(stateDir, [
    {
      id: "svc-proxy",
      name: "board",
      slug: "board",
      hostnames: [],
      dataDir: "/tmp/board",
      port: null,
      pid: null,
      url: "http://127.0.0.1:13679/i/board/",
      socket: socketPath,
      authAccount: "owner",
      log: null,
      startedAt: 1,
      status: "running",
      ...overrides,
    },
  ]);
  return stateDir;
}

/** 反代语义测试只看代理层：路由门由 daemon-gate.test.ts 单独覆盖（这里恒登录）。 */
const authenticated = { authenticated: () => true };

function routerFor(stateDir: string, timeoutMs?: number) {
  return createDaemonRouter({
    stateDir,
    daemonHosts: ["127.0.0.1"],
    appFetch: () => Response.json({ daemon: true }),
    auth: authenticated,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const BASE = "http://127.0.0.1:13679/i/board";

describe("请求语义", () => {
  test("GET 不传 body；POST body 完整转发（含 2 MiB）", async () => {
    const dir = tempDir("stoa-proxy-");
    const { socketPath, last } = startUpstream(dir);
    const route = routerFor(seed(socketPath));

    const got = await route(new Request(`${BASE}/echo`));
    expect((await got.json()) as { ok: boolean; method: string; length: number }).toMatchObject({
      ok: true,
      method: "GET",
      length: 0,
    });
    expect(last()!.method).toBe("GET");
    expect(last()!.body).toBe("");
    expect(last()!.headers["content-length"]).toBeUndefined();

    const head = await route(new Request(`${BASE}/echo`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    // HEAD 不发 body（Response body 必须是 null）
    expect(head.body).toBeNull();
    expect(last()!.method).toBe("HEAD");
    expect(last()!.body).toBe("");

    const payload = JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) });
    const posted = await route(
      new Request(`${BASE}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
    );
    expect(
      (await posted.json()) as { ok: boolean; method: string; length: number },
    ).toMatchObject({
      ok: true,
      method: "POST",
      length: payload.length,
    });
    expect(last()!.body).toBe(payload);
    expect(last()!.headers["content-type"]).toBe("application/json");
  });

  test("头语义：hop-by-hop 删除、代理标记覆盖、cookie 删除、客户端凭据头被丢弃（S3-4 覆盖）", async () => {
    const dir = tempDir("stoa-proxy-");
    const { socketPath, last } = startUpstream(dir);
    const route = routerFor(seed(socketPath));

    await route(
      new Request(`${BASE}/echo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          te: "trailers",
          trailer: "x-checksum",
          "proxy-authorization": "Basic abc",
          upgrade: "h2c",
          // 客户端冒充：必须被覆盖
          "x-stoa-service": "evil",
          "x-stoa-daemon-proxy": "svc-evil",
          // daemon 会话 cookie 不得泄漏给实例
          cookie: "stoa_daemon=session-id-1",
          // 伪造的实例凭据：daemon 一律删除后按服务记录注入（防身份冒充）
          authorization: "Bearer forged-instance-token",
          "x-report-account": "intruder",
        },
        body: "{}",
      }),
    );

    const seen = last()!;
    // 客户端自带的 hop-by-hop 一律不落地（connection/transfer-encoding 是 node:http
    // 为「本跳」自己生成的，属于每跳合法语义，不在删除清单里）。
    for (const name of [
      "keep-alive",
      "te",
      "trailer",
      "proxy-authorization",
      "upgrade",
      "cookie",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
    ]) {
      expect(seen.headers[name]).toBeUndefined();
    }
    expect(seen.headers.connection === undefined || seen.headers.connection === "keep-alive").toBe(
      true,
    );
    expect(seen.headers["x-stoa-service"]).toBe("board");
    expect(seen.headers["x-stoa-daemon-proxy"]).toBe("svc-proxy");
    // 该实例目录没有 accounts/owner.env → open 模式：只注入 x-report-account=owner，
    // 客户端伪造的 Bearer 不落地（auth 模式的 Bearer 注入见 daemon-inject.test.ts）。
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers["x-report-account"]).toBe("owner");
  });
});

describe("响应语义", () => {
  test("删 content-encoding/content-length；不注入 CORS；status 透传", async () => {
    const dir = tempDir("stoa-proxy-");
    const { socketPath } = startUpstream(dir);
    const route = routerFor(seed(socketPath));

    const compressed = await route(new Request(`${BASE}/compressed`));
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get("content-encoding")).toBeNull();
    expect(compressed.headers.get("content-length")).toBeNull();
    expect(compressed.headers.get("access-control-allow-origin")).toBeNull();
    expect(await compressed.text()).toBe("hello");

    const busy = await route(new Request(`${BASE}/busy`));
    expect(busy.status).toBe(503);
    expect((await busy.json()) as { ok: boolean; error: string }).toMatchObject({
      ok: false,
      error: "hub is at capacity",
    });
  });

  test("205 的响应 body 为 null（Node 对带 body 的 204/205 抛 TypeError）", async () => {
    const dir = tempDir("stoa-proxy-");
    const { socketPath } = startUpstream(dir);
    const route = routerFor(seed(socketPath));
    const res = await route(new Request(`${BASE}/nocontent`));
    expect(res.status).toBe(205);
    expect(res.body).toBeNull();
  });

  test("Range：上游 206 与 content-range 原样透传（不额外破坏）", async () => {
    const dir = tempDir("stoa-proxy-");
    const { socketPath } = startUpstream(dir);
    const route = routerFor(seed(socketPath));
    const res = await route(new Request(`${BASE}/range`, { headers: { range: "bytes=0-3" } }));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("part");
  });

  test("SSE 逐块透传（不缓冲）：三块时间戳拉开", async () => {
    const dir = tempDir("stoa-proxy-");
    const { socketPath } = startUpstream(dir);
    const route = routerFor(seed(socketPath));
    const res = await route(
      new Request(`${BASE}/sse`, { headers: { accept: "text/event-stream" } }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const stamps: number[] = [];
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stamps.push(Date.now());
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain("data: 2");
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    expect(stamps.at(-1)! - stamps[0]!).toBeGreaterThanOrEqual(150);
  });
});

describe("超时与不可达", () => {
  test("普通请求受超时约束 → 502；SSE 不受该超时约束", async () => {
    expect(PROXY_TIMEOUT_MS).toBe(60_000);
    const dir = tempDir("stoa-proxy-");
    const { socketPath } = startUpstream(dir);
    const route = routerFor(seed(socketPath), 300);

    const slow = await route(new Request(`${BASE}/slow`));
    expect(slow.status).toBe(502);
    const slowBody = (await slow.json()) as { code: string; error: string };
    expect(slowBody.code).toBe("INSTANCE_UNREACHABLE");

    // SSE 明确豁免：同样的 300ms 预算下流式请求完整跑完（约 360ms）。
    const sse = await route(
      new Request(`${BASE}/sse`, { headers: { accept: "text/event-stream" } }),
    );
    expect(sse.status).toBe(200);
    expect(await sse.text()).toContain("data: 2");
  });

  test("socket 不可达 → 502 + 可读原因（实例名/slug/重启指引），不回落控制台", async () => {
    const dir = tempDir("stoa-proxy-");
    const missing = join(dir, "gone.sock");
    const route = routerFor(seed(missing));
    const res = await route(new Request(`${BASE}/api/who`));
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: boolean;
      code: string;
      error: string;
      service: { slug: string; status: string };
    };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("INSTANCE_UNREACHABLE");
    expect(body.error).toContain("board");
    expect(body.error).toContain("不可达");
    expect(body.error).toContain("stoa serve");
    expect(body.service.slug).toBe("board");
  });

  test("停用的登记（socket=null、无 TCP 端口）→ 502 NO_ENDPOINT，绝不拨回 daemon 自己", async () => {
    const stateDir = seed("");
    const route = routerFor(stateDir);
    const res = await route(new Request(`${BASE}/healthz`));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("INSTANCE_UNREACHABLE");
    expect(body.error).toContain("neither unix socket");
  });
});
