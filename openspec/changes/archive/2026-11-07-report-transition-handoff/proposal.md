# Proposal: report-transition-handoff（第三轮）

## 背景

Owner 复测「第二次还是抖」。用 rAF 逐帧记录**真实 DOM 几何**（不是录屏/CLS）定位到：
转场播放期间，目标页仍在被网络回填改变——

```
BEFORE（app-DHLE_7PY，第二次导航，详情→详情）
 6880ms cardTop=49 scroll=12 sh=951 skel=true  vt=forward   ← 快照拍下的是这一帧
 6982ms cardTop=61 scroll=0  sh=739 skel=false vt=forward   ← 转场还没结束，页面已换掉
 7281ms vt=null                                             ← 快照撤掉 → 肉眼看到 212px 跳变
```

两个具体原因：
1. `ThreadPage` 的网络结果在转场期间直接 `setThread`：种子（合成焦点帖 + 回复骨架，951px）被真实线程（739px，无回复）整页替换，快照与落位不一致。
2. 焦点锚点用 `scrollIntoView`，浏览器把它算成 `scrollTop=12`；数据回填后二次锚点又归零 → 内容上下 12px 抖动。

## 变更内容

1. **转场期间禁止回填**：`router` 暴露 `isViewTransitionRunning()` / `useTransitionEpoch()`；
   `ThreadPage` 在转场中把网络结果挂起（`heldThread`），转场结束的 epoch 变化时才落地。
2. **骨架→内容只在转场结束后动画交接**：`ContentSwap` 增加转场门禁；线程页的回复区
   （回复数 + 列表）单独用 `ContentSwap`，骨架改为紧凑行（高度差 16px），转场结束后做
   高度过渡 + 淡入。
3. **焦点锚点确定性**：不再用 `scrollIntoView`，直接计算焦点帖在滚动容器内的偏移并设置
   `scrollTop = max(0, offset - 60)`；组件按路由重建后不再重复清锚点。
4. **门禁扩展**：`stable.mjs` 断言「转场播放期间页面几何完全不变」（thread scrollHeight +
   焦点帖顶端取唯一值）、「回复区骨架→内容首帧必须 vt=null」、二次导航同样约束；
   移动/桌面各 32 项。

## 非目标

- 不改时间线/成员页的既有交互；它们的列表回填已在 `ContentSwap` 门禁内。
- 不为 4px 的 `report-swap-in` 上浮改变设计（这是「用动画替换骨架」的一部分）。
