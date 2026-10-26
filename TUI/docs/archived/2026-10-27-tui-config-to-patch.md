# TUI 配置迁到 profile patch（`tui.config.json` → `- id: tui` config）

状态：完成　　开启：2026-10-27
接取条目：`TUI/docs/BACKLOG.md`「TUI 配置迁到 profile patch」。
本文件是本任务唯一的过程记录与文档变更落点。

## 背景

`TUI/tui.config.json` 是包内配置文件，靠 `config.ts` 的 `resolveConfigPath` 从模块目录向上查找。
`file:` 快照安装只带 `package.json` 的 `files` 里的内容——该文件漏在里面时，快照里读不到配置，
`layout.activityPlacement` 因此取不到 `auto`，会话/回合区恒为纵向（2026-10-27 真机复现）。

短期修法是把它加进 `files`（已做）；正式口径改为写进 profile 的 `cordis.patch.yml`，
包内文件只做开发期兜底。

## 口径（用户 2026-10-27）

- 扁平展开：patch 的 `- id: tui` config 里按原段名写 `layout` / `notify` / `session` /
  `approval` / `localLog`；主题段改名 **`colorschema`**（避免与既有 `config.theme`(ThemeId) 撞名）。
- 优先级：**patch > `tui.config.json` > 内置默认**，段内逐键浅合并（patch 只重述要改的键）。
- 保留 `theme: dark` 不动。
- 示例资产去个人化：不写 `paletteDir` / `palettes`（缺省走 `$FFF_HOME` → `~/fff` 默认链）。

## 实现

- `TUI/src/app/config.ts`：新增 `TuiConfigPatch` 类型与 `mergeTuiConfig(file, patch)`
  （每段 `{...file段, ...patch段}`，主题段由 `colorschema` 覆盖 `theme`）。
- `TUI/src/main.ts`：
  - `DshTuiConfig` 新增 `layout` / `notify` / `session` / `approval` / `localLog` / `colorschema`；
    保留 `approvalTimeoutMs`（`approval.timeoutMs` 优先）。
  - `apply(ctx, config)` 顶部算 `mergeTuiConfig(loadTuiConfig(), config)`，经 `main({ tuiConfig })`
    下传；审批超时改用合并后的 `tuiConfig.approval?.timeoutMs`。
  - `main(opts)` 新增 `tuiConfig?`，缺省仍 `loadTuiConfig()`（测试 / demo 路径不变）。
- `profiles/example/cordis.patch.yml`：`- id: tui` 的 config 展开为
  `theme` + `layout` + `approval` + `session` + `colorschema`（含写法说明注释）。
- `~/.dsh/profiles/fff/cordis.patch.yml` 与 `~/.dsh/profiles/fff.bak/cordis.patch.yml`：同款段写入
  （写前各留 `cordis.patch.yml.bak.<时间戳>`）；两份与示例的 `tui.config` 解析结果一致。
- `TUI/README.md`：新增「配置来源：profile patch 优先，包内 `tui.config.json` 兜底」一节，
  原文件说明降级为开发期兜底。

## 测试与证据

- 新增 `TUI/tests/tui-config-merge.test.ts`（3 例）：段内逐键覆盖、`colorschema` 覆盖文件 `theme`
  且未重述的 `paletteDir` 保留、文件缺段时由 patch 补。
- `tsc --noEmit` 通过；TUI 全量 **1809 例全绿**。
- 三份 patch（示例 / fff / fff.bak）用 YAML 解析通过，`tui.config` 均为
  `{theme: dark, layout{…}, approval{…}, session{…}, colorschema{active: dark}}`。
- 未做：`dsh --profile fff --dump-config`（沙箱内不能写 profile 目录，EROFS）；真机效果需
  **重装 profile**（`scripts/install.sh --profile fff --sync`）后重启 dsh 才带上新代码。

## 收尾

- 提交 `41b2d44`；TUI 全量 1809 例全绿。真机效果需重装 profile（`scripts/install.sh --profile fff --sync`）并重启 dsh。
