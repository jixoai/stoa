#!/usr/bin/env bun
/** stoa — CLI entry (design.md §15). Legacy bin name `fde2e-report-worker` is kept as an alias. */
import { parseArgs, USAGE, hasFlag } from "./args.ts";
import { dispatch } from "./commands.ts";
import { emitError } from "./output.ts";
import { PRODUCT, VERSION } from "../core/protocol.ts";
import { ReportError, isReportError } from "../core/errors.ts";
import { CliError } from "./client.ts";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv[0] === "version") {
    process.stdout.write(`${PRODUCT} ${VERSION}\n`);
    return 0;
  }
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    emitError((err as Error).message, { code: (err as ReportError).code ?? "BAD_REQUEST" });
    return 1;
  }
  if (hasFlag(args, "help")) {
    process.stdout.write(USAGE.replace(`${PRODUCT}\n`, `${PRODUCT} ${VERSION}\n`));
    return 0;
  }
  if (!args.command) {
    process.stderr.write(USAGE);
    return 1;
  }
  try {
    return await dispatch(args);
  } catch (err) {
    if (isReportError(err)) {
      emitError(err.message, { code: err.code });
      return 1;
    }
    if (err instanceof CliError) {
      emitError(err.message, err.detail);
      return 1;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPIPE") {
      emitError("stdout closed (EPIPE)");
      return 3;
    }
    emitError((err as Error).message ?? String(err));
    if (process.env.DEBUG) process.stderr.write(`${(err as Error).stack}\n`);
    return 1;
  }
}

process.exitCode = await main();
