# report-surface（delta）

## ADDED Requirements

### Requirement: 未读帖高亮与已读淡出

凡渲染完整帖子卡片的页面（feed / 线程 / 搜索 / 收藏 / 成员页 / 详情）SHALL 用同一 read-set
判定未读：未读帖 SHALL 显示整卡淡底与左侧强调条，强调条 SHALL 画在卡片左缘 **x=0..3（宽
3px）**，SHALL NOT 与线程主轨（**x=38..40，宽 2px**）重叠。帖子停留达标瞬间 SHALL 播放约
1.2 秒的背景淡出并由未读转已读，强调条 SHALL 在约 200ms 内淡出；
`prefers-reduced-motion: reduce` 时 SHALL 直接切换、无过渡。
新到达的帖子在进入列表时 SHALL 有短暂高亮（不超过 1 秒），随后回到未读底色。高亮 SHALL NOT
改变卡片的内边距、行高或外框尺寸（CLS = 0）；选中态 SHALL 压过未读底色。

#### Scenario: 两视口高亮形态
- **WHEN** 在 390×844 与 1280×800 打开含未读帖的 feed
- **THEN** 未读卡有整卡淡底与 3px 左强调条；强调条不与 x=38..40 的线程导轨重叠；
  卡片高度与无高亮时一致

#### Scenario: 达标淡出
- **WHEN** 某未读帖停留达到阈值
- **THEN** 该卡背景在约 1.2 秒内淡到透明、强调条 200ms 内消失，`data-read` 变为 `"1"`；
  其它卡片与列表滚动位置不变

#### Scenario: 减少动态效果
- **WHEN** 系统开启「减少动态效果」并停留达标
- **THEN** 未读底色立即消失、无 1.2 秒过渡；新帖入场也不播放动画（未读底色仍显示）

#### Scenario: 强调条几何
- **WHEN** 在线程页与 feed 各取一条未读卡，读取强调条与 `[data-testid="thread-rail"]` 的矩形
- **THEN** 强调条 left=0、width=3（x∈[0,3]）；线程导轨 left=38、width=2（x∈[38,40]）；
  两矩形不相交；卡片高度与无高亮时一致

#### Scenario: 新帖入场高亮
- **WHEN** 新帖经实时推送进入列表并在顶部被吸收
- **THEN** 新行在不超过 1 秒内有一次背景高亮，之后保留未读底色直到被停留读完

### Requirement: 停留观察的全局单观察器与性能预算

视窗停留观察 SHALL 在每个文档内全局复用**一个** `IntersectionObserver`，由所有完整帖子卡片
共享；SHALL NOT 为每张卡片各建一个。卡片挂载 SHALL 注册、卸载 SHALL 注销；引擎 SHALL NOT
监听滚动事件、SHALL NOT 每帧 setState。标记单帖 SHALL 只让该卡片重渲染（或只改该卡片属性），
SHALL NOT 触发整列表重渲染。200 帖长列表 SHALL 满足：观察器实例 = 1、观察目标 ≤ 已挂载未读卡数、
无单次 >50ms 的引擎长任务。

#### Scenario: 200 帖只有一个观察器
- **WHEN** feed 加载 200 条帖子并连续滚动
- **THEN** 页面内 `IntersectionObserver` 实例数为 1，观察目标数 ≤200；滚动全程无 >50ms 的
  引擎长任务

#### Scenario: 单帖标记不重渲染列表
- **WHEN** 200 帖列表中某一张卡停留达标
- **THEN** 只有该卡的 `data-read`/背景变化；其它 199 张卡的 DOM 节点身份与属性不变，
  列表父级不因标记而重新渲染

#### Scenario: 卸载即注销
- **WHEN** 切换路由或卡片被移除
- **THEN** 对应观察目标被注销、计时器清零；跟踪集合为空时观察器断开
