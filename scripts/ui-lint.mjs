#!/usr/bin/env node
/**
 * ui-lint — report 前端的「组装规范」门（不是业务 lint）
 *
 * 背景：主仓纪律要求 UI 组件只来自 shadcn 官方 registry 收编件、视觉语言同源
 * （lucide 单色图标 / 主题令牌 / 禁硬编码色）。此前没有任何机器约束，全靠自觉。
 * 本脚本把这三条变成可执行的门：
 *
 *   R1 RAW_PRIMITIVE  页面/业务组件里不得出现原生 <button|input|textarea|select>
 *                     （必须用 components/ui/ 下的官方收编件）
 *   R2 HARDCODED_COLOR 业务代码不得出现 #rgb/#rrggbb 色值（theme/ 与 ui/ 是 vendor，豁免）
 *   R3 PROVENANCE      components/ui/ 下每个文件必须带 shadcn 出处注释
 *
 * 用法：node scripts/ui-lint.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const UI = join(ROOT, "src/ui");
const VENDOR_DIRS = ["src/ui/components/ui", "src/ui/theme"];

const violations = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === ".qa" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

const isVendor = (rel) => VENDOR_DIRS.some((d) => rel.startsWith(d + "/") || rel === d);

for (const file of walk(UI)) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");

  if (!isVendor(rel) && rel.endsWith(".tsx")) {
    // R1: raw interactive primitives
    const re = /<(button|input|textarea|select)\b/g;
    lines.forEach((line, i) => {
      let m;
      while ((m = re.exec(line))) {
        violations.push({
          rule: "R1",
          file: rel,
          line: i + 1,
          detail: `raw <${m[1]}> — 用 components/ui 下的官方收编件`,
        });
      }
    });
  }

  if (!isVendor(rel)) {
    // R2: hardcoded colors
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      const m = line.match(/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/);
      if (m) {
        violations.push({
          rule: "R2",
          file: rel,
          line: i + 1,
          detail: `硬编码色值 ${m[0]} — 用主题令牌`,
        });
      }
    });
  }

  // R3: provenance for collected components
  if (rel.startsWith("src/ui/components/ui/") && rel.endsWith(".tsx")) {
    if (!/shadcn/i.test(src)) {
      violations.push({
        rule: "R3",
        file: rel,
        line: 1,
        detail: "缺少 shadcn 出处注释（收编件必须注明来源）",
      });
    }
  }
}

const byRule = violations.reduce((acc, v) => ((acc[v.rule] = (acc[v.rule] ?? 0) + 1), acc), {});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ violations, byRule }, null, 2));
} else {
  for (const v of violations) {
    console.log(`✗ ${v.rule} ${v.file}:${v.line} — ${v.detail}`);
  }
  const files = new Set(violations.map((v) => v.file)).size;
  if (violations.length === 0) {
    console.log("ok   ui-lint — 0 violations（原生原语 / 硬编码色 / 出处注释）");
  } else {
    console.log(`\n✗ ui-lint — ${violations.length} violation(s) in ${files} file(s): ${JSON.stringify(byRule)}`);
  }
}

process.exit(violations.length === 0 ? 0 : 1);
