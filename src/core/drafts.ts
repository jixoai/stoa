import { fail } from "./errors.ts";
import type { DraftStatus, WriteOp } from "./types.ts";
import { MAX_BATCH_ITEMS } from "./validation.ts";

/** Draft state machine: open -> committed | discarded (terminal states never reopen). */
export function assertDraftTransition(from: DraftStatus, to: DraftStatus): void {
  const allowed: Record<DraftStatus, DraftStatus[]> = {
    open: ["committed", "discarded"],
    committed: [],
    discarded: [],
  };
  if (!allowed[from].includes(to)) {
    fail("CONFLICT", `illegal draft transition ${from} -> ${to}`);
  }
}

export function parseDraftItems(itemsJson: string): WriteOp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(itemsJson);
  } catch {
    fail("INTERNAL", "draft items are corrupt (invalid JSON)");
  }
  if (!Array.isArray(parsed)) fail("INTERNAL", "draft items are corrupt (not an array)");
  return parsed as WriteOp[];
}

export function serializeDraftItems(items: WriteOp[]): string {
  return JSON.stringify(items);
}

export function assertCanAppend(count: number): void {
  if (count >= MAX_BATCH_ITEMS) {
    fail("BAD_REQUEST", `draft is full (max ${MAX_BATCH_ITEMS} items per batch)`);
  }
}

export function isTerminal(status: DraftStatus): boolean {
  return status !== "open";
}
