# `metric-loop` 与官方两套循环机制并存（接取条目：`docs/BACKLOG.md`「`metric-loop` 与官方两套循环机制并存且分工未裁定」）

状态：关闭　　开启：2026-10-05　　关闭：2026-10-06
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

2026-10-06 用户裁定：**选 A**。

**A = `metric-loop` 定位为「指标循环」那一层**：测量命令 + 收敛判定（best / streak / plateau）+ 四类边界停止 + 跨进程状态；与官方 `goal-round-driver`（宿主事件驱动、需已建且 armed 的 goal、无指标无跨进程状态）的分工写进 README。**不改代码、不改 profile。**

理由（对照另两条）：

- B（循环交给官方 + 本包只留测量）要拆 `src/engine.ts` 的 tick / 停止判定，并会失去**三项无替代品的能力**：指标收敛判定、四类边界停止、跨进程 JSON 状态；且官方驱动要求先建 goal 并 resume 后才 arm，门槛更高；
- C 与 A 落地文件几乎相同，差别只在给不给本包写定位——不写等于把判断留给下一个人；
- `tool-ralph` 是**默认关闭**的（见下「事实更正」），把它算作「并存机制」不成立，也不作为本项目循环路径。

**事实更正（本次核实，含我中途的一次错判）**：

- 启动用的是**全局安装树**（`/home/guochang/.local/share/fnm/.../lib/node_modules/@deepseek-ai/dsh`，dsh 0.2.0-rc.2），其 `dsh-base/cordis.patch.yml:447-449` 为 `tool-ralph: disabled: true`，注释明确「Off by default … An overlay row restores it (`- id: tool-ralph` / `disabled: false`)」→ **调研引用的 `:447-448` 正确**；
- `~/.npm/_npx/c40503fdf38a82ea/` 是 **0.1.5-rc.2 旧树**，同一行**没有** `disabled` —— 我中途 grep 的是这棵树，据此误判「调研写错了」，**该错判已撤回**；口径：宿主面事实一律读全局树；
- 旁证：本会话工具目录实测 50 个模型面工具，**无 `ralph`**（`ralph` 的实现两版逐字节相同，故功能描述不受树差异影响）。

**据此新增的登记项**：`docs/host/HOST-PACKAGES.md:76` 把 `tool-ralph` 列入「§1 现成可用（fff 已挂载）」为误（该行实为 base 默认 `disabled: true`）→ 追加 BACKLOG 条目；`docs/host/` 按仓库约定「不参与变更流程，按自身过期条件复核」，**本任务不改它**。

## 规划

**计划改动文件清单（未列出的文件一律不改；用户选 A 时已一并批准下列清单）**

- `metric-loop/README.md` —— 新增「与官方循环机制的分工」节：三方（本包 / `goal-round-driver` / `tool-ralph`）能力对照 + 本项目口径（本包承担指标循环；官方驱动走 goal 路线；`tool-ralph` 默认关闭、本项目不启用）
- `docs/ARCHITECTURE-REUSE.md` —— 更正 `:28` 总表行的挂载口径（`tool-ralph` 默认禁用、`goal-round-driver` 在位）；`§4 C` 标「已裁定（A）」
- `docs/BACKLOG.md` —— 追加新条目（`HOST-PACKAGES` 误标 `tool-ralph` 为已挂载）；关闭时移除本条目
- 本追踪文档 + 归档

**明确不做**

- 本任务不做裁定、不改 `metric-loop` 行为
- 不去挂 `schedule`（需先定 headless 可行性，且提示本身要先修）

## 实现记录

- 2026-10-06：用户裁定 **A**；决策与计划清单落本文件（状态 → 决策）。
- 2026-10-06：实现（纯文档，4 个文件）——
  - `metric-loop/README.md`：新增「与官方循环机制的分工（2026-10-06 裁定 A）」节 —— 三方对照表（驱动源 / 前置条件 / 测量与收敛 / 停止边界 / 跨进程状态 / 轮间共享 / 是否在位）+ 本项目口径四条（指标收敛用本包 / goal 续轮用官方 / `tool-ralph` 不启用 / 不把两条循环叠在同一目标上）；
  - `docs/ARCHITECTURE-REUSE.md`：`:28` 总表行改「保留（已裁定 A，2026-10-06）」并更正挂载口径（只有 `goal-round-driver` 在位；`tool-ralph` base 默认 `disabled: true`，一行 overlay 可恢复）；§4 C 标「已裁定（选 A）」；
  - `docs/BACKLOG.md`：追加条目「`docs/host/HOST-PACKAGES.md` 把 `tool-ralph` 标为已挂载与实测不符」；
  - 本追踪文档。

## 测试与证据

文档类变更，验证 = `format` + 自查 diff（不涉及 `check` / `build` / `test`）。

- `format metric-loop/README.md docs/ARCHITECTURE-REUSE.md docs/BACKLOG.md <本文件>` → 通过；`git status` 仅这 4 个文件。
- 事实复核（裁定所依据的两条，落文档前逐条实测）：
  - 启动树 = 全局安装 `dsh 0.2.0-rc.2`，其 `dsh-base/cordis.patch.yml:447-449` = `- id: tool-ralph` / `name: '@deepseek-ai/dsh-tool-ralph'` / `disabled: true` —— 逐行打印确认；
  - 本会话工具目录实测 **50** 个模型面工具，`'ralph' in names === False`（会话日志 `request/header` 解帧后统计）。
- 反向证据（说明为何要写这节）：`~/.npm/_npx/c40503fdf38a82ea/`（0.1.5-rc.2 旧树）同一行**无** `disabled` —— 我据旧树一度误判「调研写错了」，已撤回并写进决策节，避免下一个人再踩。

## 收尾

- 条目「`metric-loop` 与官方两套循环机制并存且分工未裁定」已从 `docs/BACKLOG.md` §2 **清理移除**，其余条目重编号；本文件移入 `docs/archived/`。
- 关闭后回写：`metric-loop/README.md`（本包契约面，含三方分工口径）、`docs/ARCHITECTURE-REUSE.md` 两处（§0 总表行、§4 C）。`docs/host/HOST-PACKAGES.md` 本体**未改**（宿主面文档按自身过期条件复核），改为在 BACKLOG 追加条目。
- 途中发现并已登记：`docs/BACKLOG.md` 新条目（`HOST-PACKAGES` 误标 `tool-ralph` 已挂载）、原有条目「`metric-loop` 的 `schedule` 续排提示结构性不可执行」保持独立。
- 遗留：`tool-ralph` 若将来要启用，是 profile overlay 一行（`- id: tool-ralph` + `disabled: false`，项目目录外，需授权）——本任务明确不做。
- `STATUS.md` 按流程由用户择时更新，本次不改。
- 提交：前三个询问点用户均选择留到关闭后；本次为**关闭后一次性提交**。
