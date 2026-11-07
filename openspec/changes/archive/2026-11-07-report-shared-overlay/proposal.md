# Proposal: report-shared-overlay

## 背景

Owner 2026-11-07 走查两点：

1. **ViewTransition 没有通用化**：只有「主页 → 帖子」有 shared-element；从其它路径
   （通知 / 成员页 / 标签 / 收藏 / 回复卡）进详情没有形变动画。
2. **图片预览层返回无法关闭**：打开预览后按返回会离开页面而不是关预览；并要求对齐
   shadcn/ui 的标准实现（"不一定是 CloseWatcher 吧"）。

## 根因

1. `PostCard` 只在 `variant=feed|focal` 时登记 `view-transition-name`；通知行是裸
   `AuthorAvatar` 没有登记 → 旧快照一侧没有同名元素，浏览器只能做单侧淡入。
2. 预览层是手写 portal 浮层：有 `role=dialog`/Esc，但没有模态原语（焦点陷阱、背景 inert）
   也没有"返回关闭"。查 `@base-ui/react`（本仓 shadcn 底座）源码：**CloseWatcher 只接在
   Drawer**（仅 Android、监听 `cancel`）；Dialog/Sheet 只有 Esc/点遮罩。桌面返回键是历史
   导航，CloseWatcher 收不到——需要**合成历史条目 + popstate**。

## 变更内容

1. **共享元素命名通用化**：`feed / focal / reply / ancestor` 四种卡片全部登记；
   通知行在「展示的头像就是目标帖作者」时按目标帖登记，同一帖的多条通知只登记第一条
   （避免同名冲突导致整次转场被浏览器放弃）。
2. **预览层改用官方 Dialog**（`Dialog/DialogContent/DialogTitle`）承载模态语义，保留原有
   手势层（缩放/平移/左右切图/下滑关闭）。
3. **浮层返回关闭**（新 `lib/back-close.ts`）：打开时压一层同 URL 历史条目（`__overlay`），
   返回（按钮/手势/iOS 侧滑）先弹这层 → 关闭最上层浮层，路由不变；X/Esc 关闭时把条目弹回，
   不留死条目。抽屉/sheet 不压历史层（菜单项会导航，压栈关闭与路由 push 竞态）。

## 非目标

- 不给抽屉/sheet 加返回关闭（会与导航竞态）；它们保留 Esc/遮罩/拖拽关闭。
- 不做"转场中途取消"的共享元素回滚。
