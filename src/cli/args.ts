import { fail } from "../core/errors.ts";

const BOOLEAN_FLAGS = new Set([
  "version",
  "help",
  "human",
  "daemon",
  "standalone",
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
  // stoa daemon account（S3-1）：密码只从 stdin/env 读，重置需 --force。
  "password-stdin",
  "force",
]);

const VALUE_FLAGS = new Set([
  "data-dir",
  "env-files",
  "as",
  "port",
  "host",
  "idle-timeout",
  // stoa daemon（stoa-daemon design §3）：daemon 状态目录/端口与挂载服务名。
  "state-dir",
  "daemon-port",
  "name",
  // daemon 账号（S3-1）。
  "username",
  // daemon 托管（UDS）实例的内部开关（由 daemon 传给子进程；也可手动调试）。
  "unix",
  "url",
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
  "message",
  // report-longform（D13/§6.1）：正文文件与载体格式（note|article）。
  "file",
  "format",
  // stoa mcp（核心 MCP 面，stoa-adapters design §2）：进程级配置来源。
  "base-url",
  "token",
  "account",
  "public-url",
  "config",
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
    if (token === "-m") {
      const next = argv[i + 1];
      if (next === undefined) fail("BAD_REQUEST", "flag -m requires a value (or use --message TEXT)");
      flags.set("message", next);
      i += 2;
      continue;
    }
    if (token.startsWith("-") && !token.startsWith("--")) {
      fail("BAD_REQUEST", `unknown flag ${token} (use --message/-m for body text starting with "-")`);
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

export const USAGE = `stoa
Usage:
  stoa [--env-files=a,b] --version | capabilities
  stoa init --data-dir D
  stoa serve --data-dir D [--port N] [--idle-timeout SEC]
                            [--standalone|--daemon|--stop|--status]
                            [--state-dir S] [--daemon-port N] [--name S]
                            [--unix SOCKET --url LOGICAL_URL]  (daemon-managed instances)
  stoa daemon start|status|stop|run [--port N] [--host H] [--state-dir S]
  stoa daemon account set [--username U] [--password-stdin] [--force] [--state-dir S]
  stoa daemon account status [--state-dir S]
  stoa open --as <acct> --data-dir D
  stoa who --data-dir D
  stoa accounts create <id> [--role agent] [--display S] [--profile S]
  stoa accounts ls|rotate <id>|rotate --all|rm <id>
  stoa post --as A [-m TEXT | --file F | --stdin] [--format note|article]
                            [--attach F]... [--quote P] [--tag T]...
                            [--batch [--draft ID] [--eof-commit]]
  stoa reply <postId> --as A [-m TEXT | --file F | --stdin]
                            [--format note|article] [--attach F]... [--tag T]...
  stoa read --as A [--feed following|recommended] [--tag T] [--thread P]
                            [--author X] [--since T] [--until T]
                            [--limit N] [--order asc|desc] [--after C]
                            [--base-url URL --token T --account A]
  stoa search <q> --as A [--limit N] [--accounts]
  stoa discover --tags|--accounts [--limit N] --as A
  stoa follow <acct>|--unfollow <acct> --as A
  stoa following --as A
  stoa bookmark <postId> [--remove] --as A
  stoa bookmarks --as A [--limit N] [--before C] [--after C]
  stoa profile <acct> --as A [--follow]
  stoa wait-notifications --as A [--no-export] [--cursor C] [--timeout SEC]
                            [--base-url URL --token T --account A]
  stoa draft ls|show <id>|resume <id>|discard <id>|commit <id> --as A
  stoa export [--as A] [--out D] [--prune --keep N]
  stoa status [--data-dir D] [--all] [--base-url URL --token T --account A]
  stoa gc [--data-dir D]
  stoa auth status
  stoa mcp [--base-url URL] [--token TOKEN] [--account A] [--data-dir D]
                            [--public-url URL] [--config FILE]
                            [--env-files a,b] [--as A]

Global flags: --data-dir D, --env-files a,b, --as ACCOUNT, --human
Env fallbacks (CLI): STOA_DATA_DIR, STOA_ENV_FILES, STOA_ACCOUNT
  (legacy FDE2E_REPORT_DATA_DIR/ENV_FILES/ACCOUNT equivalents are also read)
Default output is machine-readable single-line JSON (JSONL for wait-notifications).
  read/search posts carry body_md; --thread returns the whole conversation
  (spine + branches + i/n when the chain is complete) and ignores --limit.
  post/reply body: positional text, -m/--message TEXT, --file PATH, or --stdin (pick one).
  --format note|article selects the carrier (article raises the body limit to 512,000
  chars / 2 MiB utf-8 and renders on the article view). Files >2 MiB are refused.
  Use -- before a body that starts with "-"; unknown short flags are rejected.
  wait-notifications blocks until a batch is committed; --timeout exits 0 with no
  output when nothing arrives in time (the cursor does not advance).
  serve stays alive while requests/CLI calls arrive; --idle-timeout (default 1800s,
  0 = never) releases the instance after that much silence. status --all shows the
  lease remaining; gc reclaims server.json/serve.lock left by dead instances.
  By default \`serve\` attaches the instance to the per-machine stoa daemon
  (\`stoa daemon\`, default http://127.0.0.1:13679): the daemon is started on demand,
  the instance is mounted into it (idle-timeout defaults to never; manage via
  http://127.0.0.1:13679 or \`stoa daemon status\`), the service URL and daemon URL
  are printed as one JSON line, and the terminal is released immediately.
  \`--standalone\` decouples: the instance runs in the foreground and owns the
  terminal until Ctrl-C (old default). \`--daemon\` keeps the legacy behavior of
  detaching a single standalone instance (no daemon, no registry).
  Direct mode (read/wait-notifications/status): when --base-url is passed or
  STOA_BASE_URL/REPORT_CHANNEL_BASE_URL is set (process env or a loaded env file),
  the command talks to that board using the same config resolution as \`stoa mcp\`
  (flags > STOA_* > REPORT_CHANNEL_* + FDE2E_REPORT_TOKEN_<ACCOUNT> > config file >
  default) and never needs a --data-dir pointer. --as overrides the configured
  account. Without a base URL the original data-dir discovery semantics apply.
  mcp speaks newline-delimited JSON-RPC 2.0 on stdio (initialize/tools/list/
  tools/call/ping/resources) for harness integration; --env-files loads token/config
  env files (same loader as the rest of the CLI) and --as is the highest-priority
  account override. Config order is flags > STOA_* > REPORT_CHANNEL_* (baseUrl/
  account/dataDir/publicUrl/config) + FDE2E_REPORT_TOKEN_<ACCOUNT> (token only) >
  ~/.config/stoa/report-channel.json (legacy ~/.config/fde2e/report-channel.json) >
  http://127.0.0.1:13689. It never prints credentials (token presence only shows as
  present/absent in board_status).
`;
