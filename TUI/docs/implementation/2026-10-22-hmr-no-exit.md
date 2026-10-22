# 非 TUI 行的 HMR 重载不得连带退出会话（接取条目：`TUI/docs/BACKLOG.md`「#5 非 TUI 行的 HMR 重载不得连带退出会话」）

状态：进行中（仅接取：本文档已建，调研未开始）　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

让「运行中改写 profile patch 的非 TUI 行」不再导致整个 dsh 退出：会话保留，该行新配置生效，或明确提示「需重启」。

交付：一条可复现的回归用例（改任一非 TUI 行 → 进程存活）+ 三条既有退出路径（`/quit`、退出确认面板、`/restart`）行为不变。

边界：不改变用户主动退出的语义；不修改宿主 `dsh-hmr` 的实现（除非选定方案③并单独获批）；不引入新的配置监听。

## 调研

（待填；已知链路：`dsh-hmr` 监视 patch → cordis 行级重启 → TUI 卸载 → `disposeApp()` → `renderer.close()` → `process.exit()`；TUI 只对自己那行装了否决钩子）

## 决策

（待填；候选：① `exitOnClose` 语义区分插件卸载与用户退出；② `disposeApp` 增加「因 HMR 重载」分支；③ 向宿主要整树 veto 钩子）

## 规划

### 计划改动文件清单

（初判，调研后定稿）

- `TUI/src/main.ts`（fiber 钩子 / dispose 分支）
- 可能涉 `TUI/src/renderer/`（`exitOnClose`）
- `TUI/tests/config-hot-update.test.ts`

### 验收

（初判）

- 运行中手改任一非 TUI 行配置：进程不退出、会话保留、有提示
- `/quit`、退出确认面板、`/restart` 三条退出路径回归全绿
