import { SLUG_RE } from "./validation.ts";

/**
 * Extract @mentions from markdown body. Ignores email-like prefixes (`foo@bar`)
 * and code fences/inline code (a report often quotes command output containing @).
 */
export function extractMentions(body: string): string[] {
  const withoutFences = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const re = /(^|[^A-Za-z0-9_@/])@([a-z][a-z0-9_-]{0,31})\b/g;
  const out: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutFences)) !== null) {
    const id = match[2]!;
    if (!SLUG_RE.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
