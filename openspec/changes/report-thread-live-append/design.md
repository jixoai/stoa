# Design: report-thread-live-append

## §1 现状与根因（path:line，3468b11 基线）

- `src/ui/pages/ThreadPage.tsx:548-579` — hub 订阅：`post.created` 命中本线程（root_id/post_id）→
  `scheduleRefresh()`（350ms 去抖）。
- `src/ui/pages/ThreadPage.tsx:474-521` — 静默 `load(true)`：`countAddedInScope(prev, next) > 0` →
  `setPendingThread(next); setNewReplyCount(added)`；**不提交**。
- `src/ui/pages/ThreadPage.tsx:853-858` — `mergePending`：只有点击胶囊才 `setThread(pendingThread)`。
- 结论：拉取与差集都是实时的，**渲染滞后一步**（等点击）。Owner 期望零点击追加。

## §2 目标语义（silent commit 状态机）

静默路径检出 `added > 0` 时：

1. `samePage` 门（freshRef/同 focal/同 root）保持——种子、陈旧缓存首提交仍走直接提交（防幻影提示）。
2. **提交前**测量 `atBottom = 距底 ≤ 64px`（在 commit 前读 DOM，避免被新高度污染）。
3. `commitThread(next, true)` — 自动进入 DOM（含 `loaded` 与 `freshRef` 维护）。
4. 分支：
   - `atBottom` → 贴底跟随：`followBottomRef = true`，由 ThreadAnchoring 在本次 layout 帧消费
     （滚到底 + 解锚 + 更新首可见基线）；**不**出提示。
   - `!atBottom` → 出提示：`newReplyCount += added`（累积）。
5. `added === 0` → 不提交、不提示（兄弟分支静默，口径不变）。

## §3 滚动所有权（ThreadAnchoring 唯一出口）

`ThreadAnchoring`（`ThreadPage.tsx:265-376`）新增 `followBottomRef` 属性，在其 layout effect 顶部优先消费：

```
if (followBottomRef.current) {
  followBottomRef.current = false;
  max = container.scrollHeight - container.clientHeight;
  programmaticTop.current = max; container.scrollTop = max;   // 程序化标记：不触发解锁误判
  anchorLocked.current = false;                                // 视图已由我们定位：后续走首可见行补偿，不再回贴 focal
  anchoredFor.current = postId;
  lastFirstRef.current = readFirstVisible(container);
  return;
}
```

原因：锚定/补偿逻辑**只允许一处写 scrollTop**（report-motion-stability 纪律）；跟随贴在既有
`anchoredFor/lastFirstRef/programmaticTop` 记账上，避免双写打架。

## §4 跳转锚点（firstAddedInScope）

`thread-plan.ts` 新增：

```ts
export function firstAddedInScope(prev: TimelinePlan | null, next: TimelinePlan | null): string | null
```

`next.replyNodes`（plan 先序序）中首个不在 `prev.replyNodes` 的节点 id；null = 只有折叠子树计数增长
（无新行）→ 提示点击回退滚到底。与 `countAddedInScope` 同作用域口径（focal 子树；祖先/兄弟分支不计）。

## §5 提示（复用 `new-replies-pill`）

- 文案「{N} 条新回复」，N 上限显示 `99+`；仅在 `N>0` 时渲染（贴底场景恒不渲染）。
- 点击 → 滚动到第一条新回复行（`scrollIntoView({block:"nearest"})` 语义在容器内实现：直接
  `programmaticTop` + `scrollTop` 计算），并清计数。
- 容器滚动静默采样（rAF 节流）：距底 ≤64px → 清计数（用户自行回到实时位）。
- 路由切换 / 转场 flush：清计数与 `followBottomRef`（`ThreadPage.tsx:429-448 / 523-538` 既有清零点扩展到 follow 标记）。

## §6 删除的旧机制

- `pendingThread` state 与 `mergePending` 合并路径移除（没有「待合并快照」概念了）。
- 保留：`freshRef/samePage`（防幻影）、兄弟分支静默、`post.deleted`→`load(false)`、
  `stream.reset`→重取、`stream.reconnected`→补拉。

## §7 不做 / 边界

- 不特殊处理「新回复插入已渲染子树中部」：首可见行补偿已保证视口不打扰；贴底时中间插入不可见属
  可接受边界（与 X 一致）。
- 贴底跟随为单次定位；图片/字体迟到加载导致轻微离底接受（下一次推送继续校正）。
- 首页 feed 胶囊、通知页实时语义不动。

## §8 风险与缓解

- 跟随与锚定双写 → 已定唯一出口（§3）。
- 连发多条：350ms 去抖 + 累积计数；贴底场景自然跟随，无提示闪烁。
- 无障碍：提示按钮保留 `aria-label`；行追加不做移动焦点。
