# Tasks: report-transition-handoff

- [x] 1.1 `router`：`isViewTransitionRunning()` / `useTransitionEpoch()`；每次转场结束（含 skip/失败兜底）结算并广播
- [x] 1.2 `ContentSwap`：数据到位但转场仍在播放时等待 epoch，转场结束后再做高度过渡 + 交叉淡入
- [x] 1.3 `ThreadPage`：`heldThread` 挂起网络结果；回复区独立 `ContentSwap`（紧凑骨架，高度差 16px）
- [x] 1.4 焦点锚点改确定性 `scrollTop`（`offset - 60`），移除重复清锚
- [x] 1.5 门禁：转场播放期间几何唯一值；回复区交接首帧 `vt=null`；移动/桌面 32/32
- [x] 1.6 rAF 前后对照留证（BEFORE：转场内 951→739、cardTop 49→61；AFTER：转场内恒 755/61，结束后 755→739 动画）
- [x] 1.7 部署 `app-BNl0s6UW` 并在正式域名复跑 32/32 ×2
