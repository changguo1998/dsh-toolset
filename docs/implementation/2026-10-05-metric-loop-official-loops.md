# `metric-loop` 与官方两套循环机制并存（接取条目：`docs/BACKLOG.md`「`metric-loop` 与官方两套循环机制并存且分工未裁定」）

状态：调研　　开启：2026-10-05　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

备齐三方（`metric-loop` / 官方 `tool-ralph` / 官方 `goal-round-driver`）的能力对照材料，供用户裁定分工。**本任务不做裁定。**

## 调研

来源：本仓与官方包源码实测，无真机运行。

### 三方对照

| 维度 | `metric-loop` | `tool-ralph` | `goal-round-driver` |
|---|---|---|---|
| 驱动源 | 模型调 `metric_loop`；续排靠提示模型调 `schedule_create`（`metric-loop/src/engine.ts:226`） | 模型调 `ralph`，调用阻塞至结算 | 宿主事件：agent idle 时排 goal-round（`dsh-goal-round-driver/lib/index.js:124`） |
| 测量命令 | **有**（`/bin/sh -c`，30 s 超时；`src/measure.ts:43`） | 无 | 无 |
| 指标与收敛判定 | **有**（best / streak / plateau；`src/engine.ts:191`） | 无，worker 自报 | 无，模型自判 |
| 跨进程状态 | **有**（JSON 状态文件；`src/persist.ts:32`） | 无，工作区为唯一长期记忆 | 无，activation 仅进程内 |
| 停止条件 | plateau / maxRounds / time / tokens / manual（`src/types.ts:16`） | complete / blocked / 轮上限 budget-limited | complete / paused / blocked、`round-limit` blocker、max tokens、取消、卸载 |
| 需先建 goal | 否 | 否 | **是**，且须 resume 才 arm |
| 模型面工具 | `metric_loop`（start / tick / status / stop） | `ralph` | `create_goal` / `update_goal` / `get_goal` |

补充事实：

- 状态落 `~/.dsh/metric-loop/metric-loop-<id>.json`（`src/index.ts:96`），schema v1、tmp+rename 原子写、历史截断 500（`src/persist.ts:20,86,23`）；
- 停止优先级 plateau > maxRounds > time > tokens（`src/engine.ts:191-220`），缺省 window=5 / maxRounds=50（`engine.ts:21,23`）；metricless 时不判 plateau（`engine.ts:193`）；
- `guardScope` 两态：`tool-args`（start，命令在入参里、`tools/pre-execute` 已覆盖 → 不重复判定，`src/index.ts:483`）vs `engine-side`（tick，命令取自状态文件 → 引擎内复查，`src/index.ts:270,371`）；复查不可用时 fail-open 并标 `guardSkipped`（`src/index.ts:166,417`）；
- `tool-ralph` 是固定前台脚本 `ralph-loop`（`lib/index.js:25`），每 Round 一个全新 spawn 子 agent，父对话不复制；配置 `subagentProvider` / `maxRounds`（base patch 设 64）/ `maxHandoffChars` / `maxResultChars`（`lib/index.js:19-22`）；
- `goal-round-driver` 无 Config（lib 仅导出 apply / inject / name），要求 goal `phase === 'active' && activation === 'armed'`；activation 不持久，resume / fork 后 disarmed；轮上限来自 goal 的 `maxGoalRounds`（`dsh-goal/lib/index.js:588` 默认 256），blocked 阈值 = `blockedAfterConsecutiveRounds` 默认 3（`dsh-tool-goal/lib/index.js:115`）。

### 只有 `metric-loop` 有的能力

- 测量命令执行 + stdout 末位数字解析，失败按无改进（`src/measure.ts:31,43`、`src/engine.ts:158`）；
- 指标方向比较 / 历史最优 / streak / plateau 收敛判定（`src/engine.ts:26,191`）；
- 四类边界停止 + manual（`src/engine.ts:206`、`src/index.ts:316`）；
- 跨进程 JSON 状态（原子写、schema 版本、历史截断）（`src/persist.ts:20,86`）；
- cadence 节流（auto 受限 / explicit 紧急）（`src/engine.ts:104`）；只读服务 `metricLoop`（`src/index.ts:85,427`）；
- 执行前命令复查的 `guardScope` 来源分工（`src/types.ts:140`、`src/index.ts:371`）。

### 事实校正（本仓文档有误）

1. **`tool-ralph` 实际未挂载**：`dsh-base/cordis.patch.yml:447-448` 对其为 `disabled: true`，fff profile 无 overlay。本条目的「三者均已挂载」与 `docs/ARCHITECTURE-REUSE.md:28` 的「两者 fff 均已挂载」**均需更正**。旁证：本会话工具面有 `metric_loop` 与 goal 系列工具，无 `ralph`。
1. **`schedule` 提示结构性不可执行**（新发现，见下）。

### `schedule` 缺口的实际后果

- `dsh-schedule` 在官方树存在（0.2.0-rc.2），但**不属 `dsh-base`**，唯一依赖方是未挂载的 `dsh-experimental-schedule-bundle`；官方 README 另称它无法在 headless / SDK-only 组合单独挂载（需 Host Web Session controller + 持久化 + storage-domain）；
- 本包对它是**软引用**：`src/engine.ts:233` 只返回字符串 `tool: "schedule_create"`，零 import、零 inject（`src/index.ts:82` 仅 `["tools"]`）→ 缺它不减功能，降级为「提示是纯文案」，循环仍需显式 tick 或其他唤醒推进（README:56 已自述）；
- **额外发现**：`schedule_create` 的 `title` 是 `required: true`（`dsh-schedule/lib/index.js:2126`），而本包 hint 只给 `{ after_seconds, prompt }`（`src/engine.ts:234`）→ **即使挂上 schedule，按该提示调用也会被 `invalid_prompt` 拒绝**（`dsh-schedule/lib/types/tools.js:212`）。这不是挂载缺口，是提示本身写错。

### 文档现状

- `metric-loop/README.md` 全文**无** ralph / goal-round-driver 字样 → 尚无与官方的分工口径；只有 schedule 缺口告警（README:56）与「轮内动作由宿主 workflow 编排、插件不感知」（README:57）；
- 无 `metric-loop/docs/`（轻量包豁免，无 DESIGN / BACKLOG）；
- 分工分析散在 `docs/ARCHITECTURE-REUSE.md:28`（总表行）、`:89`（§4 C）、`:132`（纠正「官方只有 schedule」）。

## 决策

**需用户裁定**（本任务只备材料）。可选路径：

- **A** 保留 `metric-loop` 承担「测量 + 收敛 + 边界停止」，把与 `goal-round-driver` 的边界写进 README；
- **B** 循环交给官方（goal + `goal-round-driver`），`metric-loop` 只留测量与状态；
- **C** 维持现状，仅在 README 写明三方分工。

## 规划

**计划改动文件清单（待裁定后收敛；未列出的文件一律不改）**

- `docs/BACKLOG.md` —— 更正「三者均已挂载」；登记 `schedule_create` 提示缺陷为新条目
- `docs/ARCHITECTURE-REUSE.md` —— 更正 `:28` 的挂载口径与 `:89` §4 C
- `metric-loop/README.md` —— 三方分工口径（裁定后写）
- 若走 A/B：`metric-loop/src/**`

**明确不做**

- 本任务不做裁定、不改 `metric-loop` 行为
- 不去挂 `schedule`（需先定 headless 可行性，且提示本身要先修）

## 实现记录

- 2026-10-05：接取条目并标记「进行中」；完成三方对照调研（见上），**无代码改动**。发现两处文档事实错误 + 一处提示缺陷。

## 测试与证据

（待实现后补；调研阶段的对照材料见「调研」一节）

## 收尾

（待关闭时补）
