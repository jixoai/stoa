# Tasks: report-share-actions

- [x] P1-1. `ShareMenu` 组件：Popover 面板（复制链接/系统分享/微信[native]/微博/QQ/X/
  Telegram/邮件）；canonical `postLink`；`navigator.share` 不可用时隐藏系统/微信项；
  复制成功态；动作后关闭面板。
- [x] P1-2. `PostCard` 操作条 icon-only（reply/quote/bookmark/share），移除可见文字；
  aria-label/title 保留语义；删除仅服务于复制按钮的长按/右键逻辑。
- [x] P1-3. QA `scripts/qa/share-actions.mjs`：四键无文本、分享面板、复制到剪贴板、
  mock `navigator.share` 收到 URL、社交直达 `window.open` URL、390/1280 无横向溢出、
  既有 bookmark 选择器不回归、0 console error；README 登记。
- [x] P1-4. 绿门：`bun test` 488/488、`check`、`typecheck:ui`、`build`；share-actions 8/8；
  `thread-timeline` V7b iconLeft=68（修复 icon-only 后首图标偏移 6px）。
- [x] 复核修复：操作条首图标墨迹对齐（容器/首键 -ml-3.5）；复制成功 toast「链接已复制」
  （并加断言）；Skeletons 操作条改 4×44 紧排；回复数进 aria-label；README 登记；
  无 navigator.share 降级场景入 QA；longform delta 操作栏文案同步为分享。
