/**
 * Subagent account naming for the dsh host half (openspec stoa-dsh-session-mode S2).
 *
 * `data/names.json` holds two pools:
 *   given:    `[{ zh: "小满", py: "xiaoman" }, ...]`
 *   surnames: `[{ zh: "林",   py: "lin"     }, ...]`
 *
 * Ids double as Stoa account ids, so they must satisfy the board's SLUG_RE
 * (`/^[a-z][a-z0-9_-]{0,31}$/`, lowercase 1-32 chars) while displays stay
 * Chinese. `pickName` walks: bare given name → surname + given name (up to
 * eight random pairings) → numeric suffix on the id.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Mirrors `SLUG_RE` in `src/core/validation.ts`. */
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_ID_LENGTH = 32;
const MAX_COMBINATIONS = 8;
const FIRST_SUFFIX = 2;
const FALLBACK_STEM = "stoa";

const POOL_DIR = dirname(fileURLToPath(import.meta.url));
const pool = JSON.parse(readFileSync(join(POOL_DIR, "..", "data", "names.json"), "utf8"));

/** @param {unknown} value @returns {Set<string>} */
function asSet(value) {
  return value instanceof Set ? value : new Set(value ?? []);
}

/**
 * @template T
 * @param {T[]} rows
 * @param {() => number} random
 * @returns {T}
 */
function pick(rows, random) {
  const value = random();
  const index = Number.isFinite(value) ? Math.floor(value * rows.length) : 0;
  return rows[Math.max(0, Math.min(rows.length - 1, index))];
}

/** @returns {boolean} */
function isTaken(ids, displays, id, display) {
  return ids.has(id) || displays.has(display);
}

/** @returns {string} */
function withSuffix(base, number) {
  const suffix = `-${number}`;
  const limit = Math.max(1, MAX_ID_LENGTH - suffix.length);
  const stem = base.slice(0, limit).replace(/[-_]+$/, "") || FALLBACK_STEM;
  return `${stem}${suffix}`;
}

/**
 * Pick an unused account id + display name.
 *
 * 1. A random given name alone (`xiaoman` / 「小满」) when it is free.
 * 2. Otherwise a random surname + given pair (`lin-xiaoman` / 「林小满」),
 *    retried up to {@link MAX_COMBINATIONS} random pairings.
 * 3. Otherwise the last pairing with `-2`, `-3`, … appended to the id until it
 *    is free and slug-safe. Displays are not suffixed; only ids carry numbers.
 *
 * `takenIds` / `takenDisplays` accept arrays or Sets; `random` is injectable so
 * callers (tests) can seed it.
 *
 * @param {{
 *   takenIds?: Iterable<string>,
 *   takenDisplays?: Iterable<string>,
 *   random?: () => number,
 * }} [options]
 * @returns {{ id: string, display: string }}
 */
export function pickName({ takenIds = [], takenDisplays = [], random = Math.random } = {}) {
  const ids = asSet(takenIds);
  const displays = asSet(takenDisplays);

  const given = pick(pool.given, random);
  if (!isTaken(ids, displays, given.py, given.zh)) {
    return { id: given.py, display: given.zh };
  }

  let last;
  for (let attempt = 0; attempt < MAX_COMBINATIONS; attempt += 1) {
    const candidateGiven = attempt === 0 ? given : pick(pool.given, random);
    const surname = pick(pool.surnames, random);
    last = {
      id: `${surname.py}-${candidateGiven.py}`,
      display: `${surname.zh}${candidateGiven.zh}`,
    };
    if (!isTaken(ids, displays, last.id, last.display)) return last;
  }

  for (let number = FIRST_SUFFIX; ; number += 1) {
    const id = withSuffix(last.id, number);
    if (!ids.has(id) && ID_RE.test(id)) return { id, display: last.display };
  }
}
