import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface EnvValues {
  [key: string]: string;
}

export interface LoadedEnv {
  /** merged key/value (later files win) */
  values: EnvValues;
  /** absolute paths actually readable, in load order */
  loaded: string[];
  /** absolute paths requested but missing */
  missing: string[];
}

/** Parse dotenv-ish text. Supports `export K=V`, quotes, comments, blank lines. */
export function parseEnv(text: string): EnvValues {
  const out: EnvValues = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function parseEnvFileList(input: string | null | undefined): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Preferred env namespace: `STOA_*`. */
export const ENV_PREFIX = "STOA_";
/**
 * Legacy namespace of the `fde2e-report-worker` era. Still read everywhere for
 * compatibility (existing deployments, QA tooling, older integrations); new
 * deployments and generated files always use the preferred prefix.
 */
export const LEGACY_ENV_PREFIX = "FDE2E_REPORT_";

export interface EnvKeyPair {
  /** preferred `STOA_*` key */
  primary: string;
  /** legacy `FDE2E_REPORT_*` key, still honoured */
  legacy: string;
}

/** Build a preferred/legacy key pair for a suffix (`envKeys("AUTH")`). */
export function envKeys(suffix: string, legacySuffix = suffix): EnvKeyPair {
  return { primary: `${ENV_PREFIX}${suffix}`, legacy: `${LEGACY_ENV_PREFIX}${legacySuffix}` };
}

/** `STOA_FILEVIEWER_BASE` preferred; the legacy key has no `REPORT` segment. */
export const FILEVIEWER_BASE_KEYS: EnvKeyPair = {
  primary: `${ENV_PREFIX}FILEVIEWER_BASE`,
  legacy: "FDE2E_FILEVIEWER_BASE",
};

/**
 * Double read: the preferred key wins when it has a non-empty value, the
 * legacy key is the fallback. Empty values are treated as unset (the same
 * convention as every other config reader in this repo).
 */
export function envValue(
  values: Record<string, string | undefined>,
  keys: EnvKeyPair,
): string | undefined {
  const primary = values[keys.primary];
  if (primary !== undefined && primary !== "") return primary;
  const legacy = values[keys.legacy];
  if (legacy !== undefined && legacy !== "") return legacy;
  return undefined;
}

/** Resolve the effective env-file list (design §4.4). */
export function resolveEnvFiles(opts: {
  explicit?: string | null;
  dataDir: string;
  cwd?: string;
}): string[] {
  const explicit = parseEnvFileList(opts.explicit);
  if (explicit.length > 0) {
    return explicit.map((p) => resolve(opts.cwd ?? process.cwd(), p));
  }
  const cwd = opts.cwd ?? process.cwd();
  return [resolve(cwd, ".env.personal"), resolve(opts.dataDir, ".env")];
}

export function loadEnvFiles(paths: string[]): LoadedEnv {
  const values: EnvValues = {};
  const loaded: string[] = [];
  const missing: string[] = [];
  for (const raw of paths) {
    const path = resolve(raw);
    try {
      statSync(path);
    } catch {
      missing.push(path);
      continue;
    }
    try {
      const parsed = parseEnv(readFileSync(path, "utf8"));
      Object.assign(values, parsed);
      loaded.push(path);
    } catch {
      missing.push(path);
    }
  }
  return { values, loaded, missing };
}

interface CacheEntry {
  at: number;
  env: LoadedEnv;
  stamp: string;
}

/**
 * Live env reader: re-reads at most once per `ttlMs` (default 1000ms).
 * Process env is the lowest-priority layer; env files override it.
 */
export class LiveEnv {
  private readonly paths: string[];
  private readonly ttlMs: number;
  private readonly processEnv: EnvValues;
  private cache: CacheEntry | null = null;

  constructor(
    paths: string[],
    opts: { ttlMs?: number; processEnv?: Record<string, string | undefined> } = {},
  ) {
    this.paths = paths;
    this.ttlMs = opts.ttlMs ?? 1000;
    const base: EnvValues = {};
    for (const [key, value] of Object.entries(opts.processEnv ?? process.env)) {
      if (typeof value === "string") base[key] = value;
    }
    this.processEnv = base;
  }

  read(force = false): LoadedEnv {
    const now = Date.now();
    if (this.cache && !force && now - this.cache.at < this.ttlMs) {
      return this.cache.env;
    }
    const loaded = loadEnvFiles(this.paths);
    let stamp = "";
    for (const p of loaded.loaded) {
      try {
        const st = statSync(p);
        stamp += `${p}:${st.mtimeMs}:${st.size};`;
      } catch {
        stamp += `${p}:gone;`;
      }
    }
    const env: LoadedEnv = {
      values: { ...this.processEnv, ...loaded.values },
      loaded: loaded.loaded,
      missing: loaded.missing,
    };
    this.cache = { at: now, env, stamp };
    return env;
  }

  get(key: string): string {
    const value = this.read().values[key];
    return value ?? "";
  }
}
