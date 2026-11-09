# report-app-ui (delta)

## ADDED Requirements

### Requirement: 帖子操作条纯图标与分享面板

列表/线程中的帖子操作条（回复、引用、收藏、分享）SHALL 只显示图标，SHALL NOT 显示
可见文字标签；每个按钮 SHALL 有可读的 `aria-label`/`title`。回复数 SHALL NOT 以文本
形式出现在操作条（可进无障碍标签）。

「分享」按钮 SHALL 打开官方 Popover 面板，至少包含：
- 复制链接（成功后可显示已复制态）；
- 系统原生分享（`navigator.share` 可用时；含「微信」项走系统分享）；
- 常用社交直达：微博、QQ、X、Telegram、邮件。
所有分享 URL SHALL 使用帖子 canonical 链接（`postLink(id)`）。社交项 SHALL 在新窗口
打开并带 `noopener,noreferrer`；静态归档 SHALL 同样可分享。

#### Scenario: 操作条无文字
- **WHEN** 在 390 或 1280 打开列表页
- **THEN** 四个操作按钮的可见文本为空（仅图标），`aria-label` 分别为回复/引用/收藏/分享

#### Scenario: 分享面板
- **WHEN** 点击分享按钮
- **THEN** 出现分享面板，含复制链接、系统分享（支持时）、社交直达项；点击复制后剪贴板为
  `postLink(id)`，点击微博等在 `window.open` 收到带 canonical URL 的地址

#### Scenario: 无原生分享
- **WHEN** 环境不支持 `navigator.share`
- **THEN** 系统分享/微信项隐藏，复制与社交直达仍可用
