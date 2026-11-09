import { describe, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountTokenEnvKey,
  constantTimeEqual,
  deriveSigningKey,
  legacyAccountTokenEnvKey,
  maskSecret,
  renderAccountEnvFile,
  sha256Hex,
  signAccessToken,
  verifyAccessToken,
} from "../src/core/auth.ts";
import { parseEnv } from "../src/core/env.ts";
import { AuthManager } from "../src/server/auth.ts";
import { ReportError } from "../src/core/errors.ts";
import {
  assertSafeDataDir,
  discoverServer,
  readServerInfo,
  resolveDataDir,
  writePointer,
  writeServerInfo,
} from "../src/server/discovery.ts";
import { Presence } from "../src/server/presence.ts";
import { startServer } from "../src/server/serve.ts";
import { makeStore, createAgents, initWorkspace, tempDir } from "./helpers.ts";

const T0 = 1_700_000_000_000;
const SECRET = "server-salt";

function writeEnvFile(path: string, values: Record<string, string>): void {
  writeFileSync(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

function fakeRequest(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    query: (name: string) => query[name],
  };
}

describe("access tokens (design §4)", () => {
  test("sign/verify and reject tampered or expired tokens", () => {
    const issued = signAccessToken({
      secretSalt: SECRET,
      authValue: "auth-one",
      sub: "owner",
      now: T0,
      ttlMs: 1000,
    });
    expect(issued.token.startsWith("v1.")).toBe(true);
    expect(
      verifyAccessToken({
        secretSalt: SECRET,
        authValue: "auth-one",
        token: issued.token,
        now: T0 + 10,
      })?.sub,
    ).toBe("owner");
    expect(
      verifyAccessToken({
        secretSalt: SECRET,
        authValue: "auth-one",
        token: issued.token,
        now: T0 + 1000,
      }),
    ).toBeNull();
    const parts = issued.token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}aa`;
    expect(
      verifyAccessToken({
        secretSalt: SECRET,
        authValue: "auth-one",
        token: tampered,
        now: T0,
      }),
    ).toBeNull();
    // changing A changes the derived key -> all access tokens die
    expect(
      verifyAccessToken({
        secretSalt: SECRET,
        authValue: "auth-two",
        token: issued.token,
        now: T0,
      }),
    ).toBeNull();
    expect(deriveSigningKey(SECRET, "a").toString("hex")).not.toBe(
      deriveSigningKey(SECRET, "b").toString("hex"),
    );
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(maskSecret("supersecret")).not.toContain("upersecr");
  });
});

describe("AuthManager (live-read, account tokens, tickets)", () => {
  test("open mode declares identity; auth mode requires credentials", () => {
    const t = makeStore({ clock: () => T0 });
    const dir = tempDir();
    const envPath = join(dir, "no-auth.env");
    writeEnvFile(envPath, { OTHER: "x" });
    try {
      createAgents(t.store, ["a"]);
      const open = new AuthManager({
        store: t.store,
        envFiles: [envPath],
        secretSalt: SECRET,
        envTtlMs: 0,
        processEnv: {},
      });
      expect(open.current().mode).toBe("open");
      expect(open.resolve(fakeRequest({ "x-report-account": "a" }))?.account.id).toBe("a");
      expect(open.resolve(fakeRequest({}, { as: "a" }))?.via).toBe("declared");
      expect(open.resolve(fakeRequest())?.account.id).toBe("owner");
      expect(open.resolve(fakeRequest({ "x-report-account": "ghost" }))).toBeNull();

      const a = t.store.createAccount({ id: "b" });
      const auth = new AuthManager({
        store: t.store,
        envFiles: [envPath],
        secretSalt: SECRET,
        envTtlMs: 0,
        processEnv: {},
      });
      expect(auth.verifyLogin("anything")).toBe(false); // still open
      expect(auth.status().mode).toBe("open");
      void a;
    } finally {
      t.close();
    }
  });

  test("login, access-token auth, account-token auth and changing A", () => {
    const t = makeStore({ clock: () => T0 });
    const dir = tempDir();
    const envPath = join(dir, "auth.env");
    writeEnvFile(envPath, { FDE2E_REPORT_AUTH: "one" });
    try {
      const created = t.store.createAccount({ id: "a" });
      const auth = new AuthManager({
        store: t.store,
        envFiles: [envPath],
        secretSalt: SECRET,
        envTtlMs: 0,
        processEnv: {},
      });
      expect(auth.current().mode).toBe("auth");
      expect(auth.verifyLogin("wrong")).toBe(false);
      expect(auth.verifyLogin("one")).toBe(true);
      const access = auth.issueAccessToken("owner");
      expect(auth.resolve(fakeRequest({ authorization: `Bearer ${access.token}` }))?.account.id).toBe(
        "owner",
      );
      expect(
        auth.resolve(fakeRequest({ authorization: `Bearer ${created.token}` }))?.account.id,
      ).toBe("a");
      expect(auth.resolve(fakeRequest())).toBeNull();
      expect(auth.resolve(fakeRequest({ authorization: "Bearer nope" }))).toBeNull();

      // live re-read: changing A kills access tokens but not account tokens
      writeEnvFile(envPath, { FDE2E_REPORT_AUTH: "two" });
      expect(auth.resolve(fakeRequest({ authorization: `Bearer ${access.token}` }))).toBeNull();
      expect(
        auth.resolve(fakeRequest({ authorization: `Bearer ${created.token}` }))?.account.id,
      ).toBe("a");
      expect(auth.verifyLogin("one")).toBe(false);
      expect(auth.verifyLogin("two")).toBe(true);

      // rotation kills the old account token too
      const rotated = t.store.rotateAccount("a");
      expect(auth.resolve(fakeRequest({ authorization: `Bearer ${created.token}` }))).toBeNull();
      expect(auth.resolve(fakeRequest({ authorization: `Bearer ${rotated.token}` }))?.account.id).toBe(
        "a",
      );
    } finally {
      t.close();
    }
  });

  test("stream tickets are one-time and expire after 60s", () => {
    const t = makeStore({ clock: () => T0 });
    const dir = tempDir();
    const envPath = join(dir, "auth.env");
    writeEnvFile(envPath, { FDE2E_REPORT_AUTH: "one" });
    try {
      const created = t.store.createAccount({ id: "a" });
      void created;
      const auth = new AuthManager({
        store: t.store,
        envFiles: [envPath],
        secretSalt: SECRET,
        envTtlMs: 0,
        processEnv: {},
      });
      const ticket = auth.issueTicket("a", T0);
      expect(auth.consumeTicket(ticket.ticket, T0 + 1000)?.id).toBe("a");
      expect(auth.consumeTicket(ticket.ticket, T0 + 2000)).toBeNull(); // used
      const other = auth.issueTicket("a", T0);
      expect(auth.consumeTicket(other.ticket, T0 + 61_000)).toBeNull(); // expired
    } finally {
      t.close();
    }
  });
});

describe("presence + service discovery", () => {
  test("presence keeps agents online for the 90s grace window", () => {
    const presence = new Presence(90_000);
    const release = presence.connect("a");
    expect(presence.isOnline("a")).toBe(true);
    expect(presence.connectionCount("a")).toBe(1);
    release();
    expect(presence.connectionCount("a")).toBe(0);
    const seen = presence.lastSeenOf("a")!;
    expect(presence.isOnline("a", seen + 89_000)).toBe(true);
    expect(presence.isOnline("a", seen + 91_000)).toBe(false);
    // idempotent release must not go negative
    release();
    expect(presence.connectionCount("a")).toBe(0);
  });

  test("stale server.json is rejected after healthz probing", async () => {
    const dir = tempDir();
    writeServerInfo(dir, {
      port: 1,
      pid: 999999,
      url: "http://127.0.0.1:1",
      startedAt: 0,
      dataDir: dir,
      instanceId: "dead",
      version: "0.1.0",
      host: "127.0.0.1",
      envFiles: [],
      openMode: true,
    });
    expect(readServerInfo(dir)?.instanceId).toBe("dead");
    await expect(discoverServer(dir, 300)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  test("data dir resolution falls back to the project pointer file", () => {
    const cwd = tempDir();
    const data = join(cwd, "data");
    mkdirSync(data);
    writePointer(cwd, data);
    expect(resolveDataDir({ cwd, env: {} })).toBe(data);
    expect(() => resolveDataDir({ cwd: tempDir(), env: {} })).toThrow(ReportError);
  });
});

describe("security gates (design §19)", () => {
  test("init refuses to re-initialize and writes 0600 credentials", () => {
    const workspace = initWorkspace();
    try {
      const mode = (path: string) => statSync(path).mode & 0o777;
      expect(mode(join(workspace.dataDir, ".env"))).toBe(0o600);
      expect(mode(join(workspace.dataDir, "accounts", "owner.env"))).toBe(0o600);
      const again = Bun.spawnSync({
        cmd: [process.execPath, join(import.meta.dir, "..", "src/cli/main.ts"), "init", "--data-dir", workspace.dataDir],
        cwd: workspace.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(again.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(again.stderr)).toContain("already initialized");
    } finally {
      workspace.cleanup();
    }
  });

  test("refuses data dirs inside .agents/reports", () => {
    expect(() => assertSafeDataDir("/tmp/ws/.agents/reports/session", { env: {} })).toThrow(
      ReportError,
    );
    expect(() => assertSafeDataDir("/tmp/ws/.agents/reports", { env: {} })).toThrow(ReportError);
    expect(assertSafeDataDir("/tmp/ws/.agents/workers/report/s1", { env: {} })).toBe(
      "/tmp/ws/.agents/workers/report/s1",
    );
  });

  test("refuses configured public roots", () => {
    expect(() =>
      assertSafeDataDir("/srv/static/report", {
        env: { FDE2E_REPORT_PUBLIC_ROOTS: "/srv/static" },
      }),
    ).toThrow(ReportError);
  });

  test("fail-closed when exposed without authentication unless explicitly allowed", async () => {
    const workspace = initWorkspace({ open: true });
    try {
      await expect(
        startServer({
          dataDir: workspace.dataDir,
          host: "0.0.0.0",
          envFiles: workspace.envFiles,
          processEnv: {},
          quiet: true,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // explicit override starts, but flags OPEN MODE
      const running = await startServer({
        dataDir: workspace.dataDir,
        host: "127.0.0.1",
        expose: true,
        allowOpenExpose: true,
        envFiles: workspace.envFiles,
        processEnv: {},
        quiet: true,
      });
      try {
        expect(running.banner).toContain("OPEN MODE");
      } finally {
        await running.close();
      }
    } finally {
      workspace.cleanup();
    }
  });

  test("one server per data dir (lock)", async () => {
    const workspace = initWorkspace({ open: true });
    try {
      const first = await startServer({
        dataDir: workspace.dataDir,
        envFiles: workspace.envFiles,
        processEnv: {},
        quiet: true,
      });
      try {
        await expect(
          startServer({
            dataDir: workspace.dataDir,
            envFiles: workspace.envFiles,
            processEnv: {},
            quiet: true,
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      } finally {
        await first.close();
      }
    } finally {
      workspace.cleanup();
    }
  });
});

describe("env double read (stoa-identity §3)", () => {
  test("account token keys: STOA_TOKEN_* preferred, legacy FDE2E_REPORT_TOKEN_* still read", () => {
    expect(accountTokenEnvKey("sub-a")).toBe("STOA_TOKEN_SUB_A");
    expect(legacyAccountTokenEnvKey("sub-a")).toBe("FDE2E_REPORT_TOKEN_SUB_A");
  });

  test("rendered account env file carries the new key and a legacy alias (plugin compat)", () => {
    const rendered = renderAccountEnvFile("sub-a", "tok-123");
    const values = parseEnv(rendered);
    expect(values.STOA_ACCOUNT).toBe("sub-a");
    expect(values[accountTokenEnvKey("sub-a")]).toBe("tok-123");
    expect(values[legacyAccountTokenEnvKey("sub-a")]).toBe("tok-123");
  });

  test("AuthManager: STOA_AUTH wins over the legacy key; legacy alone still enables auth", () => {
    const t = makeStore({ clock: () => T0 });
    const dir = tempDir();
    const both = join(dir, "both.env");
    const legacyOnly = join(dir, "legacy.env");
    const stoaOnly = join(dir, "stoa.env");
    const empty = join(dir, "empty.env");
    writeEnvFile(both, { STOA_AUTH: "new", FDE2E_REPORT_AUTH: "old" });
    writeEnvFile(legacyOnly, { FDE2E_REPORT_AUTH: "old" });
    writeEnvFile(stoaOnly, { STOA_AUTH: "new" });
    writeEnvFile(empty, { STOA_AUTH: "", FDE2E_REPORT_AUTH: "" });
    try {
      const mk = (envPath: string) =>
        new AuthManager({
          store: t.store,
          envFiles: [envPath],
          secretSalt: SECRET,
          envTtlMs: 0,
          processEnv: {},
        });
      const bothAuth = mk(both);
      expect(bothAuth.current().mode).toBe("auth");
      expect(bothAuth.verifyLogin("new")).toBe(true);
      expect(bothAuth.verifyLogin("old")).toBe(false);
      const legacyAuth = mk(legacyOnly);
      expect(legacyAuth.current().mode).toBe("auth");
      expect(legacyAuth.verifyLogin("old")).toBe(true);
      const stoaAuth = mk(stoaOnly);
      expect(stoaAuth.current().mode).toBe("auth");
      expect(stoaAuth.verifyLogin("new")).toBe(true);
      const emptyAuth = mk(empty);
      expect(emptyAuth.current().mode).toBe("open");
    } finally {
      t.close();
    }
  });

  test("STOA_DATA_DIR / STOA_PUBLIC_ROOTS double read (legacy still read, new wins)", () => {
    expect(
      resolveDataDir({ cwd: "/tmp", env: { STOA_DATA_DIR: "/data/new" }, allowPointer: false }),
    ).toBe("/data/new");
    expect(
      resolveDataDir({
        cwd: "/tmp",
        env: { FDE2E_REPORT_DATA_DIR: "/data/old" },
        allowPointer: false,
      }),
    ).toBe("/data/old");
    expect(
      resolveDataDir({
        cwd: "/tmp",
        env: { STOA_DATA_DIR: "/data/new", FDE2E_REPORT_DATA_DIR: "/data/old" },
        allowPointer: false,
      }),
    ).toBe("/data/new");
    expect(() =>
      assertSafeDataDir("/srv/static/report", { env: { STOA_PUBLIC_ROOTS: "/srv/static" } }),
    ).toThrow(ReportError);
    expect(() =>
      assertSafeDataDir("/srv/static/report", { env: { FDE2E_REPORT_PUBLIC_ROOTS: "/srv/static" } }),
    ).toThrow(ReportError);
  });
});
