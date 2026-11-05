import type { Context } from "hono";
import { LiveEnv, type LoadedEnv } from "../core/env.ts";
import {
  DEFAULT_ACCESS_TTL_MS,
  deriveSigningKey,
  isAccessTokenLike,
  maskSecret,
  randomToken,
  sha256Hex,
  signAccessToken,
  verifyAccessToken,
  constantTimeEqual,
} from "../core/auth.ts";
import type { Account } from "../core/types.ts";
import { get, run } from "./db.ts";
import type { Store } from "./store.ts";

export type AuthMode = "open" | "auth";

export interface RequestIdentity {
  account: Account;
  via: "declared" | "access-token" | "account-token";
}

export interface AuthStatus {
  mode: AuthMode;
  auth_enabled: boolean;
  auth_value_masked: string;
  env_files_loaded: string[];
  env_files_missing: string[];
  access_token_ttl_ms: number;
  account_token_note: string;
  open_mode_warning: string | null;
}

const TICKET_TTL_MS = 60_000;

/**
 * Binary auth switch with live re-read (≤1s cache). `FDE2E_REPORT_AUTH` and the
 * per-account token files are independent credentials:
 *  - changing A invalidates access tokens (signing key derives from A)
 *  - account tokens only rotate via `accounts rotate`
 */
export class AuthManager {
  readonly store: Store;
  readonly secretSalt: string;
  private readonly env: LiveEnv;
  private readonly ttlMs: number;

  constructor(opts: {
    store: Store;
    envFiles: string[];
    secretSalt: string;
    ttlMs?: number;
    envTtlMs?: number;
    processEnv?: Record<string, string | undefined>;
  }) {
    this.store = opts.store;
    this.secretSalt = opts.secretSalt;
    this.ttlMs = opts.ttlMs ?? DEFAULT_ACCESS_TTL_MS;
    this.env = new LiveEnv(opts.envFiles, { ttlMs: opts.envTtlMs ?? 1000, processEnv: opts.processEnv });
  }

  current(): { mode: AuthMode; authValue: string; env: LoadedEnv } {
    const env = this.env.read();
    const authValue = env.values.FDE2E_REPORT_AUTH ?? "";
    return { mode: authValue ? "auth" : "open", authValue, env };
  }

  status(openExposed = false): AuthStatus {
    const { mode, authValue, env } = this.current();
    return {
      mode,
      auth_enabled: mode === "auth",
      auth_value_masked: maskSecret(authValue),
      env_files_loaded: env.loaded,
      env_files_missing: env.missing,
      access_token_ttl_ms: this.ttlMs,
      account_token_note:
        "account tokens rotate only via `accounts rotate <id>|--all`; changing FDE2E_REPORT_AUTH does not revoke them",
      open_mode_warning:
        mode === "open"
          ? openExposed
            ? "OPEN MODE: exposed without authentication (--allow-open-expose)"
            : "open mode: identity is declared by the caller; loopback only is safe"
          : null,
    };
  }

  verifyLogin(secret: string): boolean {
    const { mode, authValue } = this.current();
    if (mode !== "auth") return false;
    return constantTimeEqual(secret, authValue);
  }

  issueAccessToken(sub: string): { token: string; exp: number } {
    const { authValue } = this.current();
    if (!authValue) throw new Error("auth is disabled");
    return signAccessToken({
      secretSalt: this.secretSalt,
      authValue,
      sub,
      ttlMs: this.ttlMs,
    });
  }

  /** Resolve identity for a request. Returns null when credentials are invalid. */
  resolve(req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  }): RequestIdentity | null {
    const { mode, authValue } = this.current();
    if (mode === "open") {
      const declared =
        req.header("x-report-account")?.trim() || req.query("as")?.trim() || "owner";
      const account = this.store.getAccount(declared);
      if (!account || account.disabled !== 0) return null;
      return { account, via: "declared" };
    }
    const raw = req.header("authorization") ?? "";
    if (!raw.toLowerCase().startsWith("bearer ")) return null;
    const token = raw.slice(7).trim();
    if (!token) return null;
    if (isAccessTokenLike(token)) {
      const payload = verifyAccessToken({
        secretSalt: this.secretSalt,
        authValue,
        token,
      });
      if (!payload) return null;
      const account = this.store.getAccount(payload.sub);
      if (!account || account.disabled !== 0) return null;
      return { account, via: "access-token" };
    }
    const account = this.store.getAccountByTokenHash(sha256Hex(token));
    if (!account) return null;
    return { account, via: "account-token" };
  }

  signingKeyFingerprint(): string {
    const { authValue } = this.current();
    return deriveSigningKey(this.secretSalt, authValue).toString("hex").slice(0, 12);
  }

  issueTicket(accountId: string, now = Date.now()): { ticket: string; expiresAt: number } {
    const ticket = randomToken();
    const expiresAt = now + TICKET_TTL_MS;
    run(
      this.store.db,
      "DELETE FROM stream_tickets WHERE expires_at <= ? OR used = 1",
      now - 60_000,
    );
    run(
      this.store.db,
      "INSERT INTO stream_tickets(nonce, account_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)",
      ticket,
      accountId,
      expiresAt,
      now,
    );
    return { ticket, expiresAt };
  }

  consumeTicket(ticket: string, now = Date.now()): Account | null {
    if (!ticket) return null;
    const row = get<{ account_id: string }>(
      this.store.db,
      `UPDATE stream_tickets SET used = 1
       WHERE nonce = ? AND used = 0 AND expires_at > ?
       RETURNING account_id`,
      ticket,
      now,
    );
    if (!row) return null;
    const account = this.store.getAccount(row.account_id);
    if (!account || account.disabled !== 0) return null;
    return account;
  }
}

export function headerOrQuery(c: Context, name: string): string | undefined {
  return c.req.header(name) ?? c.req.query(name);
}
