# 给 TUI 接 `config-editor` 的配置编辑面（接取条目：`TUI/docs/BACKLOG.md`「#4 给 TUI 接 `config-editor` 的配置编辑面」）

状态：进行中（仅接取：本文档已建，调研未开始）　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给 TUI 一个**受控的配置编辑面**：用户改某个插件条目的 config 时，走 `ctx.configEditor.edit()`（写盘前校验完整候选值 → 原子写 profile patch → 与 profile 变更 / HMR 串行 → 经 Loader 立即应用），而不是手改 YAML。

交付：可列出现有插件条目及其配置、可编辑并提交、越权 / 更高层覆盖的字段如实回报、服务缺失时降级为只读并说明原因。

边界：不做配置文件全文编辑器（只按插件条目的 config 编辑）；不承担插件启停 / 装卸（那属 `plugin-manager`）；不改 `/config` 现有只读展示的语义。

## 调研

（待填；base 已挂 `config-editor`（`dsh-base/cordis.patch.yml:105-106`），TUI 目前只有 `/config` 只读展示）

## 决策

（待填；编辑面形态：命令 + 逐项编辑，还是一个提交式面板）

## 规划

### 计划改动文件清单

（初判，调研后定稿）

- `TUI/src/app/index.ts`（命令 / 面板路由）、`TUI/src/app/commands.ts`（命令目录）
- `TUI/src/main.ts`（取 `configEditor` 服务）
- 可选新 `TUI/src/app/config-edit.ts`（纯函数 + 测试）

### 验收

（初判）

- 经 TUI 改一个插件 config 值：patch 被原子改写、无需重启生效或明确提示需重启
- 无效值被拒且文件不变；单测覆盖服务缺失降级与拒绝路径
