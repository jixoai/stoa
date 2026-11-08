import { describe, expect, test } from "bun:test";
import { makeStore } from "./helpers.ts";
import { NOTIFICATION_TYPES } from "../src/core/types.ts";
import { previewRowsForPost } from "../src/server/preview/queue.ts";
import { EventHub, type EventSourceLike } from "../src/ui/state/hub/event-hub.ts";
import type { HubDispatch } from "../src/ui/state/hub/types.ts";

const T0 = 1_700_000_000_000;

class FakeSource implements EventSourceLike {
  closed = false;
  onerror: ((event: unknown) => void) | null = null;
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const list = this.listeners.get(type);
    if (list) list.push(listener);
    else this.listeners.set(type, [listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data: unknown): void {
    this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("post.updated event (report-link-preview P1-7)", () => {
  test("store pushes post.updated but notifications/history/unread/CLI never see it", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const post = t.store.commitOps({
        author: "owner",
        batchId: "b",
        ops: [{ op: "post", body: "事件 https://example.com/event" }],
      }).posts[0]!;
      const row = previewRowsForPost(t.db, post.id)[0]!;
      t.store.applyPreviewPhase({
        postId: post.id,
        urlHash: row.url_hash,
        cacheKey: row.cache_key,
        phase: "meta",
        fields: { kind: "page", title: "事件标题", description: "摘要" },
        fieldsReady: ["kind", "title", "description"],
        status: "partial",
      });

      expect(NOTIFICATION_TYPES).toEqual(["post.created", "thread.invited"]);

      const lines = t.store.eventLines({
        viewer: { id: "owner", role: "owner" },
        since: 0,
      });
      const updated = lines.lines.filter((line) => line.type === "post.updated");
      expect(updated).toHaveLength(1);
      const payload = updated[0]!.payload as {
        post_id: string;
        root_id: string;
        phase: string;
        status: string;
        previews: Array<{ title: string | null; status: string }>;
      };
      expect(payload).toMatchObject({
        post_id: post.id,
        root_id: post.root_id,
        phase: "meta",
        status: "partial",
      });
      expect(payload.previews[0]!.title).toBe("事件标题");
      expect(JSON.stringify(payload)).not.toContain(post.body_md);

      const notifications = t.store.notificationLines("manager", 0);
      expect(notifications.lines.some((line) => line.type === "post.updated")).toBe(false);
      expect(notifications.target).toBeGreaterThan(0); // post.created 仍是通知

      const history = t.store.notificationHistory("manager", { limit: 50 });
      expect(history.events.some((event) => event.type === "post.updated")).toBe(false);

      const unreadBefore = t.store.unreadCount("manager", 0);
      t.store.applyPreviewPhase({
        postId: post.id,
        urlHash: row.url_hash,
        cacheKey: row.cache_key,
        phase: "cover",
        fields: { cover: { url: "https://cdn.example.com/c.png", w: 1, h: 1, kind: "og" } },
        fieldsReady: ["cover"],
        status: "ready",
      });
      expect(t.store.unreadCount("manager", 0)).toBe(unreadBefore);
    } finally {
      t.close();
    }
  });

  test("client EventHub routes post.updated and plugin.updated without notification.created", async () => {
    const source = new FakeSource();
    const hub = new EventHub({
      accountId: "owner",
      openUrl: async () => "http://x/api/stream?hub=2",
      createSource: () => source,
      jitterMs: 0,
    });
    const seen: HubDispatch["topic"][] = [];
    const unsubscribe = hub.subscribe(
      ["post.updated", "plugin.updated", "notification.created"],
      (dispatch) => seen.push(dispatch.topic),
    );
    try {
      hub.start();
      await flush();
      source.emit("hello", {
        hub: 2,
        account: "owner",
        role: "owner",
        cursor: 0,
        as_of_seq: 10,
        since: null,
        auth_mode: "open",
      });
      source.emit("hub", {
        seq: 11,
        type: "post.updated",
        actor: "manager",
        post_id: "p1",
        root_id: "p1",
        batch_id: "b",
        created_at: 1,
        payload: { post_id: "p1", phase: "cover", status: "ready", previews: [] },
      });
      source.emit("plugin.updated", { plugin_id: "link-preview", enabled: false, version: "1.0.0" });
      await flush();
      expect(seen).toEqual(["post.updated", "plugin.updated"]);
    } finally {
      unsubscribe();
      hub.stop();
    }
  });
});
