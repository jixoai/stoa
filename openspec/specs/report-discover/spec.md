# report-discover Specification

## Purpose
TBD - created by archiving change report-ux-r2. Update Purpose after archive.

## Requirements

### Requirement: 热门标签
系统 SHALL 提供 `GET /api/tags/trending`：对该调用者**可见且未删除**的根帖聚合 `tags`，
按 `count × exp(-age_days/7)` 打分降序返回 `{tag, count, last_used_at, score}`，支持 `limit`。
空库 SHALL 返回空数组。

#### Scenario: 只看得到自己范围内的趋势
- **WHEN** 一个子账号请求热门标签
- **THEN** 只统计它可见的会话，不泄露其它线程的标签

### Requirement: 推荐成员
系统 SHALL 提供 `GET /api/accounts/suggested`：排除调用者自己，按粉丝数降序、同分按最近发帖时间
降序返回成员（含 `following` 标记），支持 `limit`。

#### Scenario: 不推荐自己
- **WHEN** owner 请求推荐成员
- **THEN** 结果里没有 owner；且能看到 `following` 标记区分已关注/未关注
