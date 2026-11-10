import type { Server } from "bun";
import { connect } from "node:net";
import { fail } from "../core/errors.ts";
import { PORT_MAX, PORT_MIN } from "../core/protocol.ts";

export function isPortInWorkerRange(port: number): boolean {
  return Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX;
}

export function assertPortInRange(port: number): number {
  if (!isPortInWorkerRange(port)) {
    fail(
      "BAD_REQUEST",
      `port ${port} is outside the worker range ${PORT_MIN}-${PORT_MAX} ` +
        `(worker series reserves this narrow range; see AGENTS.md)`,
    );
  }
  return port;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

/**
 * 随机池排除本部署的正式端口：正式实例始终以显式 `--port 13689` 启动，
 * 未指定端口的开发/测试实例不得抢占它（2026-11-08 实证：测试实例短暂"偷走"
 * 13689 的连接，订阅端读到陌生 dataDir）。
 */
export const RANDOM_EXCLUDED_PORTS: ReadonlySet<number> = new Set([13689]);

export function shuffledPorts(): number[] {
  const ports: number[] = [];
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!RANDOM_EXCLUDED_PORTS.has(p)) ports.push(p);
  }
  for (let i = ports.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ports[i], ports[j]] = [ports[j]!, ports[i]!];
  }
  return ports;
}

/**
 * 端口占用探测（TCP 连接）：本机实测 Bun 允许两个进程 bind 同一回环端口（后 bind 者接走连接），
 * 所以「绑定抛错」不能当作占用判定；随机挑端口前必须先 connect 探一下。
 * 连接成功或超时都按「占用」处理（保守）；ECONNREFUSED 才是空闲。
 */
export async function portIsListening(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(code !== "ECONNREFUSED" && code !== "ECONNRESET" ? true : false);
    });
  });
}

export interface ListenOptions {
  host: string;
  port?: number | null;
  fetch: (req: Request) => Response | Promise<Response>;
  idleTimeout?: number;
}

export interface ListenResult {
  server: Server<undefined>;
  port: number;
  host: string;
}

function isAddrInUse(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "EADDRINUSE" || /in use/i.test(String(err));
}

/**
 * Bind loopback on a random free port from the 13680-13699 range, or on the
 * explicitly requested port (which must be inside the range).
 */
export async function listenInRange(opts: ListenOptions): Promise<ListenResult> {
  const candidates = opts.port ? [assertPortInRange(opts.port)] : shuffledPorts();
  let lastError: unknown = null;
  for (const port of candidates) {
    if (await portIsListening(opts.host, port)) {
      // 本机 Bun 对已占用端口不抛错（会静默共享）——必须先探测，别抢别人的端口。
      if (opts.port) {
        fail("CONFLICT", `port ${opts.port} is already in use`);
      }
      lastError = new Error(`port ${port} is already in use`);
      continue;
    }
    try {
      const server = Bun.serve({
        hostname: opts.host,
        port,
        fetch: opts.fetch,
        idleTimeout: opts.idleTimeout ?? 60,
        development: false,
      });
      return { server, port: server.port ?? port, host: opts.host };
    } catch (err) {
      lastError = err;
      if (!isAddrInUse(err)) throw err;
      if (opts.port) {
        fail("CONFLICT", `port ${opts.port} is already in use`);
      }
    }
  }
  fail(
    "UNAVAILABLE",
    `no free port in ${PORT_MIN}-${PORT_MAX}: ${(lastError as Error)?.message ?? "all busy"}`,
  );
}
