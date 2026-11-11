/**
 * Subagent board accounts for the dsh host half (S6; design §5).
 *
 * - `parseStoaMarker` reads `[[stoa:<id>]]` from a subagent task text (first
 *   legal id wins; illegal markers are ignored).
 * - Accounts are created lazily: only when a subagent actually uses a stoa tool
 *   (or when the main agent pre-opens one with `stoa_open_account`).
 * - Naming comes from `lib/names.js` (`pickName`), with board-side ids/displays
 *   as the taken set; a requested name is slugified and validated against the
 *   board's `SLUG_RE`.
 * - Tokens are read from the account's 0600 env file (`<dataDir>/accounts/
 *   <id>.env`, the file the board hands out) and stay in memory — they are never
 *   returned by a tool nor written anywhere.
 */

import { pickName } from "../names.js";
import { accountEnvPath, parseEnvText, readAccountToken } from "./session.js";

/** Mirrors `SLUG_RE` in `src/core/validation.ts`. */
export const ACCOUNT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/**
 * Person/system identities that can never be a subagent identity.
 * Mirrors `RESERVED_IDS` in `src/core/validation.ts:5` (`owner`, `manager`);
 * the board also refuses to create them because `src/server/init.ts:72-73`
 * initializes both rows, so `createAccount` answers CONFLICT
 * (`src/server/store.ts` insertAccount). Hard-coded here because this module
 * is plain JS and cannot import the TypeScript source.
 */
export const RESERVED_ACCOUNT_IDS = new Set(["owner", "manager"]);
/** Marker syntax written by the main agent into a subagent task text. */
const MARKER_RE = /\[\[\s*stoa\s*:\s*([^\]\s]*)\s*\]\]/g;

/** @returns {boolean} whether `id` is a reserved person/system identity. */
export function isReservedAccountId(id) {
  return RESERVED_ACCOUNT_IDS.has(String(id));
}

/** Readable rejection for any attempt to use a reserved id as a subagent. */
export function reservedAccountError(id) {
  return new Error(
    `账号「${id}」是板子的保留身份（owner/manager），不能作为子代理账号或 [[stoa:${id}]] 标记；请用 stoa_open_account 生成普通账号（例如 name="helper"）。`,
  );
}

/**
 * First legal `[[stoa:<id>]]` account id, or null.
 *
 * Reserved identities are explicitly rejected: a text whose only legal marker
 * is `[[stoa:owner]]`/`[[stoa:manager]]` throws a readable error instead of
 * silently falling back to auto-naming (so the author sees why no identity
 * was applied). A later legal marker still wins over an earlier reserved one.
 */
export function parseStoaMarker(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let reserved = null;
  for (const match of text.matchAll(MARKER_RE)) {
    const candidate = match[1] ?? "";
    if (!ACCOUNT_ID_RE.test(candidate)) continue;
    if (isReservedAccountId(candidate)) {
      reserved ??= candidate;
      continue;
    }
    return candidate;
  }
  if (reserved) throw reservedAccountError(reserved);
  return null;
}

/** Slugify a human-requested account name; invalid results return null. */
export function slugifyAccountId(name) {
  const slug = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return ACCOUNT_ID_RE.test(slug) ? slug : null;
}

/**
 * Board accounts in the shape `pickName` needs. A failed listing yields empty
 * sets (naming then relies on the board's own conflict response).
 */
export async function listIdentities(board) {
  const ids = new Set();
  const displays = new Set();
  try {
    const body = await board.get("/api/accounts");
    for (const account of body?.accounts ?? []) {
      if (account && typeof account.id === "string") ids.add(account.id);
      if (account && typeof account.display === "string") displays.add(account.display);
    }
  } catch {
    // listing is best-effort: creation still validates the id board-side
  }
  return { ids, displays };
}

/** True only for the board's real duplicate-id conflict (`CONFLICT` → HTTP 409). */
function isConflict(error) {
  if (typeof error?.status === "number") return error.status === 409;
  // Legacy/foreign error shapes without a status: match the board's conflict wording.
  const message = String(error?.message ?? error);
  return /exist|conflict|UNIQUE|constraint/i.test(message);
}

function isAuthFailure(error) {
  return error?.status === 401 || error?.status === 403;
}

/** 401/403 mean bad credentials, not "name taken" — surface the auth cause. */
function normalizeAccountError(error) {
  if (!isAuthFailure(error)) return error;
  return new Error(
    `Stoa 板鉴权失败（HTTP ${error.status}）：${String(error?.message ?? error)}。请在 daemon 控制台核对该实例的 manager 凭据后重试。`,
  );
}

/** One account token out of parsed env values (new prefix, then legacy). */
function tokenInEnvText(text, accountId) {
  const values = parseEnvText(text);
  const upper = String(accountId).toUpperCase().replace(/-/g, "_");
  return values[`STOA_TOKEN_${upper}`] || values[`FDE2E_REPORT_TOKEN_${upper}`] || null;
}

/**
 * Account manager over one instance's board client.
 *
 * @param {{
 *   board: ReturnType<import('./session.js').createBoardClient>,
 *   dataDir: string,
 *   readFile?: (path: string, encoding: string) => string,
 * }} options
 */
export function createAccountManager(options) {
  const board = options.board;
  const dataDir = options.dataDir;
  const readFile = options.readFile;

  /** Token from the 0600 env file the board wrote for this account. */
  function tokenOf(accountId) {
    if (typeof readFile === "function") {
      try {
        return tokenInEnvText(readFile(accountEnvPath(dataDir, accountId), "utf8"), accountId);
      } catch {
        return null;
      }
    }
    return readAccountToken(dataDir, accountId);
  }

  /** Read one account token out of an explicit file path (board-returned `env_file`). */
  function tokenOfFile(file, accountId) {
    if (typeof readFile !== "function" || !file) return null;
    try {
      return tokenInEnvText(readFile(file, "utf8"), accountId);
    } catch {
      return null;
    }
  }

  /** `POST /api/accounts` then read the returned 0600 `env_file`. */
  async function createAccount(id, display) {
    let body;
    try {
      body = await board.post("/api/accounts", { id, display });
    } catch (error) {
      throw normalizeAccountError(error);
    }
    const envFile = typeof body?.env_file === "string" && body.env_file ? body.env_file : null;
    const token = tokenOfFile(envFile, id) ?? tokenOf(id);
    if (!token) {
      throw new Error(`account ${id} was created but its 0600 token file could not be read (${envFile ?? "no env_file"})`);
    }
    return { id, display, token, envFile };
  }

  return {
    /** Existing account (with a readable token file) or null. */
    async find(accountId) {
      if (!ACCOUNT_ID_RE.test(accountId)) return null;
      // Reserved ids never resolve through the subagent path: no board read,
      // no 0600 token read for owner/manager.
      if (isReservedAccountId(accountId)) return null;
      const { ids } = await listIdentities(board);
      if (!ids.has(accountId)) return null;
      const token = tokenOf(accountId);
      return token ? { id: accountId, token } : null;
    },
    /**
     * Lazy account for one subagent: reuse the marker/requested id when a token
     * file exists (or rotate it when the account exists without a token file),
     * otherwise pick a fresh name from the pool and create it.
     */
    async ensureSubagentAccount({ markerId = null, name = null, display = null } = {}) {
      const requested = markerId ?? null;
      if (requested) {
        if (isReservedAccountId(requested)) throw reservedAccountError(requested);
        const found = await this.find(requested);
        if (found) return { ...found, display: display ?? requested, reused: true };
        const { ids } = await listIdentities(board);
        if (ids.has(requested)) {
          // Account exists on the board but its token file is gone: rotate to
          // mint a fresh token instead of failing the subagent.
          let rotated;
          try {
            rotated = await board.post(`/api/accounts/${encodeURIComponent(requested)}/rotate`, {});
          } catch (error) {
            throw normalizeAccountError(error);
          }
          const envFile = typeof rotated?.env_file === "string" ? rotated.env_file : null;
          const token = tokenOfFile(envFile, requested) ?? tokenOf(requested);
          if (!token) throw new Error(`account ${requested} exists but its token cannot be read`);
          return { id: requested, display: display ?? rotated?.account?.display ?? requested, token, envFile, rotated: true };
        }
        const created = await createAccount(requested, display ?? requested);
        return { ...created, reused: false };
      }
      if (name) {
        const id = slugifyAccountId(name);
        if (!id) throw new Error(`invalid account name "${name}": use letters/digits (a-z0-9), result must match ${ACCOUNT_ID_RE.source}`);
        if (isReservedAccountId(id)) throw reservedAccountError(id);
        const found = await this.find(id);
        if (found) return { ...found, display: display ?? id, reused: true };
        const created = await createAccount(id, display ?? id);
        return { ...created, reused: false };
      }
      const { ids, displays } = await listIdentities(board);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const picked = pickName({ takenIds: ids, takenDisplays: displays });
        if (isReservedAccountId(picked.id)) {
          ids.add(picked.id);
          continue;
        }
        const created = await createAccount(picked.id, picked.display).catch((error) => {
          if (isConflict(error)) return null;
          throw error;
        });
        if (created) return { ...created, reused: false };
        ids.add(picked.id);
        displays.add(picked.display);
      }
      throw new Error("could not allocate a free board account name after 5 attempts");
    },
    /** Main-agent pre-open: explicit id/display, returns the public shape only. */
    async openAccount({ name = null, display = null } = {}) {
      const result = await this.ensureSubagentAccount({ name, display });
      if (isReservedAccountId(result.id)) throw reservedAccountError(result.id);
      return { id: result.id, display: result.display ?? result.id };
    },
  };
}
