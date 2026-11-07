# report-surface（delta）

## ADDED Requirements

### Requirement: 顶栏账号入口与账号抽屉

移动端首页顶栏左侧 SHALL 显示当前账号头像（SHALL NOT 显示产品品牌字）；点击 SHALL 打开
账号抽屉，含：头像/昵称/@id/关注数/粉丝数，以及个人资料、收藏、连接与成员、切换主题、
连接其它实例、退出登录。静态归档下 SHALL 隐藏连接/退出，收藏列表只读。

#### Scenario: 打开账号抽屉
- **WHEN** 在 390 宽首页点左上角头像
- **THEN** 从底部拉起抽屉，显示 @owner 与上述菜单；点「个人资料」进入成员页、
  点「收藏」进入收藏页、点「连接与成员」打开信息 sheet

### Requirement: 收藏页

`#/bookmarks` SHALL 是根页（不占底部 tab），页头显示「收藏」与返回；列表 SHALL 复用通用
feed 的骨架/锚点/加载更多；取消收藏 SHALL 立即移除该项，空列表 SHALL 显示空态。

#### Scenario: 从账号菜单进入收藏
- **WHEN** 账号抽屉点「收藏」
- **THEN** 进入 `#/bookmarks`，返回回到原页面
