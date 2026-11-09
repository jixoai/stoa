# report-social（delta）

## MODIFIED Requirements

### Requirement: 通知历史始终可见

系统 SHALL 提供 `GET /api/notifications/history?limit=50&before=<seq>`：返回该账号可见的
最近通知事件（按 seq 倒序），每条 SHALL 携带 `read` 布尔标记：该通知目标帖已存在于该账号的
服务端 `post_reads`，**或**该事件 `seq ≤ 该账号游标`，即为已读。接口 SHALL 返回账号
`cursor`、`has_more` 与下一页 `before`。可见性 SHALL 沿用 `visibleRootsClause`（非参与者
看不到私有会话事件）；REST 路径 SHALL 排除本人事件（与 peek 同口径），SSE 才 includeSelf。
分页 SHALL 用 `before` 做 keyset（严格小于），不得重复或跳过。`read` 标记的批量解析
SHALL 按页一次查询完成，SHALL NOT 逐行查询。

通知页 SHALL 默认展示历史列表：已读通知正常显示、未读通知仅以高亮区分；新事件 SHALL 继续
经 peek/SSE 增量并入列表。历史列表 SHALL 支持滚动到底与「加载更早」两种翻页方式。
静态归档模式 SHALL 只读（不发写请求）。

#### Scenario: 已读通知仍在列表里
- **WHEN** 账号有 3 条通知，其中 1 条已读
- **THEN** 通知页默认列表显示全部 3 条；已读项正常显示，未读项高亮，且 `read` 标记分别为真/假

#### Scenario: 历史分页
- **WHEN** 账号有 120 条可见通知，请求 `limit=50&before=<第 50 条 seq>`
- **THEN** 返回第 51–100 条（倒序），`has_more=true` 且 `next_before` 为下一条的 seq；不重复不跳号

#### Scenario: 可见性隔离
- **WHEN** agent 不是某私有会话的参与者
- **THEN** `history` 不返回该会话的通知事件；owner/manager 可见

#### Scenario: 本人事件不进 REST 历史
- **WHEN** 用户自己的发帖产生事件
- **THEN** `GET /api/notifications/history` 不返回 actor=本人的事件（SSE 才带）

#### Scenario: 逐帖已读后历史行转已读
- **WHEN** 用户在设备 A 停留读掉某帖（服务端 `post_reads` 已写入），随后设备 B 加载通知历史
- **THEN** 该帖的通知行在 B 上直接显示为已读（`read=true`），无需 B 本地有任何读缓存；
  历史行仍保留、不因已读而消失

### Requirement: 按帖已读（打开详情只标记该帖）

帖子被看见时（卡片在视窗停留达标，见「视窗停留标记已读」；详情页的 focal 卡同样按停留计时，
不再由路由进入触发）SHALL 只把**该帖**标记为已读（该帖的全部通知事件一并视为已读），
SHALL NOT 推进服务端游标，也 SHALL NOT 影响其它帖子的已读状态。路由跳转本身 SHALL NOT 触发
已读：文档不可见（后台标签页）时打开详情 SHALL NOT 标记。

已读 SHALL 按账号持久化在服务端 `post_reads(account_id, post_id, read_at)`；同一帖重复标记
SHALL 幂等（不新增行、不改变首次 `read_at`）。已读判定 SHALL 统一为「服务端 `post_reads`
命中 **或** 事件 `seq ≤ 已 ack 游标`」。客户端本地 read-set SHALL 仅作为**乐观缓存**
（即时 UI、离线可用），SHALL NOT 作为唯一真值：服务端已读的帖子 SHALL 在任何新设备/隐私窗口
首帧即显示为已读。本地缓存 SHALL 有界（最多保留最近 **2000** 个帖子 id，按最近读取时间
**LRU** 淘汰，localStorage 体积 SHALL <150KB/账号）；本地淘汰 SHALL NOT 使服务端已读的帖子
重新显示为未读（下一次读接口带回 `read=true`）。

停留命中 SHALL 先写本地缓存（即时 UI）再异步写服务端；写入失败 SHALL 进入本地重试队列，
在网络恢复、页面重新可见或 ready 时批量补写（每片 ≤100 个）。登录/ready SHALL 与服务端
对账：本地缓存中「服务端不存在且不在重试队列」的条目 SHALL 被丢弃（服务端为准）；
重试队列中的待写项 SHALL 保留并优先补写。静态归档 SHALL NOT 写入任何已读状态、SHALL NOT
发起已读同步请求。

「全部已读」SHALL 对当前通知目标批量写 `post_reads`，并 SHALL 保留推进服务端游标到当前
最大 seq 的兼容行为（响应游标校正本地水位），未读归零。未读角标 SHALL 与列表、服务端
`unread_by_target` 同源。

#### Scenario: N≥2 时只减一
- **WHEN** 通知列表有较新的 A 与较旧的 B 两条未读，用户只打开 A 的详情并停留达标
- **THEN** 未读角标精确减 1（不是归零），A 标为已读，B 仍为未读；服务端 `post_reads` 只多 A

#### Scenario: 同帖多条提醒一次读完
- **WHEN** 同一帖子有 2 条未读通知（如 post.created 与 thread.invited），用户在该帖停留达标
- **THEN** 该帖的 2 条通知都标为已读；其它帖子的通知不受影响

#### Scenario: 刷新与重载不丢历史
- **WHEN** 用户读掉 C、D 两条后点刷新，随后整页 reload
- **THEN** 通知历史仍包含 C、D 并显示为已读（服务端 `post_reads` 已记录；分页由 history
  接口补齐）

#### Scenario: 连续标记 600 条不复现未读
- **WHEN** 账号连续把 600 条不同帖子标为已读
- **THEN** 全部写入服务端并保持已读；本端缓存未超上限（600 < 2000）时逐条都在；
  不因刷新或重载重新显示未读

#### Scenario: 2000 条上限与体积
- **WHEN** 本地缓存达到 2001 条不同帖子
- **THEN** 只淘汰本端最久未读的 1 条（LRU），localStorage 值 <150KB/账号；被淘汰的那条
  仍因服务端读行显示为已读（不复活未读）

#### Scenario: 跨设备与隐私窗口一致
- **WHEN** 设备 A 读掉若干帖后，用户在隐私窗口（无任何 localStorage）用同一账号登录
- **THEN** 这些帖子在隐私窗口首帧即显示为已读，角标与设备 A 一致；不出现「已读帖重新变未读」
  的批量回潮

#### Scenario: 离线停留、恢复后补写
- **WHEN** 断网时用户停留读掉 3 帖，随后网络恢复
- **THEN** 3 帖在本端立即显示已读；重试队列在网络恢复后自动批量补写；另一设备随后可见已读

#### Scenario: 服务端为准的对账
- **WHEN** 本地缓存含帖子 X（服务端无该读行且重试队列也没有）
- **THEN** ready 对账后本地缓存丢弃 X，X 按服务端状态显示（未读或由游标覆盖）

#### Scenario: 本地缓存淘汰不复活已读
- **WHEN** 本地 read-set 超过 2000 条触发 LRU 淘汰，其中包括早已写入服务端的帖子
- **THEN** 被淘汰的帖子仍按服务端 `read=true` 显示为已读；不会重新出现未读高亮

#### Scenario: 后台打开详情不标已读
- **WHEN** 用户在后台标签页打开某帖详情（文档不可见），且从未切回前台
- **THEN** 该帖仍为未读；切回前台并停留达标后才标为已读

#### Scenario: 一键全部已读
- **WHEN** 通知列表有 N 条未读，用户点「全部标为已读」
- **THEN** 当前 N 个通知目标全部写入服务端 `post_reads`，服务端游标推进到当前最大 seq，
  未读角标归零；历史列表仍保留全部行（全部为已读）；另一设备同步为全部已读

### Requirement: 视窗停留标记已读（已读是帖子被看见的属性）

完整帖子卡片（`PostCard` 根节点 `data-post-id`）SHALL 在任意页面被视窗看见并停留达标后标记
已读，SHALL NOT 依赖路由事件（进入详情、点击、切换页面）。可见性 SHALL 满足：卡片可见面积
≥50%；**卡片高于视口时 SHALL 按「卡片可见高度 ÷ 视口高度 ≥50%」判定**（等价于对超视口卡片
取 `min(卡片高, 视口高)` 的 50%），且 `document.visibilityState === "visible"`。停留阈值 SHALL 为
`clamp(正文字符数 ÷ 80 字每秒, 400ms, 1500ms)`；卡片内含图片/视频 SHALL 再加 300ms
（不要求播放完）。写入 SHALL 同时更新该账号的**本地乐观缓存**（即时 UI）与**服务端按帖已读**
（异步、失败重试），SHALL NOT 推进服务端游标，SHALL NOT 影响其它帖子的已读状态。
服务端已读的帖子 SHALL 在渲染首帧即按已读呈现（不得先高亮再淡出）；只有本端停留触发的
未读→已读翻转才播放既有淡出动画。静态归档 SHALL NOT 写入。

#### Scenario: 时间线停留达标即已读
- **WHEN** 用户把某条未读帖滚入视口、可见面积 ≥50% 并停留超过阈值
- **THEN** 该帖立即转入本地缓存（UI 立即转已读）；通知列表中同帖的未读提醒同步转已读、
  角标相应减少；服务端随后收到该帖的已读写入；服务端游标保持不变

#### Scenario: 服务端已读首帧即已读
- **WHEN** 另一设备/隐私窗口打开含已读帖的时间线
- **THEN** 该帖首帧即为已读（无未读底色与强调条），不播放入场淡出动画

#### Scenario: 快速滚过不标记
- **WHEN** 用户以远快于阈值的速度滚过整屏帖子，没有在任何一张卡上停留达标
- **THEN** 这些帖子仍为未读，本地缓存与服务端均无新增

#### Scenario: 媒体加时
- **WHEN** 两张正文字符数相同的帖子，一张含图片/视频、一张纯文本，均被停留
- **THEN** 含媒体的帖子阈值比纯文本多 300ms；两者都达到各自阈值后才标记

#### Scenario: 超视口长帖只露一半视口也标已读
- **WHEN** 一条高度超过 2 屏的长帖被滚动到只露出约 50% 视口高度
- **THEN** 停留达到该帖阈值后标为已读；不得因为整卡永远无法 ≥50% 可见而永不标记

## ADDED Requirements

### Requirement: 未读由服务端已读集合计算

未读数与按 target 未读 SHALL 由「通知目标集合 − 该账号 `post_reads`」计算，并 SHALL 叠加
既有游标上界（仅统计 `seq > 账号游标` 的事件）。同一帖的多条通知 SHALL 按 target 去重，
角标对同一帖只计 1；`unread_count` SHALL 为满足条件的事件数（同帖多事件按事件计）。
软删帖 SHALL NOT 计为未读。事件无 `post_id` 时 SHALL 退化为仅按游标判定。
账号级游标 SHALL 保留（CLI/兼容与「全部已读」兜底），但 SHALL NOT 作为 UI 未读的唯一真值。

#### Scenario: 逐帖读完角标精确减一
- **WHEN** 服务端未读 target 为 {A,B}（A 有 2 条事件、B 有 1 条），用户读掉 A
- **THEN** `unread_by_target` 只剩 B；角标由 2 变 1；`unread_count` 由 3 变 1

#### Scenario: 跨设备未读一致
- **WHEN** 设备 A 读掉若干帖后，设备 B 首次加载通知页
- **THEN** B 的角标与 `unread_by_target` 与 A 完全一致（不依赖 B 的本地缓存）

#### Scenario: 软删帖不计未读
- **WHEN** 某未读通知的目标帖被软删
- **THEN** 该 target 立即从 `unread_by_target` 与角标移除；历史行仍保留（灰显、不计未读）

#### Scenario: 已读帖的新事件不复活未读
- **WHEN** 某帖已被逐帖标记已读，之后该帖又产生一条通知事件
- **THEN** 该帖仍为已读，不计入未读角标（按帖已读语义；通知历史保留新事件行）
