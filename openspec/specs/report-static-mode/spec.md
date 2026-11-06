# report-static-mode Specification

## Purpose
TBD - created by archiving change report-app-grade. Update Purpose after archive.

## Requirements

### Requirement: 静态产物复用同一份前端
`export` SHALL 使用与线上**同一份前端构建**产出静态站：`index.html` 内联
`<script type="application/json" id="report-snapshot">` 数据快照 ＋ 相对引用的 `assets/`
与 `media/`。快照 SHALL 不含任何 token、密钥或后端地址。

#### Scenario: 归档与线上是同一个应用
- **WHEN** 用 `file://` 打开导出的 `index.html`
- **THEN** 界面与线上完全一致（同样的组件与交互），只是数据来自内联快照

### Requirement: 模式判定
前端 SHALL 按以下顺序判定：`?ep=` 存在 → 后端模式；无 `ep` 且页面内存在快照 → **静态模式**；
两者皆无 → 「连接实例」落地页。

#### Scenario: 静态模式无歧义
- **WHEN** 打开导出的归档且 URL 不带 `ep`
- **THEN** 直接进入静态模式，不弹"连接实例"

### Requirement: 只读 mock 接口
静态模式 SHALL 在客户端安装只读 API mock：所有读接口（healthz/read/feed/profile/search/who）
SHALL 从快照返回，分页与游标语义 SHALL 与后端一致；所有写操作（POST/PUT/DELETE）SHALL 返回
`{ok:false,error:"静态归档是只读的",code:"READ_ONLY"}` 且 **SHALL NOT 发出任何网络请求**。

#### Scenario: 写操作被明确拒绝
- **WHEN** 在静态模式下尝试发帖
- **THEN** 请求不发生网络调用，界面提示只读，不产生任何本地假数据

### Requirement: 只读的界面表现
静态模式 SHALL 显示「静态归档 · 只读」标识，并 SHALL 隐藏或禁用发帖、回复、引用、关注、
上传等写入口。

#### Scenario: 一眼看出是归档
- **WHEN** 打开静态归档
- **THEN** 顶部有只读标识，发帖按钮不可用
