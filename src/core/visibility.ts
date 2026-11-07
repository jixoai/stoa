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

/**
 * SQL WHERE fragment selecting visible root ids for the viewer.
 *
 * `tableAlias` qualifies `root_id` for multi-table queries (`events e LEFT JOIN
 * posts p ON ...` has `root_id` on both sides; an unqualified fragment raises
 * `ambiguous column name: root_id`). Global roles return `1=1`, which names no
 * column, so the alias is irrelevant for them.
 */
export function visibleRootsClause(
  role: Role,
  accountId: string,
  tableAlias?: string,
): { sql: string; params: string[] } {
  if (isGlobalRole(role)) return { sql: "1=1", params: [] };
  const prefix = tableAlias ? `${tableAlias}.` : "";
  return {
    sql: `${prefix}root_id IN (SELECT root_id FROM participants WHERE account_id = ?)`,
    params: [accountId],
  };
}
