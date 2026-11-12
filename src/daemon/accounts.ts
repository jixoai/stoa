/**
 * daemon 独立账号（daemon-unified-port design §4，S3-1）。
 *
 * daemon 是「浏览器面的唯一入口」，因此有**自己的**账号密码——与实例口令（STOA_AUTH）
 * 完全无关：实例口令只服务 `--standalone` 直连，daemon 账号只服务 daemon 会话。
 *
 * 存储：`<stateDir>/daemon-accounts.json`（0600 原子写）
 *   `{ accounts: [{ username, passwordHash, createdAt, updatedAt }] }`
 * 哈希：`Bun.password.hash(pw, { algorithm: "argon2id" })`——**必须显式传 algorithm**
 * （Bun 1.4.4 只传 cost 参数会 TypeError）。校验走 `Bun.password.verify`（自己解析 PHC 串）。
 *
 * 明文密码/哈希都**不出**这个模块：CLI `daemon account status` 只回报用户名与时间。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./state.ts";

export const DAEMON_ACCOUNTS_FILE = "daemon-accounts.json";
/** 默认用户名（CLI 未指定 --username 且无既有账号时）。 */
export const DEFAULT_DAEMON_USERNAME = "daemon";
export const DAEMON_PASSWORD_MIN_LENGTH = 8;
export const DAEMON_PASSWORD_MAX_LENGTH = 256;

export interface DaemonAccount {
  username: string;
  /** argon2id PHC 串（`$argon2id$v=19$…`）；绝不外泄。 */
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

export function daemonAccountsPath(stateDir: string): string {
  return join(stateDir, DAEMON_ACCOUNTS_FILE);
}

function isDaemonAccount(value: unknown): value is DaemonAccount {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<DaemonAccount>;
  return (
    typeof record.username === "string" &&
    record.username.trim() !== "" &&
    typeof record.passwordHash === "string" &&
    record.passwordHash.startsWith("$argon2") &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
}

/** 读账号表（坏文件/缺文件一律空表——由 CLI 引导创建）。 */
export function readDaemonAccounts(stateDir: string): DaemonAccount[] {
  const value = readJsonFile<{ accounts?: unknown }>(daemonAccountsPath(stateDir));
  if (!value || !Array.isArray(value.accounts)) return [];
  return value.accounts.filter(isDaemonAccount);
}

/** 写账号表（0600 原子写）。 */
export function writeDaemonAccounts(stateDir: string, accounts: DaemonAccount[]): void {
  writeJsonAtomic(daemonAccountsPath(stateDir), { accounts });
}

export function daemonAccountConfigured(stateDir: string): boolean {
  return readDaemonAccounts(stateDir).length > 0;
}

export function findDaemonAccount(
  accounts: DaemonAccount[],
  username: string | null | undefined,
): DaemonAccount | null {
  const needle = String(username ?? "").trim().toLowerCase();
  if (!needle) return accounts.length === 1 ? accounts[0]! : null;
  return accounts.find((account) => account.username.toLowerCase() === needle) ?? null;
}

export function validateDaemonUsername(raw: string | null | undefined): string {
  const username = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(username)) {
    throw new Error("用户名只能包含字母/数字/._-（1–64 字符），且以字母或数字开头");
  }
  return username;
}

export function validateDaemonPassword(raw: unknown): string {
  const password = typeof raw === "string" ? raw : "";
  if (password.length < DAEMON_PASSWORD_MIN_LENGTH) {
    throw new Error(`daemon 密码至少 ${DAEMON_PASSWORD_MIN_LENGTH} 个字符`);
  }
  if (password.length > DAEMON_PASSWORD_MAX_LENGTH) {
    throw new Error(`daemon 密码过长（≤${DAEMON_PASSWORD_MAX_LENGTH} 字符）`);
  }
  if (/[\r\n]/.test(password)) throw new Error("daemon 密码不能包含换行");
  return password;
}

/** argon2id 哈希（唯一入口；algorithm 必须显式）。 */
export async function hashDaemonPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, { algorithm: "argon2id" });
}

/** 校验密码；坏哈希/算法不符一律 false（不抛）。 */
export async function verifyDaemonPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

export class DaemonAccountExistsError extends Error {
  readonly code = "ACCOUNT_EXISTS";
  constructor(readonly username: string) {
    super(`daemon 账号「${username}」已存在；重置密码需要 --force`);
    this.name = "DaemonAccountExistsError";
  }
}

export interface SetDaemonAccountResult {
  /** true = 首次创建；false = 重置既有账号。 */
  created: boolean;
  account: DaemonAccount;
}

/**
 * 创建或重置 daemon 账号（CLI `daemon account set` 的唯一写入口）：
 *   - 无账号 → 创建（username 缺省 `daemon`）；
 *   - 有账号且未传 force → 抛 `DaemonAccountExistsError`（CLI 映射为可读错误）；
 *   - force → 覆盖（用户名可改，`createdAt` 保留首次创建时间）。
 */
export async function setDaemonAccount(
  stateDir: string,
  opts: { username?: string | null; password: unknown; force?: boolean; now?: number },
): Promise<SetDaemonAccountResult> {
  const password = validateDaemonPassword(opts.password);
  const list = readDaemonAccounts(stateDir);
  const existing = list[0] ?? null;
  if (existing && opts.force !== true) throw new DaemonAccountExistsError(existing.username);
  const username = opts.username
    ? validateDaemonUsername(opts.username)
    : (existing?.username ?? DEFAULT_DAEMON_USERNAME);
  const now = opts.now ?? Date.now();
  const account: DaemonAccount = {
    username,
    passwordHash: await hashDaemonPassword(password),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeDaemonAccounts(stateDir, [account]);
  return { created: !existing, account };
}

/**
 * 登录校验：username 省略（或空）且只有一个账号时用它；密码错/账号不存在都返回 null。
 * 为了不泄漏「用户名是否存在」，调用方对两种失败给同一文案。
 */
export async function verifyDaemonLogin(
  stateDir: string,
  username: string | null | undefined,
  password: string,
): Promise<DaemonAccount | null> {
  const list = readDaemonAccounts(stateDir);
  const account = findDaemonAccount(list, username);
  if (!account) return null;
  const ok = await verifyDaemonPassword(account.passwordHash, password);
  return ok ? account : null;
}

/**
 * 账号状态视图（CLI `daemon account status` / `GET /api/daemon/auth/status`）：
 * **绝不**含密码或哈希。文件存在但读不出内容（损坏）时按未配置处理。
 */
export interface DaemonAccountStatus {
  configured: boolean;
  username: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export function daemonAccountStatus(stateDir: string): DaemonAccountStatus {
  const account = readDaemonAccounts(stateDir)[0] ?? null;
  return {
    configured: account !== null,
    username: account?.username ?? null,
    createdAt: account?.createdAt ?? null,
    updatedAt: account?.updatedAt ?? null,
  };
}

/** 账号文件是否存在（诊断用；不暴露内容）。 */
export function daemonAccountsFileExists(stateDir: string): boolean {
  return existsSync(daemonAccountsPath(stateDir));
}
