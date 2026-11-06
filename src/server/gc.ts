import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  LOCK_JSON,
  SERVER_JSON,
  pidAlive,
  probeHealth,
  readLock,
  readServerInfo,
  serverInfoPath,
  type ServerInfo,
} from "./discovery.ts";

export type GcReason = "pid-dead" | "healthz-unreachable" | "orphan-lock";

export interface GcRemoved {
  path: string;
  kind: "server.json" | "serve.lock";
  reason: GcReason;
}

export interface GcResult {
  data_dir: string;
  removed: GcRemoved[];
}

function remove(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function removeLock(dataDir: string, reason: GcReason, removed: GcRemoved[]): void {
  const path = join(dataDir, LOCK_JSON);
  if (remove(path)) removed.push({ path, kind: "serve.lock", reason });
}

/**
 * Reclaim残留 (design §1): remove `server.json` / `serve.lock` left behind by a
 * crashed or wedged instance. Only the given data dir is touched, and running
 * (`/healthz`-reachable) instances are never disturbed. Idempotent: a second
 * run finds nothing and reports an empty `removed` list.
 */
export async function garbageCollect(dataDir: string): Promise<GcResult> {
  const removed: GcRemoved[] = [];
  const info: ServerInfo | null = readServerInfo(dataDir);
  if (info) {
    const alive = pidAlive(info.pid);
    const healthy = alive && (await probeHealth(info));
    if (!alive || !healthy) {
      const reason: GcReason = alive ? "healthz-unreachable" : "pid-dead";
      const path = serverInfoPath(dataDir);
      if (remove(path)) removed.push({ path, kind: "server.json", reason });
      // The lock belongs to the same instance whenever it names this pid/instance;
      // a lock from some other process is left alone.
      const lock = readLock(dataDir);
      if (!lock || lock.pid === info.pid || lock.instanceId === info.instanceId) {
        removeLock(dataDir, reason, removed);
      }
    }
    return { data_dir: dataDir, removed };
  }

  // No server.json: the only thing worth reclaiming is a lock whose owner is gone.
  const lockPath = join(dataDir, LOCK_JSON);
  if (!existsSync(lockPath)) return { data_dir: dataDir, removed };
  const lock = readLock(dataDir);
  if (!lock || !lock.pid || !pidAlive(lock.pid)) {
    removeLock(dataDir, "orphan-lock", removed);
  }
  return { data_dir: dataDir, removed };
}
