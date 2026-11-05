#!/usr/bin/env bun
/**
 * Static gate for report worker:
 *  1. tsc --noEmit (strict)
 *  2. contract lint: every API_ROUTES entry appears in src/server/http.ts as a
 *     literal route string, every CLI command is handled in src/cli/main.ts.
 *  3. security lint: no `?token=` credential transport anywhere in src/.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
let failed = false;

function ok(label, detail = "") {
  console.log(`ok   ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label, detail = "") {
  failed = true;
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: process.env });
  if (res.status !== 0) bad(cmd, `exit ${res.status}`);
  else ok(cmd);
}

run("bun", ["x", "tsc", "--noEmit", "-p", "tsconfig.json"]);

const protocol = readFileSync(join(root, "src/core/protocol.ts"), "utf8");
const routeBlock = protocol.slice(
  protocol.indexOf("export const API_ROUTES"),
  protocol.indexOf("export interface Capabilities"),
);
const routes = [...routeBlock.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
const httpSource = readFileSync(join(root, "src/server/http.ts"), "utf8");
if (routes.length === 0) bad("api routes", "none parsed from protocol.ts");
for (const route of routes) {
  const literal = `"${route}"`;
  if (!httpSource.includes(literal)) bad("api route missing in http.ts", route);
}
if (routes.length > 0 && !failed) ok("api routes", `${routes.length} routes wired`);

const commands = [...protocol.matchAll(/^\s{2}"([a-z-]+)",$/gm)].map((m) => m[1]);
const cliSource = readFileSync(join(root, "src/cli/main.ts"), "utf8") + readFileSync(join(root, "src/cli/commands.ts"), "utf8");
for (const command of commands) {
  if (!cliSource.includes(`"${command}"`) && !cliSource.includes(`'${command}'`)) {
    bad("cli command missing", command);
  }
}
if (commands.length > 0) ok("cli commands", `${commands.length} declared`);

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.(ts|mjs|js)$/.test(entry)) files.push(full);
  }
}
walk(join(root, "src"));
for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (src.includes("?token=")) bad("credential in query string", relative(root, file));
  if (/local-x\.fde2e\.com\.evil\.com/.test(src) && !src.includes("// test")) {
    // the evil-looking origin may only appear in tests, never in the server
    if (file.includes("/src/server/")) bad("evil origin allowlist", relative(root, file));
  }
}
ok("security lint", `${files.length} source files scanned`);

if (failed) {
  console.error("\ncheck failed");
  process.exit(1);
}
console.log("\ncheck passed");
