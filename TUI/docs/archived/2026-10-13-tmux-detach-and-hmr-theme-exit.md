# 2026-10-13 tmux 站内 detach 退出 & colortheme 切主题退出

- 层：TUI（两条目同为 TUI 层缺陷）
- 接取条目（按标题引用）：
  - 〈tmux 在 dsh 所在 window 内 detach 会让程序退出（切到别的 window 再 detach 才保活）〉
  - 〈运行中执行 colortheme 切主题会让 dsh 退出（profile patch 被写 → HMR 重启 tui 行 → dispose 走进程退出）〉
- 开始：2026-10-13　状态：完成（#1 的「站内 detach」触发面真机复测待用户确认，机制面已实证，见下）

## 目标

1. tmux 站内（dsh 所在 window 为当前窗）detach 不再丢会话。
2. dsh 运行中执行 `colortheme dark|light` 不再让 dsh 退出，且主题当次生效。

## 调研与取证

### 隔离 profile 复现台（本次新建的取证设施）

在沙箱里跑「真 dsh + 真 tmux」需要三件事，缺一不可：

1. **`DSH_HOME` 覆盖**：`dsh --profile <name>` 取的是 `$DSH_HOME/profiles`（宿主 `bin.js` 的 option 帮助与 `profile-boot` 注释均如此写）。把 fff profile 复制进工作区 `tmp/dshhome/profiles/fff`，凭据用符号链接指向真实 `~/.dsh/.credentials.yaml`（只读；不复制密钥），即可让 dsh 全部写入落在工作区内——否则启动即 `EROFS: open '~/.dsh/profiles/fff/cordis.yml'` 崩掉（本次踩到，一度误当作「detach 致退」）。
2. **修软链**：复制后 `node_modules/@dsh-toolset/*` 的相对链接（`../../../../../Projects/...`）层级失效，bundle 解析失败（`dsh: skipping profile bundle …`）→ 探针静默降级成「没有 TUI 的 dsh」。用 `readlink -f` 按原目录解析后逐个重指为绝对路径。
3. **tmux 探针**：`tmux -L <sock> -f ~/.tmux.conf`（独立 socket，不碰用户 tmux server）+ `remain-on-exit on`（观察 `#{pane_dead}` 与 `pane_current_command`）；客户端用 `script -qec "tmux attach -t <s>"`（必须 `TERM=xterm-256color`，否则 tmux 报 `open terminal failed: terminal does not support clear`）。沙箱 `/tmp` 每条命令重建 → 探针全过程必须写在**同一条 bash 调用**里。

### #1 取证结论

- **复现不到**：真 dsh + 用户真 tmux 配置（`focus-events on`、`extended-keys on`、prefix `C-f`），in-window detach 全部保活（`pane_dead=0`、`cmd=node`）：独窗 120x40、先 attach 再改窗、200x50 客户端、先 attach 再起 dsh —— 都没有退出；窗口尺寸也不因末位客户端 detach 变化（→ 排除「detach 触发 resize 致崩」）。手动向 pane 写 `ESC[O`（focus out）与裸 `ESC` 亦不致退（在 demo 上验证；demo 与生产共用 renderer/terminal）。
- **实证到的致命面**：`installExitHandlers` 只挂 `SIGINT`/`SIGTERM` → **SIGHUP 落 Node 默认动作：直接终止，实测 `DSH_EXIT=129`，且不走终端恢复**（画面可能残留 raw/alt 状态）。
- **排除候选 ②**：全仓无 `stdin.on("end"/"close")` 监听（`src/app/local-shell.ts:149` 是本地子进程的 `close`），即输入侧收尾当前**不构成退出面**。
- 结论：修「终端挂断 = 终端恢复 + 退出」这一根因面（SIGHUP 显式接管、不退出）；真机 in-window detach 是否仍会退出待用户复测（真退出时会留退出码 / 终端残留可供定位）。

### #2 取证结论（已原样复现 + 机制链读源确认）

- 原样复现：探针内把 profile patch 的 `theme: dark → light`，8 秒内 dsh 退出（`DSH_EXIT=0`，末帧残留）。
- 机制链（四段）：
  1. `~/fff/config/aliases.d/35-colortheme.sh:288` 的 `_fff_theme_dsh_profile_switch` 重写 `~/.dsh/profiles/fff/cordis.patch.yml` 里 `tui` 行的 `config.theme`（值真的变化时才写）；
  2. 宿主 `dsh-base` bundle 默认插入 `hmr` 行（`@deepseek-ai/dsh-hmr`，`config.root: []`，注释即「Profile configuration reloads by default」），其 `Service.init` 对 `profile.patchPath` 等逐个 `watchConfig(… → runReload(refresh))`；
  3. 文件变更 → `cordis-plugin-loader` 的 `entry.update` → `Fiber.update(config)` → 无 `internal/update` 干预时 `this.restart()` = 卸载 + 重装；
  4. 卸载走本插件 effect 清理 → `disposeApp()` → `app.dispose()` → `finishDispose()` → `renderer.close()` → `exitOnClose ?? true` → **`process.exit(process.exitCode ?? 0)`**（`src/renderer/index.ts:406`）。即「插件重载被当成退出路径」。

## 决策

1. **#2：用 cordis 每条 fiber 专属的 `internal/update` 钩子做热应用**。`Context.on(name, cb)` 不带 `global` 时，监听器进 `fiber._hooks["internal/update"]`，只会收到**本 fiber**的更新，且 cordis 文档明说该 waterfall 「can veto or replace the restart」。钩子语义：**只含可热应用键（`theme`）的更新 → 就地切主题并否决重启**；其余更新 → 调 `next()` 交回默认路径（行为不变）。
   - 不做「通用重建保护」：把「fiber 重启一律不退出进程」做实要动 renderer 的 `exitOnClose` 语义与启动器 `75` 号重启契约，回归面大，另立条目（见收尾）。
2. **#1：显式接管 SIGHUP，不退出**。终端挂断（tmux detach / 客户端断开 / 父终端收起）不是「用户要走」；接管后只作废全帧缓存，等下一次重绘。终端真没了时后续写 stdout 会失败 → 落到 `uncaughtException` 出口，进程照样退出，**不留孤儿**。

## 规划 / 计划改动文件清单

- `TUI/src/renderer/terminal.ts`：`installExitHandlers` 加 `onHangup` + SIGHUP 注册/解绑；文件头退出生命周期注释补 SIGHUP 一行。
- `TUI/src/renderer/index.ts`：退出钩子接 `onHangup`（挂断 → `prevRows = null`，不退出）。
- `TUI/src/main.ts`：新增纯函数 `isLiveConfigUpdate` / `makeConfigHotUpdateHandler`（导出，便于单测）、`themeSink` 出口（照 `pipelineSink` 既有形制）；`apply()` 注册 `internal/update` 钩子。
- `TUI/src/app/index.ts`：新增公开 `applyTheme(id)`（状态 + renderer 调色板 + 重绘），`/theme` 复用同一路径（去重复）。
- `TUI/tests/exit-handlers.test.ts`（新）、`TUI/tests/config-hot-update.test.ts`（新）。
- 文档：`TUI/README.md`（theme 热应用 / SIGHUP 两条）、`TUI/docs/DESIGN.md`（退出生命周期补 SIGHUP 例外）、`TUI/docs/BACKLOG.md`（收尾）。

## 实现记录

- `terminal.ts`：`installExitHandlers(handler, onHangup?)`；`SIGHUP` 走 `onHangup`，其余（SIGINT 130 / SIGTERM 143 / uncaught 注入）口径不变；解绑时一并移除 SIGHUP。
- `renderer/index.ts`：`detach` 传入第二个参数（挂断 → 作废全帧缓存）。未写日志：挂断后 stderr 会直接落在画好的帧上（污染画面），而挂断本身不是异常。
- `main.ts`：`isLiveConfigUpdate(current, next)`（键集合比较 + 键序无关序列化；判「不可热应用」是安全方向）；`makeConfigHotUpdateHandler(current, applyTheme)`（构造纯函数）；`main()` 新增 `themeSink`，App 就绪后挂 `app.applyTheme`；`apply()` 末尾 `ctx.on("internal/update", …)`。
- `app/index.ts`：`applyTheme(id)`（同值即返回），`handleThemeCommand` 改调它。

## 测试与证据

- `node_modules/.bin/tsc -p tsconfig.json --noEmit` → 通过；`npm run build` → 通过。
- 全量 `sh scripts/test.sh` → **1494 / 1494 通过**（上一基线 1481，新增 13 例：`exit-handlers` 4 + `config-hot-update` 9）。
- **#2 端到端（探针，真 dsh + 真 patch 文件）**：
  - 修复前：`theme: dark → light` → `dead=1`、`DSH_EXIT=0`（原样复现用户现象）；
  - 修复后：同操作 → `dead=0`、`cmd=node`（进程活着），且帧内调色板码整体切换（dark 前景 `38;2;201;220;222` → light `38;2;61;59;79`、强调色 `38;2;90;152;243` → `38;2;18;86;178` 等）→ **主题当次生效**。
- **#1 端到端（探针，真 dsh）**：
  - 修复前：`kill -HUP <dsh pid>` → `DSH_EXIT=129`；
  - 修复后：同一操作 → 进程存活（`dead=0`、`cmd=node`），帧逐字节不变（无画面污染）；`kill -INT` 仍按 130 退出（口径未回归）。

## 收尾

- BACKLOG：两条目移除；新增条目〈tui 行非热应用配置变更会重建 fiber 并把 dsh 一起带退出〉（通用重建保护，另立）。
- 文档回写：`README.md`（`config.theme` 可热应用 + SIGHUP 不退出）、`DESIGN.md`（退出生命周期 SIGHUP 例外）。
- 遗留：① 真机复测「站内 detach」；② 非热应用配置键的通用保护（新条目）；③ 探针台 `tmp/dshhome` 为临时取证设施，收尾清理（复现方法已完整记于本文件，可重建）。
