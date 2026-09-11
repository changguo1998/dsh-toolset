# herdr-integration 后续任务安排

> 系列：`DEVELOPMENT-BACKLOG.md` #36。
> 状态：代码已合入 main；2026-09-11 复核完成——①复核真实完成度、②profile 挂载验证、④turn/end blocked 信号源均已落地（证据见下）；③端到端 herdr 面板人工复核留待有真实面板时执行。

## 部署与复核

- [x] 复核真实完成度（2026-09-11）
  - 协议面：`src/herdr.ts` 与 pi 原生扩展（`~/.pi/agent/extensions/herdr-agent-state.ts`）逐项对照——环境变量握手（HERDR_ENV/HERDR_SOCKET_PATH/HERDR_PANE_ID 缺一即禁用）、`pane.report_agent_session`（id 优先、path 兜底、`session_start_source: startup|resume`）、`pane.report_agent`（`working | blocked | idle` + 单调 `seq`）、独立连接每发一等响应、首档 500ms 超时 + 固定 1500ms 补发一次、状态队列串行 drain 同刻合并（后到覆盖），一致。
  - 接口面：`ctx.on("session/event", (session, event))` 监听签名与 `SessionEvent {type, seq, time, data}` 信封对照 `DSH-CTX-API.md`（0.1.5-rc.2）及 TUI 实际用法（`TUI/src/app/adapter/dsh.ts`）；`turn/end.reason` 联合形（字符串 / `{kind}`）归一化与 TUI `turnEndNotice` 一致。
  - 工程面：根级 `npm run check`（tsc --noEmit，4 子包）/ `npm run test`（node --test，4 子包）全绿。
- [x] profile 挂载验证（2026-09-11，`link:` 依赖，未用 `file:`）
  - 临时 profile `~/.dsh/profiles/dsh-toolset-herdr-tmp`：`package.json`（`link:` 依赖 herdr-integration + dsh-tui，指向本 worktree）+ `dsh.profile.bundles`（dsh-base → herdr-integration → dsh-tui）+ `cordis.patch.yml`（bundle 行）+ `pnpm-workspace.yaml`，`pnpm install` 后符号链接就位。
  - `dsh --profile dsh-toolset-herdr-tmp --dump-config`（dsh 0.1.5-rc.1）输出含 `- id: herdr-integration`，且位于 `dsh-tui` bundle 行之前（顺序满足观察者先于答案者）。
  - 临时 profile 已按约定删除；人工 E2E 时照上面 3 个文件重建同名 profile 即可。
- [ ] 端到端人工接入 herdr 面板复核（`scripts/verify-herdr.mjs`：状态上报 + blocked 桥）
  - 需真实 herdr 面板（herdr 注入 `HERDR_*` 环境）。重建临时 profile 后 `dsh --profile dsh-toolset-herdr-tmp` 入面板，再于面板内跑 `node scripts/verify-herdr.mjs <blocked|working|idle|session>` 逐态验证；blocked 桥需同时覆盖 approval / ask-user / turn-end blocked 三信号源。

## 接口对齐（DSH-CTX-API 0.1.5-rc.2）

> 已核实：订阅面为 agent/status + approval/request + user-questions/request + session/event（turn 生命周期，2026-09-11 新增）；0.1.5 事件更名（assistant/chunk→assistant/attempt 等）与本插件消费的 `turn/start` / `turn/end` 无关，不适用。

- [x] 补充 turn/end blocked（blocked reason）作为 blocked 桥信号源（2026-09-11）
  - `src/main.ts` 新增 `session/event` 订阅：`turn/end.data.reason` 为 `blocked`（字符串或 `{kind:'blocked'}` 联合形）→ 上报 `blocked`（message `waiting for input`）；下一次 `turn/start` 解除（turn 生命周期闭环）。与 approval/ask-user 共用全局 `BlockTracker` 计数，并发来源全部解除才释放；blocked 优先于 working。
  - 新增 4 项单测：blocked 上报与解除、联合形兼容、非 blocked reason / 畸形载荷不影响状态、并发来源（approval + turn-blocked）全部解除才释放；`npm run check` / `test` 全绿。

## 验收

herdr 面板可见状态上报与 blocked 事件，行为与 pi 原生扩展一致；接口对齐后 `npm run check` / `test` 全绿。
