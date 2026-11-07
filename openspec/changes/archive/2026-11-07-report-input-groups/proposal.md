# Proposal: report-input-groups

## 背景

Owner 2026-11-07：「所有出现 input/textarea 的地方，都要反思一下，用官方的 InputGroup
组件，和功能按钮进行重组」。现状：搜索框是 `relative` + 绝对定位图标 + 旁置按钮，
登录/落地页是「输入框 + 下面一个按钮」，发帖框是独立 textarea + 底部操作栏——都不是
官方组合形态，按钮与输入的视觉/焦点关系也不一致。

## 变更内容

1. **收编官方 `InputGroup`**（base-nova registry 一手源，2026-11-07 取回，逐字保留；
   仅 import 路径适配本仓），含 `InputGroupInput/Textarea/Addon/Button/Text`。
2. **五处输入区重组**：
   - 搜索：图标 addon（inline-start）+ 输入 + 「搜索」按钮 addon（inline-end）；
   - 登录：密码框 + 行内「登录」按钮（type=submit，表单语义不变）；
   - 落地页：实例地址输入 + 图标 addon + 行内「连接」；
   - 发帖箱：整框一个 InputGroup（tabs 行 + 正文 `InputGroupTextarea` + 附件/发布操作行），
     引用卡与附件预览在框内，焦点环由组统一承担；
   - 隐藏的文件选择 input 保留（非可视控件）。
3. **门禁**：浏览器验收断言输入控件位于 `[data-slot="input-group"]` 内、按钮位于
   `input-group-addon` 内；`ui-lint` 继续禁止视图层手写原生 input/textarea。

## 非目标

- 不改变任何表单的提交语义/校验/testid；不改移动端键盘与滚动行为。
