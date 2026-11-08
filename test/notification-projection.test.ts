/**
 * 通知投影单测（design §4.7，P1-11 判据）：重复帧、删除多事件、read-set 缺口、
 * post_deleted 不计数、对账自愈、ack 唯一清空。
 */
import { describe, expect, test } from "bun:test";
import { NotificationProjection } from "../src/ui/state/hub/notification-projection.ts";
import type { HubEventLine } from "../src/ui/state/hub/types.ts";

function line(
  seq: number,
  over: Partial<Pick<HubEventLine, "type" | "actor" | "post_id" | "root_id" | "post_deleted">> = {},
): HubEventLine {
  return {
    seq,
    type: over.type ?? "post.created",
    actor: over.actor ?? "manager",
    post_id: over.post_id === undefined ? "post-a" : over.post_id,
    root_id: over.root_id === undefined ? "post-a" : over.root_id,
    batch_id: "b",
    created_at: 1,
    payload: { parent_id: null, root_id: "post-a" },
    ...(over.post_deleted === undefined ? {} : { post_deleted: over.post_deleted }),
  };
}

describe("NotificationProjection（每帖角标 + read-set）", () => {
  test("快照：不同 target 数 = 角标；事件数只用于漂移对账", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({
      cursor: 0,
      unreadCount: 5,
      unreadByTarget: { "post-a": 3, "post-b": 2 },
    });
    expect(projection.badge(new Set())).toBe(2);
    expect(projection.unreadTargetCount()).toBe(2);
    expect(projection.expectedUnreadEvents()).toBe(5);
  });

  test("一次 @ 产生 post.created + thread.invited：同帖角标只 +1", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({ cursor: 0, unreadCount: 0, unreadByTarget: {} });
    expect(projection.applyEvent(line(1))).toBe(true);
    expect(projection.applyEvent(line(2, { type: "thread.invited" }))).toBe(true);
    expect(projection.badge(new Set())).toBe(1);
    expect(projection.expectedUnreadEvents()).toBe(2);
  });

  test("重复帧幂等：同 seq 只计一次", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({ cursor: 0, unreadCount: 0, unreadByTarget: {} });
    expect(projection.applyEvent(line(3))).toBe(true);
    expect(projection.applyEvent(line(3))).toBe(false);
    expect(projection.badge(new Set())).toBe(1);
    expect(projection.expectedUnreadEvents()).toBe(1);
  });

  test("read-set：打开该帖详情后角标 -1，游标不变", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({
      cursor: 0,
      unreadCount: 2,
      unreadByTarget: { "post-a": 1, "post-b": 1 },
    });
    expect(projection.badge(new Set())).toBe(2);
    expect(projection.badge(new Set(["post-a"]))).toBe(1);
    expect(projection.cursor).toBe(0);
  });

  test("read-set 命中但服务端地图未加载该 target：不影响其它 target", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({
      cursor: 0,
      unreadCount: 1,
      unreadByTarget: { "post-b": 1 },
    });
    expect(projection.badge(new Set(["post-a"]))).toBe(1);
  });

  test("post_deleted=true 的 created 帧不计数", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({ cursor: 0, unreadCount: 0, unreadByTarget: {} });
    projection.applyEvent(line(4, { post_deleted: true }));
    expect(projection.badge(new Set())).toBe(0);
    expect(projection.expectedUnreadEvents()).toBe(0);
  });

  test("自身事件不计数", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({ cursor: 0, unreadCount: 0, unreadByTarget: {} });
    projection.applyEvent(line(5, { actor: "owner" }));
    expect(projection.badge(new Set())).toBe(0);
  });

  test("seq ≤ cursor 的旧事件不计数", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({ cursor: 10, unreadCount: 0, unreadByTarget: {} });
    projection.applyEvent(line(7));
    expect(projection.badge(new Set())).toBe(0);
    expect(projection.expectedUnreadEvents()).toBe(0);
  });

  test("删除未读帖：多事件逐条标记、角标扣减、排对账", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({ cursor: 0, unreadCount: 0, unreadByTarget: {} });
    projection.applyEvent(line(11));
    projection.applyEvent(line(12, { type: "thread.invited" }));
    projection.applyEvent(line(13, { post_id: "post-b", root_id: "post-b" }));
    expect(projection.badge(new Set())).toBe(2);

    const result = projection.applyDelete("post-a", "post-a");
    expect(result.needsReconcile).toBe(true);
    expect(projection.badge(new Set())).toBe(1);
    expect(projection.expectedUnreadEvents()).toBe(1);
    // 幂等：同一 target 再删一次不再扣
    projection.applyDelete("post-a", "post-a");
    expect(projection.expectedUnreadEvents()).toBe(1);
  });

  test("删除服务端已知 target：从 by_target 扣减", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({
      cursor: 0,
      unreadCount: 3,
      unreadByTarget: { "post-a": 2, "post-b": 1 },
    });
    projection.applyDelete("post-a", "post-a");
    expect(projection.badge(new Set())).toBe(1);
    expect(projection.expectedUnreadEvents()).toBe(1);
  });

  test("cursor 帧（多端已读）：游标落地、未读清空", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({
      cursor: 0,
      unreadCount: 2,
      unreadByTarget: { "post-a": 1, "post-b": 1 },
    });
    projection.applyCursor(20, 0);
    expect(projection.cursor).toBe(20);
    expect(projection.badge(new Set())).toBe(0);
    expect(projection.expectedUnreadEvents()).toBe(0);
  });

  test("对账快照吸收本地增量（不翻倍）+ 事件 union 不重复", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({ cursor: 0, unreadCount: 0, unreadByTarget: {}, events: [line(1)] });
    projection.applyEvent(line(2));
    expect(projection.expectedUnreadEvents()).toBe(1);
    expect(projection.badge(new Set())).toBe(1);

    projection.applySnapshot({
      cursor: 0,
      unreadCount: 2,
      unreadByTarget: { "post-a": 2 },
      events: [line(1), line(2)],
    });
    expect(projection.expectedUnreadEvents()).toBe(2);
    expect(projection.badge(new Set())).toBe(1); // 仍是同一帖子的一行
    expect(projection.events.size).toBe(2);
  });

  test("ack 的清空：clearEvents 后列表事件为空", () => {
    const projection = new NotificationProjection("owner");
    projection.applyEvent(line(1));
    projection.applyCursor(1, 0);
    projection.clearEvents();
    expect(projection.events.size).toBe(0);
  });

  test("乱序快照：ack 之后到达的旧 peek 不把角标顶回去", () => {
    const projection = new NotificationProjection("owner");
    projection.applySnapshot({
      cursor: 3,
      unreadCount: 2,
      unreadByTarget: { "post-a": 1, "post-b": 1 },
    });
    expect(projection.badge(new Set())).toBe(2);

    // ack 推进到 20 并清空未读
    projection.applyCursor(20, 0);
    expect(projection.badge(new Set())).toBe(0);

    // ack 之前发出的 peek（cursor=3）现在才回来：只 union 事件，不覆盖计数
    projection.applySnapshot({
      cursor: 3,
      unreadCount: 2,
      unreadByTarget: { "post-a": 1, "post-b": 1 },
      events: [line(4, { post_id: "post-c", root_id: "post-c" })],
    });
    expect(projection.cursor).toBe(20);
    expect(projection.badge(new Set())).toBe(0);
    expect(projection.events.has(4)).toBe(true);
  });
});
