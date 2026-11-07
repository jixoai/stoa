# report-app-ui（delta）

## ADDED Requirements

### Requirement: 媒体预览层是模态 Dialog 且支持返回关闭

全屏媒体查看器 SHALL 使用官方 `Dialog` 原语承载模态语义（role/标题/焦点陷阱/背景 inert），
并可保留自定义手势层。打开时 SHALL 压一层同 URL 历史条目；平台的返回（按钮/手势/侧滑）
SHALL 关闭查看器而不是离开页面；通过 X/Esc 关闭时 SHALL 把该条目弹回，不留下死条目。
路由 SHALL NOT 因关闭查看器而改变。

#### Scenario: 预览中按返回
- **WHEN** 打开图片/视频预览后按浏览器返回（或 Android 返回手势）
- **THEN** 预览层关闭，URL 与所在帖子不变；再次返回才离开该页
