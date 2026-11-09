# Stoa × ZCode 适配器（`adapters/zcode`）

ZCode 的接入面：**插件在 `stoa/`**，本文件只是目录说明。

- 安装/启用：把 `plugins.dirs` 指向 **`<stoa-repo>/adapters/zcode/stoa`**（不要指向本目录）。
  项目级 `.zcode/config.json` 或用宿主插件目录引用同一路径。
- 为什么多一层 `stoa/`：plugin-creator 标准要求**插件根目录名与 manifest `name` 一致**
  （`stoa/.zcode-plugin/plugin.json` 的 `name` 是 `stoa`），宿主按目录名识别插件；
  仓内又需要保留 `adapters/<harness>/` 的矩阵布局，所以用 `<harness>/<plugin-name>/`。
- 插件自己的能力（清单/钩子/命令/技能/薄桥启动器）见 **`stoa/README.md`**。
- MCP 业务实现全部在核心 `bun src/cli/main.ts mcp`，适配器不保留第二份实现。
- 冒烟：`bash scripts/qa/zcode-adapter-smoke.sh`（隔离板 13686 + HOME 沙箱）。
