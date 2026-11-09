import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { LEGACY_ENV_PREFIX } from "./env.ts";

/** Preferred per-account token key prefix: `STOA_TOKEN_<ACCOUNT>`. */
export const ACCOUNT_TOKEN_ENV_PREFIX = "STOA_TOKEN_";
export const ACCESS_TOKEN_PREFIX = "v1";
export const DEFAULT_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Constant-time string comparison (hashes both sides so length never leaks). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Signing key derived from the live auth value: changing A invalidates all access tokens. */
export function deriveSigningKey(secretSalt: string, authValue: string): Buffer {
  return createHmac("sha256", secretSalt).update(authValue, "utf8").digest();
}

interface AccessPayload {
  sub: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signAccessToken(opts: {
  secretSalt: string;
  authValue: string;
  sub: string;
  ttlMs?: number;
  now?: number;
}): { token: string; exp: number } {
  const now = opts.now ?? Date.now();
  const exp = now + (opts.ttlMs ?? DEFAULT_ACCESS_TTL_MS);
  const payload: AccessPayload = { sub: opts.sub, iat: now, exp };
  const payloadPart = b64url(JSON.stringify(payload));
  const signingInput = `${ACCESS_TOKEN_PREFIX}.${payloadPart}`;
  const key = deriveSigningKey(opts.secretSalt, opts.authValue);
  const sig = createHmac("sha256", key).update(signingInput).digest("base64url");
  return { token: `${signingInput}.${sig}`, exp };
}

export function verifyAccessToken(opts: {
  secretSalt: string;
  authValue: string;
  token: string;
  now?: number;
}): AccessPayload | null {
  const parts = opts.token.split(".");
  if (parts.length !== 3) return null;
  const [prefix, payloadPart, sig] = parts as [string, string, string];
  if (prefix !== ACCESS_TOKEN_PREFIX) return null;
  const key = deriveSigningKey(opts.secretSalt, opts.authValue);
  const expected = createHmac("sha256", key)
    .update(`${prefix}.${payloadPart}`)
    .digest("base64url");
  if (!constantTimeEqual(sig, expected)) return null;
  let payload: AccessPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload.sub !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if ((opts.now ?? Date.now()) >= payload.exp) return null;
  return payload;
}

export function isAccessTokenLike(token: string): boolean {
  return token.startsWith(`${ACCESS_TOKEN_PREFIX}.`);
}

export function accountTokenEnvKey(accountId: string): string {
  return `${ACCOUNT_TOKEN_ENV_PREFIX}${accountId.toUpperCase().replace(/-/g, "_")}`;
}

/** Legacy per-account token key (`FDE2E_REPORT_TOKEN_<ACCOUNT>`), still read. */
export function legacyAccountTokenEnvKey(accountId: string): string {
  return `${LEGACY_ENV_PREFIX}TOKEN_${accountId.toUpperCase().replace(/-/g, "_")}`;
}

/** Render the per-account env file (0600) that the manager hands to the account. */
export function renderAccountEnvFile(accountId: string, token: string): string {
  return [
    `# stoa account credential — ${accountId}`,
    `# 0600; hand this file to that account only. Never merge accounts.`,
    `STOA_ACCOUNT=${accountId}`,
    `${accountTokenEnvKey(accountId)}=${token}`,
    "",
  ].join("\n");
}

export function maskSecret(value: string): string {
  if (!value) return "(unset)";
  if (value.length <= 4) return "****";
  return `${value.slice(0, 1)}***${value.slice(-1)} (len=${value.length})`;
}
