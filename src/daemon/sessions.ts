/**
 * 会话位置与访问口令（stoa-session-ux design §1/§2）。
 *
 * 会话不再要求用户提供 dataDir：
 *   auto → `~/.stoa/sessions/<slug>-<hex>`（持久；缺省）
 *   temp → 系统临时目录（ephemeral；服务停止/移除时整目录删除）
 *   path → 用户指定目录（不存在则创建；未初始化则自动 init）
 *
 * 自动/临时会话默认开启认证：init 后把 `STOA_AUTH` 写入 `<dataDir>/.env`（用户给口令就用它，
 * 否则生成 18 字节 base64url = 24 字符）。口令只在这里读写，绝不进日志。
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parseEnv } from "../core/env.ts";

export type SessionLocation = "auto" | "temp" | "path";

/** 全局会话根目录（`~/.stoa/sessions`；HOME 覆盖用于测试隔离）。 */
export function sessionsRoot(home = process.env.HOME ?? homedir()): string {
  return join(home, ".stoa", "sessions");
}

export function slugify(name: string | null | undefined, fallback = "board"): string {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || fallback;
}

/** `<slug>-<6hex>`：目录名要可读，但不得互相撞车。 */
export function newSessionDirName(name: string | null | undefined, seed: string = crypto.randomUUID()): string {
  const hex = seed.replace(/-/g, "").toLowerCase().slice(0, 6);
  return `${slugify(name)}-${hex}`;
}

export interface ResolvedSessionDir {
  dataDir: string;
  ephemeral: boolean;
  /** 目录是本次调用创建的（用于决定是否自动 init / 生成口令）。 */
  created: boolean;
}

export function resolveSessionDataDir(opts: {
  dataDir?: string | null;
  location?: SessionLocation | null;
  name?: string | null;
  cwd?: string;
  home?: string;
}): ResolvedSessionDir {
  const explicit = (opts.dataDir ?? "").trim();
  const location: SessionLocation = opts.location ?? (explicit ? "path" : "auto");
  if (location === "temp") {
    const dataDir = mkdtempSync(join(tmpdir(), "stoa-session-"));
    chmodSync(dataDir, 0o700);
    return { dataDir, ephemeral: true, created: true };
  }
  if (location === "path") {
    if (!explicit) throw new Error('location "path" requires dataDir');
    const dataDir = resolve(opts.cwd ?? process.cwd(), explicit);
    const created = !existsSync(dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (created) chmodSync(dataDir, 0o700);
    return { dataDir, ephemeral: false, created };
  }
  const root = sessionsRoot(opts.home);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  for (;;) {
    const dataDir = join(root, newSessionDirName(opts.name));
    if (existsSync(dataDir)) continue; // 撞车概率极低；撞了就换一个
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    return { dataDir, ephemeral: false, created: true };
  }
}

export function generateAuthKey(): string {
  return randomBytes(18).toString("base64");
}

/** 口令校验：6–128 字符、不含空白（避免链接/终端里被截断）。 */
export function validateAuthKey(raw: string): string {
  const key = String(raw ?? "").trim();
  if (key.length < 6 || key.length > 128) {
    throw new Error("access key must be 6-128 characters");
  }
  if (/\s/.test(key)) throw new Error("access key must not contain whitespace");
  return key;
}

function authValueOf(file: string): string {
  try {
    const values = parseEnv(readFileSync(file, "utf8"));
    return (values.STOA_AUTH ?? values.FDE2E_REPORT_AUTH ?? "").trim();
  } catch {
    return "";
  }
}

/** 按顺序找第一个带口令的 env 文件（返回文件＋口令；供读取与改写定位）。 */
export function findAuthKey(files: Array<string | null | undefined>): { file: string; key: string } | null {
  const seen = new Set<string>();
  for (const raw of files) {
    const file = (raw ?? "").trim();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    const key = authValueOf(file);
    if (key) return { file, key };
  }
  return null;
}

/**
 * 写入/替换某个 env 文件的 `STOA_AUTH`（0600；保留其它行与注释；先删旧键再追加，
 * 旧前缀 `FDE2E_REPORT_AUTH` 一并清掉以免双值互相覆盖）。
 */
export function setAuthKey(file: string, key: string): void {
  const target = resolve(file);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let lines: string[] = [];
  if (existsSync(target)) {
    lines = readFileSync(target, "utf8").split(/\r?\n/);
  }
  const kept = lines.filter((line) => !/^\s*(?:export\s+)?(?:STOA_AUTH|FDE2E_REPORT_AUTH)\s*=/.test(line));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  kept.push(`STOA_AUTH=${key}`);
  const content = `${kept.join("\n")}\n`;
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
}

/** 口令链接：`<publicUrl|url>/#key=<key>`（fragment 不经服务端请求/日志）。 */
export function keyLink(service: { url?: string | null; publicUrl?: string | null }, key: string): string | null {
  const base = (service.publicUrl ?? service.url ?? "").replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/#key=${encodeURIComponent(key)}`;
}
