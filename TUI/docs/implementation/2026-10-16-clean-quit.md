# 干净退出（退出时清理当前会话）（接取条目：`TUI/docs/BACKLOG.md`「增加干净退出功能（退出时清理会话；先审计既有路径补缺口）」）

状态：决策　　开启：2026-10-16　　关闭：-
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 计划改动文件清单

- `TUI/docs/BACKLOG.md`（条目标〔进行中〕/〔完成〕，关闭时清理）
- `TUI/docs/implementation/2026-10-16-clean-quit.md`（本文件）
- `TUI/src/app/index.ts`（`/cleanquit`、面板项接线、退出删除通道调用与顺序、运行时物释放核对）
- `TUI/src/app/adapter/dsh.ts`（新增「退出前删除当前会话」通道：释放 handle 后放开 `activeSessionId` 守卫）
- `TUI/src/app/adapter/types.ts`（adapter 面新增方法声明）
- `TUI/docs/DESIGN.md`（「退出确认 ·「重启」方案」一节补「清理并退出」口径）
- `TUI/docs/COMMANDS.md` / `TUI/docs/COMMANDS-SPEC.md`（`/cleanquit`）
- `TUI/README.md`（命令表 / 面板说明 / 退出契约）
- `TUI/tests/`（新增用例 + `exit-confirm` / `app` / `session-delete` 回归）

## 目标

按条目要求：审计既有退出路径 → 补齐缺口 → 形成「干净退出」统一口径。首期三项 = ① 会话与状态文件清理；② 后台资源清理；③ 验收口径写清。条目明确排除：运行时残留清理（排队消息 / 通知 / tmp 临时文件）。

## 调研：既有退出路径审计（2026-10-16，只读）

| 出口 | 入口与行号 | 是否二次确认 | 现有清理 |
|---|---|---|---|
| `/quit`（`/exit`） | `index.ts:3635` → `dispose()` | 否（显式输入） | 全套 dispose |
| `Ctrl+D`（agent 空闲且输入区为空） | `:2618` → `requestExitConfirm()` | 是（`exit-confirm` 面板） | 确认后全套 dispose |
| 双击 `Ctrl+C`（750ms 窗口） | `:2690` → `requestExitConfirm()` | 是（同上） | 确认后全套 dispose |
| 面板「退出 dsh」 | `:3148` → `dispose()` | 面板本身 | 全套 dispose |
| 面板「重启 dsh（保留会话）」/ `/restart` | `:3154-3179` / `:3639` → `requestRestart()` | 面板项 / 显式命令 | 写交接文件 → 退出码 75 → `restartPending` 置位后 `dispose()`（**跳过**会话清理） |
| 插件 unload / 宿主 dispose | `dispose()` | — | 全套 dispose |
| 信号强退（SIGINT / SIGTERM）/ 崩溃 | `renderer` 直接 `process.exit` | — | 不保证（无法可靠等待异步 IO） |
| `SIGHUP`（tmux detach 等） | `installExitHandlers` | — | **不退出**，仅作废全帧缓存 |

`dispose()`（`index.ts:1516-1544`）现有清理项，按发生顺序：

1. `flushSessionStateSave()`（`:1428`）—— 把未过合并窗口的会话状态快照立即写入 `<会话目录>/tui-state.json`（仅内存会话静默跳过）。
2. 置 `disposed` → 作废待处理合帧 → 解绑 adapter 事件 / symbol-normalizer 订阅 / rule-engine 订阅 → 停面板刷新与响铃计时器 → 清帧定时器 → 取消 `@` 提及请求（`:1520-1533`）。
3. `autoCleanEmpty && !restartPending` 时走 `disposeWithExitClean()`（`:1553-1572`）：`runExitCleanEmptySessions()`（删除**其他**空会话）与 `EXIT_CLEAN_TIMEOUT_MS = 5000`（`:190`）竞速，超时打印「放弃等待」后照常收尾。
4. `finishDispose()`（`:1547-1550`）：`adapter.dispose?.()` → `renderer.close()`（恢复终端、退出进程/事件循环）。

清理判据（`state.ts:339` `startupCleanableIds`）：已持久化 + 非 live + 非当前 + 无用户消息；启动侧（`:1174`）与退出侧（`:1198`）共用判据与删除核心（`:1149` `deleteSessionIds`）。

### 缺口一：当前会话的记录与历史从不删除

- 唯一删除通道是 `adapter.deleteSession`（`adapter/dsh.ts:3383-3400`），它**显式拒绝**两种情形：`id === activeSessionId`（「当前活跃会话不可删除」）与 `opts.sessions.get(id) !== undefined`（「live 会话不可删除」）。面板侧（`index.ts:3980` 一带）另有前置守卫。
- 宿主 `sessionQuery` 只有 `listSessions`（`dsh-session-query/lib/types/index.d.ts:67`），**没有删除接口**；删除是文件级的 `deleteSessionDir(id, roots)`（`adapter/dsh.ts:980-999`：`locateSessionDir` 做单段 id 校验与 realpath 包含性校验，然后 `rmSync(recursive)` 删**整个会话目录**）。
- 因此「删除当前会话」必须新增通道：先释放当前 handle（`/new` 同路径，`:1312` 注释「旧 handle 在切换成功后释放（activeDispose）」），再放开 `activeSessionId` 守卫删除；**不**直接调 `deleteSessionDir` 绕过 adapter 簿记。

### 缺口二：后台资源持有面核查（条目列举项逐一结论）

| 条目列举项 | 结论 |
|---|---|
| 子代理句柄 | TUI **不持有** —— `/agents` 面板只经宿主服务发中断（`:2525`），子代理生命周期在宿主侧 |
| 会话通道订阅 | **不存在** —— `sessionChannel` 只被 `aliasList()` 只读调用（`adapter/dsh.ts:3505`），无订阅 |
| 渲染器 dispose 阶段对齐 | 已对齐：`finishDispose()` 在 adapter 释放后调 `renderer.close()`；本次仅需保证新增的删除步骤插在两者之间 |

实际持有且需要回归确认的运行时物：帧定时器 / 面板刷新 / 响铃计时器 / 宽度探测队列 / 排队登记（`state.queued`）/ adapter handle —— 均在 `dispose()` 现有步骤内，本次不新增释放逻辑，只补断言。

### 缺口三：删除与状态文件、退出顺序的关系

`tui-state.json` 就在会话目录内（`adapter/session-ui-state.ts:7` 注释「随会话目录删除一起清理（`deleteSessionDir` 删的是整个目录）」）→ 删除当前会话会连带删掉刚 flush 的快照，属预期；顺序必须是「释放 handle → 删目录 → `renderer.close()`」，且删除失败时仍要正常退出（只告警，不阻断）。

## 决策（2026-10-16 用户裁定）

1. **流程与落点**：本条目走标准流程（本文件为唯一过程记录）；改动直接在 main 工作区做，不另开 worktree。
2. **命令面**：两处都要 —— 退出确认面板新增「清理并退出」项 + 新增本地命令 **`/cleanquit`**（命令名由用户指定）。
3. **清理强度**：退出时**删除当前会话的记录与历史**（不可逆）；**不改动其他有内容的会话**；既有「退出时清理其他空会话」（`session.autoCleanEmpty`）**保留**（空会话无内容，不属于被保护的「已有内容的会话」）。
4. **与重启 / 启动交互**：重启路径继续跳过会话清理（沿用 `restartPending`）；启动侧自动清理保持现状；信号强退路径不保证（沿用现有口径）。
5. **术语**：「会话」= dsh 持久化会话（会话目录 + 历史记录）；「清理」= 删该会话目录 + 释放当前会话运行时物 + 状态快照落盘一致。
6. **二次确认**：面板项经退出确认面板本身确认；`/cleanquit` 弹合成确认面板（缺省高亮「取消」，`Esc` 取消）；确认前不动任何数据。
7. **实现通道**（工程决定）：adapter 新增「退出前删除当前会话」方法 —— 保留 live 守卫（必须先释放 handle），放开 `activeSessionId` 守卫，仅由 App 退出收尾路径调用；不直接调 `deleteSessionDir`。

## 实现计划

1. adapter 面：`types.ts` 声明 + `dsh.ts` 实现「退出前删除当前会话」（复用 `deleteSessionDir` 与既有告警文案，返回 `{ok, reason}`）。
2. App 面：新增 `requestCleanQuit()`（单一来源）—— 确认 → 释放/删除 → 收尾退出；`/cleanquit` 命令接线 + 退出确认面板加项（面板项顺序：取消 / 退出 dsh / **清理并退出** / 重启（可用时））。
3. 顺序与兜底：删除插在 `flushSessionStateSave()` 之后、`finishDispose()` 之前；用既有竞速 + 超时口径包一层（复用 `EXIT_CLEAN_TIMEOUT_MS`），失败只告警。
4. 文档：`DESIGN.md`（退出确认一节）、`COMMANDS.md` / `COMMANDS-SPEC.md`、`README.md`（命令表 + 退出契约）、`BACKLOG.md`（关闭时清理）。
5. 测试：新增 `/cleanquit` 与面板项的用例（确认前不动数据、确认后删当前会话并退出、其他会话不受影响、删除失败仍退出）；回归 `exit-confirm` / `app` / `session-delete`。

## 验收

1. 审计表（上文「调研」）逐项与实现对上，无「绑了没清理」与「清理了没说」。
2. 三条路径各有断言：正常退出（不删当前会话）/ `/cleanquit`（删当前会话）/ 重启（不删）。
3. 删除不可逆路径均有确认；确认前无任何副作用。
4. 其他有内容的会话在全部路径下都不被改动；空会话清理行为不变。
5. `npm run check` + `npm run build` + `npm test` 与 `npm run test:tui` 全绿。
6. 真机 `dsh --profile fff` 复核：面板第四项文案与行为、`/cleanquit` 确认面板、退出后当前会话目录消失。

## 风险与边界

- 删除不可逆：所有入口都先确认；`/cleanquit` 的确认面板缺省高亮「取消」。
- 信号强退 / 崩溃路径不保证清理（进程被直接终止，异步删除不可靠）。
- 删除当前会话会连带删除其 `tui-state.json` 快照（同目录），属预期；如后续要保留快照，另立条目。
- 「清理并退出」与「重启 dsh」互斥：后者必须保留会话。
