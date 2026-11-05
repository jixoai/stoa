import { randomBytes } from "node:crypto";

/**
 * ULID: 48-bit timestamp (ms) + 80-bit randomness, Crockford base32 (26 chars).
 * Monotonic within the process so `(created_at, id)` keyset order never inverts
 * for rows created in the same millisecond.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom = 0n;
const MAX_RANDOM = (1n << 80n) - 1n;

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(value: bigint): string {
  let out = "";
  let v = value;
  for (let i = 0; i < RANDOM_LEN; i++) {
    out = ALPHABET[Number(v & 31n)]! + out;
    v >>= 5n;
  }
  return out;
}

export function newUlid(now = Date.now()): string {
  let time = Math.floor(now);
  if (time <= lastTime) {
    time = lastTime;
    if (lastRandom >= MAX_RANDOM) {
      // extremely unlikely: burn a millisecond
      time = lastTime + 1;
      lastRandom = 0n;
    } else {
      lastRandom += 1n;
    }
  } else {
    lastRandom = BigInt("0x" + randomBytes(10).toString("hex"));
  }
  lastTime = time;
  return encodeTime(time) + encodeRandom(lastRandom);
}

export function isUlid(value: string): boolean {
  if (value.length !== 26) return false;
  for (const ch of value) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}

export function ulidTime(value: string): number | null {
  if (!isUlid(value)) return null;
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ALPHABET.indexOf(value[i]!);
    if (idx < 0) return null;
    t = t * 32 + idx;
  }
  return t;
}
