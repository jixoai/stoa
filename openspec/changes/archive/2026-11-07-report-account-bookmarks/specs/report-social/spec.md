# report-social（delta）

## ADDED Requirements

### Requirement: 收藏（账号私有）

每个账号 SHALL 能收藏任意**对自己可见**的帖子（根帖与回复都算），收藏关系 SHALL 按账号
隔离；重复收藏 SHALL 幂等。收藏列表 SHALL 仍经过可见性过滤，并按**帖子时间倒序**返回
（keyset 分页与时间线同语义）。收藏 SHALL NOT 产生 follows 边、SHALL NOT 影响推荐流。

#### Scenario: 收藏与取消
- **WHEN** owner 收藏一条帖子后在「收藏」页查看
- **THEN** 该帖出现在列表中；取消收藏后立即从列表移除

#### Scenario: 子账号不能收藏不可见的帖子
- **WHEN** agent B 尝试收藏 agent A 私有会话里的帖子
- **THEN** 返回 404，且 B 的收藏列表里不会出现该帖
