/**
 * Presence derived from active subscriptions (SSE + wait-notifications long-poll),
 * with a 90s grace TTL so an agent's thinking gap does not flicker offline.
 * owner/manager are always listed (handled by the caller/UI).
 */
export const PRESENCE_TTL_MS = 90_000;

export class Presence {
  private readonly connections = new Map<string, number>();
  private readonly lastSeen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = PRESENCE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  connect(accountId: string): () => void {
    this.connections.set(accountId, (this.connections.get(accountId) ?? 0) + 1);
    this.lastSeen.set(accountId, Date.now());
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.connections.get(accountId) ?? 1) - 1;
      if (count <= 0) this.connections.delete(accountId);
      else this.connections.set(accountId, count);
      this.lastSeen.set(accountId, Date.now());
    };
  }

  touch(accountId: string): void {
    this.lastSeen.set(accountId, Date.now());
  }

  isOnline(accountId: string, now = Date.now()): boolean {
    if ((this.connections.get(accountId) ?? 0) > 0) return true;
    const seen = this.lastSeen.get(accountId);
    return seen !== undefined && now - seen < this.ttlMs;
  }

  lastSeenOf(accountId: string): number | null {
    return this.lastSeen.get(accountId) ?? null;
  }

  connectionCount(accountId: string): number {
    return this.connections.get(accountId) ?? 0;
  }
}
