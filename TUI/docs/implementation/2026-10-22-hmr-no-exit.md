# 非 TUI 行的 HMR 重载不得连带退出会话（接取条目：`TUI/docs/BACKLOG.md`「#5 非 TUI 行的 HMR 重载不得连带退出会话」）

状态：规划（调研与决策已完成，实现未开始）　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

让「运行中改写 profile patch 里的非 TUI 行」不再导致整个 dsh 退出：宿主停掉并重装 TUI 行时，会话与进程都保留，界面随条目重建自动回来。

交付：一条可回归的单测链路（宿主卸载 → 不 `process.exit`）+ 三条既有退出路径（`/quit`、退出确认面板、`/restart`）行为不变。

边界：不改宿主 `dsh-hmr` / `cordis-plugin-loader` / `dsh-app-boot`；不改用户主动退出语义（含退出码 75 的重启交接）；不引入新的配置监听；不做真机验收（本次按指令由用户另行安排）。

## 调研

**来源**：宿主安装目录 `@deepseek-ai/dsh-hmr`（`lib/index.js` + README）、`@deepseek-ai/dsh-app-boot`（`lib/index.js` `recompose`）、`@deepseek-ai/cordis-plugin-loader`（`lib/index.js`）、`@deepseek-ai/cordis-plugin-include`（`lib/index.js`）、本仓 TUI 源码与 `TUI/docs/archived/2026-10-13-tmux-detach-and-hmr-theme-exit.md`（上一轮同类事故的取证记录）。

### 1. 事故链路（改任一非 TUI 行也可能停掉 TUI）

1. 宿主 `hmr` 服务对 `profile.patchPath` 与 home patch 各挂一个配置监视（`dsh-hmr/lib/index.js:872` `watchConfig`；实现 `:767`），文件变更 → `runReload(refresh)`。
2. `refresh` 走 `reconcileProfile()`（`dsh-hmr/lib/index.js:1320`）：
   - 先做**磁盘模块比对**（`files.compare(profileModules(roots))`）；比对出的 stale 模块（含 profile 里 `link:` 指向的包目标目录，本仓全部插件都是这种）交给 `planReplacement`，再由 `stopPlanned(plan)`（`:1347`）**停掉运行这些模块的 Loader 条目**；
   - 随后 `recomposeProfile(..., { requiredIds, running })`（`:1359`）按新 patch 重装被停条目并重放 generation。
   - README 原文（Understand the implementation）："Changed modules are evicted and the Loader entries running them stop; app-boot's `recomposeProfile` then publishes the resolution, applies the generation, **starts the stopped entries** with the current files and configuration"。
3. `recompose` 本体（`dsh-app-boot/lib/index.js:3797`）把新的完整 patch 列表塞进 root Include 条目（`:3853` `entry.update({ config: { patches } })`）→ Include 的 `internal/update` 处理器（`cordis-plugin-include/lib/index.js:129`，不调 `next()` = 否决 Include 自身重启）→ 子条目树 `root.update(...)`（`cordis-plugin-loader/lib/index.js:78` `EntryGroup.update`）逐个 `Entry.update(options, create, force)`（`:367`）。**未变化的兄弟条目** `changes` 为空、`_patchContext([])` 不会触发 `fiber.update`（`:355`），所以「改 A 行的 config 不会顺手重启 B 行」这一层是安全的。
4. 但**被停掉的条目**（`:1347` `stopPlanned`）是实打实的 `fiber.dispose()`；`recompose` 末尾 `resume(ctx, retried)`（`dsh-app-boot/lib/index.js:3858`）再把它们 `init` 回来。停机时不经过任何 `internal/update`，故 TUI 上一轮「本行更新否决钩子」（`TUI/src/main.ts` 的 `makeConfigHotUpdateHandler` 注册处）**拦不到**它。
5. TUI 条目一被停机：插件 effect 清理 → `disposeApp()`（`TUI/src/main.ts:907-910`）→ `main()` 返回的 disposer（`TUI/src/main.ts:200-203`）→ `App.dispose()`（`TUI/src/app/index.ts:1618`）→ `finishDispose()` → `renderer.close()`（`TUI/src/renderer/index.ts` 的 `close()`，`exitOnClose` 缺省 true）→ `process.exit(process.exitCode ?? 0)`。整个 dsh 和会话一起没了，条目重建根本轮不到。

**结论**：退出不是「某行 config 改了 TUI」，而是「任何一轮 recompose / 模块替换停掉 TUI 条目」。因此修法必须落在**停机路径**上，而不是配置键的分类上。

### 2. 上一轮修复的边界

`TUI/docs/archived/2026-10-13-tmux-detach-and-hmr-theme-exit.md` 的决策 1 只给 **TUI 本行**的 `internal/update` 装了热应用/否决钩子，并显式记下「不做通用重建保护：把『fiber 重启一律不退出进程』做实要动 renderer 的 `exitOnClose` 语义与启动器 75 号重启契约，回归面大，另立条目」。本条就是那个另立条目。

### 3. TUI 侧可用的分流信号

- 用户退出路径全部收敛到 `App.dispose()`：`/quit`、Ctrl+D 确认、双击 Ctrl+C 面板、`/cleanquit`、退出确认面板第三项、`/restart`（`requestRestart` 先置 `restartPending` 与退出码 75）。
- 宿主卸载路径只有一个入口：插件 effect 清理里的 `disposeApp()`，以及 `process.once("exit")` 兜底。
- 二者在 TUI 侧**可以按调用来源区分**（谁调 `dispose`），不需要识别「这次重载是不是 HMR」——effect 清理不携带原因，也没有可靠字段可读。

## 决策

**决策项 1（分流点）**

- a `renderer.close(options?: { exit?: boolean })` + `App.dispose(options?: { exit?: boolean })` 透传；用户退出路径不传（行为与现状完全一致），插件卸载路径显式 `exit: false`
- b 全局关掉 `exitOnClose`，由 `main.ts` 统一决定何时 `process.exit`
- c 向宿主 `dsh-hmr` 要整树 veto 钩子

选定 **a**。理由：`renderer` 仍是唯一「恢复终端 + 结束进程」的地方，`exitOnClose` 的既有契约只在用户退出路径上保持；b 会把「进程何时退出」散到调用方，还要重新实现退出码 75 与 `process.exitCode` 口径（回归面更大）；c 跨包改宿主，版本不可控。

**决策项 2（宿主卸载后的提示）**

- a 卸载后经 `opts.logger` 写一行提示（生产落 stderr，测试可捕获）
- b 活动区 notice
- c 不提示

选定 **a**。理由：`renderer.close()` 会 `screen.reset()` 并恢复终端，活动区那一帧随即被擦掉（b 看不见）；卸载后如果条目被重建，界面会自己回来，若没回来用户需要知道「进程还活着、可以 Ctrl+C 退出」，所以必须留一行（c 不行）。

**决策项 3（空会话清理）**

- a 宿主卸载路径**跳过** `autoCleanEmpty` 的退出清理
- b 照旧执行

选定 **a**。理由：该清理是「退出前顺手打扫」，而卸载不再是进程退出；异步清理会与即将重建的 TUI 实例（同一会话目录）抢写，且 `/restart` 本来就有跳过先例（`restartPending`）。

**决策项 4（`process.once("exit")` 兜底）**

- a 传 `{ exit: false, notify: false }`
- b 保持原样
- c 删除该兜底

选定 **a**。理由：进程已在退出过程中，`renderer.close()` 里再 `process.exit()` 无意义且有重入风险；`disposeApp()` 的清理价值（落盘、释放 handle、恢复终端）要保留，故不删（c）。

**决策项 5（条目不再重建时）**

- a 保持进程存活（无界面）+ 提示用户 Ctrl+C 或重启 dsh
- b 延迟若干秒自动退出
- c 自动重启自身

选定 **a**。理由：自动退出（b）等于把本条要防的「丢会话」换个地方发生；自动重启（c）要依赖启动器与交接文件，超出 TUI 职责，且在「行被用户主动禁用」的场合是错的。

## 规划

### 任务拆分

1. 渲染层：`close(options?: { exit?: boolean })`，`exit` 缺省取 `exitOnClose`。
2. App 层：`dispose(options)` 透传到 `finishDispose(exit)`；`exit === false` 时跳过空会话清理直接收尾。
3. 接线层：`main()` 返回的 disposer 接受 `{ exit, notify }`；插件 effect 清调用 `{ exit: false }`；`process.once("exit")` 调 `{ exit: false, notify: false }`。
4. 单测：renderer 退出标志、App 两条来源的 close 参数、`main()` disposer 的提示与不 exit、既有退出路径回归。

### 计划改动文件清单

- `TUI/src/renderer/index.ts`（`Renderer.close` 签名与实现）
- `TUI/src/app/index.ts`（`dispose` / `finishDispose` / `disposeWithExitClean`）
- `TUI/src/main.ts`（disposer 签名、effect 清理、`process.once("exit")` 兜底）
- `TUI/tests/hmr-teardown-no-exit.test.ts`（新增）

### 明确不做

- 不改宿主 `dsh-hmr` / `dsh-app-boot` / `cordis-plugin-loader`（跨包）。
- 不改 `/quit`、退出确认面板、`/restart`（含退出码 75 交接）的语义与顺序。
- 不新增配置监听，不试图识别「这次卸载是否 HMR」。
- 不做真机验收（用户已明确本次不做；真机确认另排）。

### 验收

- 单测：`renderer.close()` 缺省仍按 `exitOnClose`；`close({ exit: false })` 不触发进程退出（用可注入的退出函数断言）；`App.dispose()`（用户退出）→ close 收到「按缺省退出」；`App.dispose({ exit: false })` → close 收到 `{ exit: false }` 且跳过空会话清理；`main()` disposer 在 `exit: false` 时写一行提示、在不带参时行为不变。
- `cd TUI && npm run check` 与 `cd TUI && npm test` 全绿。
