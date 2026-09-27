# sessionQuery 早读回归修复（BACKLOG: TUI#19）

状态：关闭　　开启：2026-09-27　　关闭：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

修复 2026-09-27 批次（#2 CLI 启动参数，见 `TUI/docs/archived/2026-09-27-tui-remaining-batch.md`）引入的回归：重启 TUI 后历史会话整体不可用——`/session`、`/continue` 提示「历史会话服务不可用（宿主未挂载 sessionQuery）」；`-c` / `--continue` 不恢复最近会话而是静默新建（用户 2026-09-27 真机报告）。

## 调研

来源：本仓库源码、宿主 dsh 0.1.7-rc.2 安装包、隔离 DSH_HOME 的 PTY 实测。

- **改动点定位**：#2 把 `ctx.get('sessionQuery')` 提前到 `agents.create()` **之前**读取，并把该值复用于 adapter 选项。改动前（HEAD）该读取在 `agents.create()` await **之后**（与 `commands` / `llm` / `sessions` 等其余服务同批读取）。
- **宿主装载时序（根因）**：服务随插件树**并发装载**——cordis loader 对每个 entry 并发 `await import()` 后注册插件（`cordis-plugin-loader/lib/index.js` `_init()`，整体在 `dsh-app-boot` 的 `boot()` 里由 `loader.await()` 收口）；provider 的 Service 在其构造时注册（`@deepseek-ai/cordis` `Service` 构造 → `ctx.reflect.provide`）。`sessionQuery` 由 `dsh-session-query-sqlite` 的 `SqliteSessionQueryEngine` 提供（`static inject = ["sessions"]`，`lib/index.js:475-531`），须等 `sessions` 就绪后才构造；TUI 插件 `inject = ["agents"]` 先就绪 → **apply 入口处早读时 provider 可能尚未挂载**（undefined），而 `agents.create()` 是一段长异步，等它返回后各 provider 必已就绪（旧实现的读点）。
- **两处受害面**：① adapter 选项沿用早读值 → `listSessions` 等全部缺席（「未挂载」提示、面板/删除/清理不可用）；② `-c` 决策同样用早读值 → 服务为空时被当成「无匹配」→ 静默新建（与条目 D5「无匹配 → 静默新建」语义混淆）。
- **实测复现（改动前构建，隔离 DSH_HOME + 真实会话副本）**：
  - `script -qec "dsh --profile fff"` + `/session` → 3 帧「历史会话服务不可用（宿主未挂载 sessionQuery）」（`tmp/cap-before.txt`）；
  - `dsh --profile fff -c` 运行中快照会话目录：多出 `tui-ff780b67-…`（新建而非恢复，`tmp/sess-during-before.txt`）。

## 决策

| # | 维度 | 选项 → 选定 | 理由 |
|---|------|------------|------|
| D1 | adapter 读点 | 保留早读 / **恢复「handle 就绪后读」** | 与 HEAD 一致、与其余服务读点一致；handle 建立（create/resume）后 provider 必已就绪 |
| D2 | `-c` 早读 | 维持早读 / **有界等待服务就绪**（`waitForHostService`，上限 3s） | 读点无法后移（决策本身需要列表）；等待只为跨过并发装载窗口，超时按「未挂载」处理不阻断启动 |
| D3 | 等待实现 | `ctx.inject` fiber / **轮询闭包 `read()` + 超时** | TUI 零运行时依赖、纯参数注入便于单测；`ctx.inject` 的 fiber 在服务永不挂载时不 settle，仍需超时护栏，复杂度等价 |

## 规划

计划改动文件清单（实际执行 = 清单）：

- `TUI/src/main.ts`：`readSessionQuery` 闭包 + `waitForHostService`（导出、可单测）+ adapter 选项读点回退 + `-c` 有界等待
- `TUI/tests/main.config.test.ts`：`waitForHostService` 三条用例（就绪即回 / 等待期内就绪 / 超时 undefined）
- `TUI/docs/IMPLEMENTATION.md`：启动参数机制补充读点约束
- `TUI/docs/BACKLOG.md`：#19 登记与状态
- 本追踪文档

明确不做：不改 adapter/命令面/其它服务读点；不改 profile / 宿主包；不动 `rule-engine/**`；不做顺手优化。

## 实现记录

1. `main.ts`：新增 `SESSION_QUERY_WAIT_MS = 3000` 与 `waitForHostService<T>(read, timeoutMs, stepMs=50)`（就绪即回、超时 undefined）；`apply()` 内新增 `readSessionQuery` 闭包并注明读点约束；`-c` 分支改为 `await waitForHostService(readSessionQuery, …)` 后再取列表；adapter 选项 `sessionQuery: readSessionQuery()` 回到 handle 就绪后读取。
1. `tests/main.config.test.ts`：三条 `waitForHostService` 用例。
1. 文档：`IMPLEMENTATION.md` 启动参数条目补「服务并发装载 → 读点须在 handle 之后；`-c` 用有界等待」；BACKLOG #19。

## 测试与证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `cd TUI && npm run check` | 干净（0 error） |
| 单测（文件） | `npm test -- main.config.test.ts` | 9 pass / 0 fail（含新增 3 条） |
| 全量单测 | `cd TUI && npm test` | **1172 pass / 0 fail**（基线 1169 + 3） |
| 冒烟 | `npm run demo -- --smoke` | `SMOKE_OK`、exit 0（43 项） |
| 真机等价复现（修复后，主症状） | 隔离 DSH_HOME（`tmp/dsh-home`，内含真实会话副本）+ `script -qec "dsh --profile fff"` → `/session` | 面板正常打开「历史会话 [当前目录]（7/7）」、按编辑时间降序；**0 处**「未挂载 sessionQuery」 |
| `-c`（修复后，单会话隔离环境 `tmp/dsh-home-c`） | `script -qec "dsh --profile fff -c"`，运行中快照会话目录 | **无新会话目录**（未新建）；被恢复会话目录 `session.lock`/日志被追加、`tui-state.json` 更新含 `model` 段 → `agents.resume` 生效（对照改动前：多出 `tui-ff780b67-…` 新会话目录） |

修复前后对照（同一隔离环境、同一 `script` 手法）：

| 场景 | 改动前（早读值复用） | 改动后（本修复） |
| --- | --- | --- |
| `/session` / `/continue` | 3 帧「历史会话服务不可用（宿主未挂载 sessionQuery）」 | 面板正常（7/7，编辑时间降序） |
| `dsh --profile fff -c` | 静默新建（快照多出新会话目录） | 恢复最近编辑会话（无新目录；resume 落盘证据） |

### 途中发现（已登记 BACKLOG #20）

`-c` / `--resume` 启动恢复只完成 **agent 侧** resume（model/mode/goal/todo 经 `restoreSessionState` 回填），**历史行不渲染**：折叠历史只在 `/session` 切换路径（`resumeToSession` → `history-resume-ok`）发生，故启动后活动区为空、需手动再切一次会话才可见内容。与本次回归同源可观测面但成因不同（App 侧缺「启动即折叠历史」入口），按流程登记 `TUI/docs/BACKLOG.md` #20 交其他 agent 接取，不在本任务内改。

## 收尾

- 回写：`IMPLEMENTATION.md`（机制）、`BACKLOG.md`（#19 完成、#20 新条目）；`DESIGN.md` / `README.md` 无需回写（无行为/用法变化，修复回归）。
- 遗留：无（本次修复面）。**人工确认（2026-09-27）**：用户真实 profile 重启 `dsh --profile fff` 复验 `/session` / `/continue` 通过（历史会话恢复正常）；提交按用户裁定**暂缓**（工作区保持未提交）。#16 真机复核清单照旧（与本题无关）。
- 本追踪文档移入 `TUI/docs/archived/`（已移入）。
