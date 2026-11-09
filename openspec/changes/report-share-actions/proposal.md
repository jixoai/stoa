# Proposal: report-share-actions（列表操作条纯图标 + 分享面板）

## Why

Owner 2026-11-09：列表页操作条的文字按钮（回复/引用/收藏/复制链接）视觉噪音大；
「复制链接」只是单一动作，缺少分享能力。要求操作条改成纯图标，复制链接升级为
「分享」面板：复制链接、系统原生分享、常用社交软件直接分享。

## What Changes

- `PostCard` 操作条四键（回复/引用/收藏/分享）只保留图标与无障碍标签，移除可见文字
  （回复数不再以文本显示，保留在 aria-label/title）。
- 新增 `ShareMenu`（官方 Popover + Button）：复制链接、系统分享（`navigator.share`，
  可用时含「微信」走系统分享）、微博/QQ/X/Telegram/邮件 直达分享链接。
- 所有分享 URL 使用 canonical `postLink(post.id)`；静态归档同样可用（只读不影响分享）。
- 新增 QA `share-actions.mjs`：icon-only/分享面板/复制/原生分享 mock/社交直达链接/
  390-1280 无溢出/无 console error。

## Impact

`src/ui/components/PostCard.tsx`、新增 `src/ui/components/ShareMenu.tsx`、
`scripts/qa/share-actions.mjs`、`scripts/qa/README.md`、spec `report-app-ui`。
无服务端契约变更。
