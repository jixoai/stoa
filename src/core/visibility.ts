import type { Role } from "./types.ts";

export function isGlobalRole(role: Role | string): boolean {
  return role === "owner" || role === "manager";
}

/**
 * Pure visibility predicate (the SQL path mirrors this in store.ts):
 * - owner/manager: everything;
 * - agent: only conversations (root_id) where the account is a participant
 *   (author / @-mentioned / replied), and then the whole tree.
 */
export function canViewRoot(opts: {
  role: Role;
  rootId: string;
  rootParticipants: ReadonlySet<string> | readonly string[];
  accountId: string;
}): boolean {
  if (isGlobalRole(opts.role)) return true;
  const set =
    opts.rootParticipants instanceof Set
      ? opts.rootParticipants
      : new Set(opts.rootParticipants);
  void opts.rootId;
  return set.has(opts.accountId);
}

/** SQL WHERE fragment selecting visible root ids for the viewer. */
export function visibleRootsClause(
  role: Role,
  accountId: string,
): { sql: string; params: string[] } {
  if (isGlobalRole(role)) return { sql: "1=1", params: [] };
  return {
    sql: "root_id IN (SELECT root_id FROM participants WHERE account_id = ?)",
    params: [accountId],
  };
}
