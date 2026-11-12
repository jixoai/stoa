/**
 * daemon 单测（stoa-daemon design §5）：状态读写/端口校验/HTTP 客户端。
 * 不启动真实 daemon 进程（那是 daemon-integration.test.ts 的事）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { daemonRequest, probeDaemon } from "../src/daemon/client.ts";
import {
  DAEMON_DEFAULT_PORT,
  assertDaemonPort,
  daemonLogPath,
  daemonPortCandidates,
  defaultDaemonStateDir,
  findServiceByDataDir,
  readDaemonInfo,
  readServices,
  removeDaemonInfo,
  removeService,
  resolveDaemonStateDir,
  sameDataDir,
  serviceLogPath,
  tailFile,
  upsertService,
  writeDaemonInfo,
  writeServices,
  type ServiceRecord,
} from "../src/daemon/state.ts";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "stoa-daemon-unit-"));
}

function record(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id: "svc-test01",
    name: "board",
    slug: "board",
    hostnames: [],
    dataDir: "/tmp/board-a",
    port: 13690,
    pid: 4242,
    url: "http://127.0.0.1:13690",
    log: null,
    startedAt: 1_700_000_000_000,
    status: "running",
    ...overrides,
  };
}

describe("state dir resolution", () => {
  test("flag wins, then env, then the ~/.local/state default", () => {
    expect(
      resolveDaemonStateDir({ flag: "/x/state", env: { STOA_DAEMON_STATE_DIR: "/y" }, cwd: "/" }),
    ).toBe(resolve("/x/state"));
    expect(resolveDaemonStateDir({ env: { STOA_DAEMON_STATE_DIR: "/y" }, cwd: "/" })).toBe(
      resolve("/y"),
    );
    expect(resolveDaemonStateDir({ env: {}, home: "/home/tester" })).toBe(
      join("/home/tester", ".local", "state", "stoa", "daemon"),
    );
    expect(defaultDaemonStateDir("/home/tester")).toBe(
      join("/home/tester", ".local", "state", "stoa", "daemon"),
    );
  });

  test("relative paths resolve against cwd", () => {
    expect(resolveDaemonStateDir({ flag: "state", cwd: "/base" })).toBe(resolve("/base/state"));
  });
});

describe("daemon port rules", () => {
  test("default band starts at 13679 and descends", () => {
    const candidates = daemonPortCandidates(null);
    expect(candidates[0]).toBe(DAEMON_DEFAULT_PORT);
    expect(candidates[0]).toBe(13679);
    expect(candidates.at(-1)).toBe(13670);
    expect(candidates).toHaveLength(10);
  });

  test("explicit port is the only candidate", () => {
    expect(daemonPortCandidates(15000)).toEqual([15000]);
  });

  test("assertDaemonPort rejects non-integers, privileged and out-of-range ports", () => {
    expect(assertDaemonPort(13679)).toBe(13679);
    expect(() => assertDaemonPort(80)).toThrow();
    expect(() => assertDaemonPort(70000)).toThrow();
    expect(() => assertDaemonPort(1.5)).toThrow();
  });
});

describe("daemon.json", () => {
  test("write/read roundtrip and removal", () => {
    const stateDir = tempStateDir();
    try {
      expect(readDaemonInfo(stateDir)).toBeNull();
      const info = {
        pid: 123,
        port: 13679,
        url: "http://127.0.0.1:13679",
        stateDir,
        version: "9.9.9",
        startedAt: 42,
      };
      writeDaemonInfo(stateDir, info);
      expect(readDaemonInfo(stateDir)).toEqual(info);
      removeDaemonInfo(stateDir);
      expect(readDaemonInfo(stateDir)).toBeNull();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("corrupt file reads as null instead of throwing", () => {
    const stateDir = tempStateDir();
    try {
      writeFileSync(join(stateDir, "daemon.json"), "{not json");
      expect(readDaemonInfo(stateDir)).toBeNull();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("services registry", () => {
  test("upsert/remove/find/sameDataDir", () => {
    const stateDir = tempStateDir();
    try {
      expect(readServices(stateDir)).toEqual([]);
      upsertService(stateDir, record());
      upsertService(stateDir, record({ id: "svc-test02", dataDir: "/tmp/board-b" }));
      expect(readServices(stateDir)).toHaveLength(2);
      // same id → replace in place
      upsertService(stateDir, record({ name: "board-renamed", status: "stopped" }));
      const list = readServices(stateDir);
      expect(list).toHaveLength(2);
      expect(list[0]!.name).toBe("board-renamed");
      expect(list[0]!.status).toBe("stopped");
      expect(removeService(stateDir, "svc-test02")).toBe(true);
      expect(removeService(stateDir, "svc-test02")).toBe(false);
      expect(readServices(stateDir)).toHaveLength(1);
      expect(findServiceByDataDir(list, "/tmp/board-b")?.id).toBe("svc-test02");
      expect(findServiceByDataDir(list, "/tmp/board-b/")?.id).toBe("svc-test02");
      expect(findServiceByDataDir(list, "/tmp/other")).toBeNull();
      expect(sameDataDir("/tmp/board-b", "/tmp/board-b/")).toBe(true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("unknown shapes are filtered out, not trusted", () => {
    const stateDir = tempStateDir();
    try {
      writeServices(stateDir, [record(), { id: 7 } as unknown as ServiceRecord]);
      expect(readServices(stateDir)).toHaveLength(1);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("log paths live under logs/ and tailFile degrades safely", () => {
    const stateDir = tempStateDir();
    expect(daemonLogPath(stateDir)).toBe(join(stateDir, "logs", "daemon.log"));
    expect(serviceLogPath(stateDir, "svc-x")).toBe(join(stateDir, "logs", "svc-x.log"));
    expect(tailFile(join(stateDir, "nope.log"))).toBe("(no log)");
  });
});

describe("daemon http client", () => {
  test("probeDaemon accepts only daemon healthz bodies", async () => {
    const daemonServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname !== "/healthz") return new Response("nope", { status: 404 });
        return Response.json({
          ok: true,
          daemon: true,
          pid: 1,
          port: 0,
          url: "",
          stateDir: "/tmp/s",
          version: "0.0.0",
          startedAt: 1,
          services: { total: 0, running: 0 },
        });
      },
    });
    const boardish = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ok: true, dataDir: "/tmp/d" }),
    });
    try {
      const health = await probeDaemon(`http://127.0.0.1:${daemonServer.port}`);
      expect(health?.daemon).toBe(true);
      expect(health?.stateDir).toBe("/tmp/s");
      expect(await probeDaemon(`http://127.0.0.1:${boardish.port}`)).toBeNull();
      expect(await probeDaemon("http://127.0.0.1:1")).toBeNull();
    } finally {
      await daemonServer.stop(true);
      await boardish.stop(true);
    }
  });

  test("daemonRequest maps error bodies to thrown errors", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/api/ok") return Response.json({ ok: true, value: 7 });
        return Response.json({ ok: false, code: "BAD_REQUEST", error: "dataDir is required" }, { status: 400 });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect(await daemonRequest<{ ok: boolean; value: number }>(base, "/api/ok")).toEqual({
        ok: true,
        value: 7,
      });
      await expect(daemonRequest(base, "/api/bad")).rejects.toThrow("dataDir is required");
    } finally {
      await server.stop(true);
    }
  });
});
