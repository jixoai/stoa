/**
 * 认证模式媒体：`<img>` 不能带 Authorization，而媒体端点只认 Authorization
 * （design §13/§19）。因此按 hash 拉 blob → objectURL，全应用共享缓存。
 */
import { useEffect, useState } from "react";
import type { ReportClient } from "./api";

interface CacheEntry {
  promise: Promise<string>;
  url: string | null;
}

const cache = new Map<string, CacheEntry>();
let cacheEpoch = 0;

function keyOf(base: string, hash: string): string {
  return `${base}|${hash}`;
}

export function resolveMediaUrl(client: ReportClient, hash: string): Promise<string> {
  const key = keyOf(client.base, hash);
  const existing = cache.get(key);
  if (existing) return existing.promise;
  const entry: CacheEntry = {
    url: null,
    promise: Promise.resolve(""),
  };
  const epoch = cacheEpoch;
  entry.promise = client
    .mediaBlob(hash)
    .then((blob) => {
      if (epoch !== cacheEpoch) throw new Error("media cache cleared");
      const url = URL.createObjectURL(blob);
      entry.url = url;
      return url;
    })
    .catch((err) => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, entry);
  return entry.promise;
}

/** Object URLs live for the session; logout/switch backend clears them. */
export function clearMediaCache(): void {
  cacheEpoch += 1;
  for (const entry of cache.values()) {
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
  cache.clear();
}

export interface MediaState {
  url: string | null;
  error: string | null;
  loading: boolean;
}

export function useMediaUrl(client: ReportClient | null, hash: string | null | undefined): MediaState {
  const [state, setState] = useState<MediaState>({ url: null, error: null, loading: Boolean(client && hash) });

  useEffect(() => {
    if (!client || !hash) {
      setState({ url: null, error: null, loading: false });
      return;
    }
    let alive = true;
    setState({ url: null, error: null, loading: true });
    resolveMediaUrl(client, hash)
      .then((url) => {
        if (alive) setState({ url, error: null, loading: false });
      })
      .catch((err: Error) => {
        if (alive) setState({ url: null, error: err.message, loading: false });
      });
    return () => {
      alive = false;
    };
  }, [client, hash]);

  return state;
}
