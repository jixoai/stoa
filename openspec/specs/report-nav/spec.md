# report-nav Specification

## Purpose

定义导航壳的细节语义：tab 切换不产生历史记录、根页关闭提醒的触发条件、移动端 header 的呈现与行为。

## Requirements

### Requirement: tab 切换不产生历史
底部 tab 切换 SHALL 使用 `replaceState`；进入详情/成员/标签/发帖 SHALL 使用 `pushState`。
返回 SHALL 回到上一个页面而不是上一个 tab。

#### Scenario: 切三个 tab 后返回只按一次
- **WHEN** 用户在主页两个 tab 间来回切换后按返回
- **THEN** 直接回到进入主页之前的页面，不需要连按

### Requirement: 根页关闭提醒
在根页（无子页可回）再次返回 SHALL 触发关闭确认；SHALL 优先使用 `CloseWatcher`，
不支持时 SHALL 用合成历史条目拦截。子页 SHALL NOT 拦截返回。

#### Scenario: 误触返回不直接关页
- **WHEN** 用户在根页执行返回手势
- **THEN** 出现「离开 report？」确认；取消则留在原页

### Requirement: 移动端 header
移动端首页 SHALL NOT 显示页面标题（tabs 即标题）；header 右侧 SHALL 提供入口拉起 sheet，
内容为连接信息与成员列表（与桌面右栏共用组件）。

#### Scenario: 手机上也能看到成员与连接信息
- **WHEN** 在 390 宽首页点 header 右侧按钮
- **THEN** 从底部拉起 sheet，含实例地址/模式/身份与成员列表，可点成员进成员页
