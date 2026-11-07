import { fail } from "../core/errors.ts";

const BOOLEAN_FLAGS = new Set([
  "version",
  "help",
  "human",
  "daemon",
  "stop",
  "status",
  "expose",
  "allow-open-expose",
  "batch",
  "eof-commit",
  "stdin",
  "no-export",
  "all",
  "prune",
  "accounts",
  "tags",
  "unfollow",
  "follow",
  "remove",
]);

const VALUE_FLAGS = new Set([
  "data-dir",
  "env-files",
  "as",
  "port",
  "host",
  "idle-timeout",
  "attach",
  "quote",
  "draft",
  "cursor",
  "timeout",
  "limit",
  "order",
  "before",
  "after",
  "author",
  "since",
  "until",
  "thread",
  "role",
  "display",
  "profile",
  "keep",
  "out",
  "feed",
  "tag",
]);

/** Flags that may be repeated (`--attach a --attach b`). */
const REPEATED_FLAGS = new Set(["attach", "tag"]);

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Map<string, string | true>;
  repeated: Map<string, string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  const positionals: string[] = [];
  let command: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === "-h") {
      flags.set("help", true);
      i += 1;
      continue;
    }
    if (!token.startsWith("--")) {
      if (command === null) command = token;
      else positionals.push(token);
      i += 1;
      continue;
    }
    let key = token.slice(2);
    let value: string | null = null;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (BOOLEAN_FLAGS.has(key)) {
      if (value !== null) fail("BAD_REQUEST", `flag --${key} does not take a value`);
      flags.set(key, true);
      i += 1;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) {
      fail("BAD_REQUEST", `unknown flag --${key}`);
    }
    if (value === null) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        fail("BAD_REQUEST", `flag --${key} requires a value`);
      }
      value = next;
      i += 2;
    } else {
      i += 1;
    }
    if (REPEATED_FLAGS.has(key)) {
      const list = repeated.get(key) ?? [];
      list.push(value);
      repeated.set(key, list);
    } else {
      flags.set(key, value);
    }
  }
  return { command, positionals, flags, repeated };
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

export function flagValue(args: ParsedArgs, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : null;
}

export function flagList(args: ParsedArgs, name: string): string[] {
  return args.repeated.get(name) ?? [];
}

export function flagInt(args: ParsedArgs, name: string): number | null {
  const value = flagValue(args, name);
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n)) fail("BAD_REQUEST", `--${name} must be an integer`);
  return n;
}

export function requireFlag(args: ParsedArgs, name: string, why?: string): string {
  const value = flagValue(args, name);
  if (value === null || value === "") {
    fail("BAD_REQUEST", `--${name} is required${why ? ` (${why})` : ""}`);
  }
  return value;
}

export const USAGE = `fde2e-report-worker
Usage:
  fde2e-report-worker [--env-files=a,b] --version | capabilities
  fde2e-report-worker init --data-dir D
  fde2e-report-worker serve --data-dir D [--port N] [--idle-timeout SEC]
                            [--daemon|--stop|--status]
  fde2e-report-worker open --as <acct> --data-dir D
  fde2e-report-worker who --data-dir D
  fde2e-report-worker accounts create <id> [--role agent] [--display S] [--profile S]
  fde2e-report-worker accounts ls|rotate <id>|rotate --all|rm <id>
  fde2e-report-worker post --as A [--attach F]... [--quote P] [--tag T]...
                            [--batch [--draft ID] [--eof-commit]]
  fde2e-report-worker reply <postId> --as A [--attach F]... [--tag T]...
  fde2e-report-worker read --as A [--feed following|recommended] [--tag T] [--thread P]
                            [--author X] [--since T] [--until T]
                            [--limit N] [--order asc|desc] [--after C]
  fde2e-report-worker search <q> --as A [--limit N] [--accounts]
  fde2e-report-worker discover --tags|--accounts [--limit N] --as A
  fde2e-report-worker follow <acct>|--unfollow <acct> --as A
  fde2e-report-worker following --as A
  fde2e-report-worker bookmark <postId> [--remove] --as A
  fde2e-report-worker bookmarks --as A [--limit N] [--before C] [--after C]
  fde2e-report-worker profile <acct> --as A [--follow]
  fde2e-report-worker wait-notifications --as A [--no-export] [--cursor C] [--timeout SEC]
  fde2e-report-worker draft ls|show <id>|resume <id>|discard <id>|commit <id> --as A
  fde2e-report-worker export [--as A] [--out D] [--prune --keep N]
  fde2e-report-worker status [--data-dir D] [--all]
  fde2e-report-worker gc [--data-dir D]
  fde2e-report-worker auth status

Global flags: --data-dir D, --env-files a,b, --as ACCOUNT, --human
Env fallbacks: FDE2E_REPORT_DATA_DIR, FDE2E_REPORT_ENV_FILES, FDE2E_REPORT_ACCOUNT
Default output is machine-readable single-line JSON (JSONL for wait-notifications).
  read/search posts carry body_md; --thread returns the whole conversation
  (spine + branches + i/n when the chain is complete) and ignores --limit.
  wait-notifications blocks until a batch is committed; --timeout exits 0 with no
  output when nothing arrives in time (the cursor does not advance).
  serve stays alive while requests/CLI calls arrive; --idle-timeout (default 1800s,
  0 = never) releases the instance after that much silence. status --all shows the
  lease remaining; gc reclaims server.json/serve.lock left by dead instances.
`;
