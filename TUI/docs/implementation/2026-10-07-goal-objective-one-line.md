# 状态列 Goal 块改「一句话概括」（接取条目：`TUI/docs/BACKLOG.md`「状态列 Goal 块内容改「一句话概括」，不显示 objective 全文」）

状态：决策（调研阶段结论；实施待条目 1 落地后开始）　　开启：2026-10-07　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。**前置** = 本层条目「`⟳` 显示条件改「收到过边就显示」」（同改 Goal 状态块头部渲染，先定符号口径）。

## 目标

状态列 Goal 块的 objective **全文折行**占多行（状态列宽 = 1/3、最低 20 列），挤压 Todo / Jobs / Agents 块并触发 L0-L3 折叠降级。目标：Goal 块正文固定 **≤1-2 行**、信息可辨识，全文仍有入口可读；先做**可行性调研**并给出推荐路径。

## 调研（2026-10-07，宿主源码实测）

### 路径 ①「用宿主已有字段」→ **否，有硬证据**

1. 快照字段是**严格白名单**：`dsh-goal/lib/index.js:86-102` 的 `decodeSnapshot` 只接受 `id` / `revision` / `objective` / `phase` / `maxGoalRounds`（blocked 相位另加 `blockedReason`）；`:92-93` 逐键比对 `expectedKeys`，**多一个键就抛错**（`must have exactly … fields`）。
2. 三个 goal 包里 `summary` / `title` 的命中**都不是快照数据字段**：`dsh-goal/lib/typert.host.js:438-504` 是 typert **服务方法说明文本**；`dsh-tool-goal/lib/index.js:248`（`present(title, …)`）与 `:370`（`summary: boundContextSummary(…)`）是**工具调用的呈现字段**（给工具结果卡用），不是 goal 快照的一部分。
3. ⇒ 既**读不到**概括字段，也**加不进去**（解码器拒绝额外键）。

### 路径 ②「本地启发式（首句 / 首 N 字符 + `…`）」→ **推荐，且有官方先例**

1. 官方 Web UI（`dsh-client-ui-goal`）显示的就是**单行截断**：`lib/client.js:129` 的 `.nLMEza_objective{ … text-overflow:ellipsis; white-space:nowrap; overflow:hidden }`，渲染 `goal.objective` 原文（`:289-290`）。
2. 该组件自述（`:153`）：「A present goal shows a goal glyph, a phase label, the **truncated** objective」——即官方**不生成摘要、不加字段**，只在显示层截断。
3. 零依赖、确定性、无缓存与失效问题；与 TUI 现有「按列宽折行 / 截断」工具同族（状态列本身已有 `fitHead` / `fitTail` 一类函数）。

### 路径 ③「LLM 摘要」→ 可行但不推荐

复刻 `session-title` provider 模式（goal create / edit 后异步生成一次 + 缓存 + 失败回退）需要：新 provider 或复用官方标题 provider、缓存与失效口径、异步副作用与失败路径；而官方自身都没这么做（见 ②）。**除非**将来需要真正的语义概括（例如 objective 很长且首句无信息量），否则收益不抵成本。

## 决策

**D1｜采用路径 ②（本地截断）**，理由：官方先例 + 零依赖 + 无缓存失效问题；路径 ① 被宿主严格白名单否掉，路径 ③ 成本不成比例。

**D2｜形态：替换，不新增展开交互** → Goal 块正文只显示截断后的行；**全文入口 = 宿主 `/goal` 命令输出**（TUI 侧 `/goal` 本地无行为、route 交宿主：`app/commands.ts:259-266`；宿主 `dsh-command-goal/lib/index.js:59-72` 的 `renderGoal` 输出 `Objective: <全文>`，落在活动区 notice，默认 `collapse off` 完整折行）。不新增状态列内的展开键位。

**D3｜截断口径** → 取 objective **首个非空行**，再按状态列正文宽截断并加 `…`；不按句号切分（首句可能整段无句号，反而不稳）。宽度分档（子代理复核后修正）：状态列最低 20 列（`layout.ts:354-355`）→ **正文宽 ≥18 列**，故「≤8 列只显示 `…`」不可达；实际口径 = 宽列（正文 ≥24 列）恒 **1 行**，窄列（正文 <24 列，约 9-15 个汉字）允许 **最多 2 行**（条目验收本就允许 ≤1-2 行）。

**D4｜与折叠分级的关系** → Goal 块正文恒 ≤1 行 → 状态列总高下降，L0-L3 降级**更少触发**（这是本条的附带收益，不额外改降级规则）。

**D5｜缓存** → 不引入（每帧由 objective 现算，与路径 ② 一致；`edit` 后自动反映）。

**明确不做**：不动宿主 / 不加快照字段 / 不新增 provider / 不改 `/goal` 面板行为 / 不改其它块（Todo / Jobs / Agents）的渲染。

## 规划（计划改动文件清单）

1. `TUI/src/app/layout.ts`：**`goalObjectiveRows` 实现在 `:1006-1017`**（调用点 `:1239`；`:1020-1036` 是 `goalHistoryRows`，勿改错函数）——当前 goal 行改单行/窄列 2 行截断渲染；**历史行（`goalHistoryRows`）保持全文折行不变**（与条目「历史行口径不变」一致）；必要时抽 `oneLineObjective(text, width)` 纯函数便于测试。
1. `TUI/tests/status-column.test.ts`：**先修 3 处会红的既有断言**（子代理探针实测）——`:191`（单行后总高降到 L0 即放下，原断言「objective 在 L2 压标题行时隐藏」反转）、`:197`（高度充足时不再出现 `行39`）→ 两处改为断言「恰 1 行 + 结尾 `…`」，并把这两条**折叠分级用例的撑高手段换成其它内容**（如多条 todo）以保留 L0-L3 覆盖；`:316`（正文宽 15 列 vs 目标 22 显示列 → `目标三` 被截）→ 改断言首段 + `…`。然后新增 4 条：长 objective 恰 1 行 + `…`、多行 objective 取首行、窄列（18-23 列）≤2 行、空 objective 不炸。
1. `TUI/docs/SPEC.md` §15.1（Goal 块渲染口径）、`TUI/docs/DESIGN.md`、`TUI/README.md`（如提到 objective 全文）按 D2/D3 回写。
1. `TUI/docs/BACKLOG.md`：条目〔进行中〕→ 关闭时移除（余下条目按编号口径重编）。
1. 本追踪文档：建 → 关闭时移入 `TUI/docs/archived/`。

**估时**：调研已完成（本轮）；实施 45-75 min（子代理复核后上调：含 3 处既有断言的改写与折叠用例撑高手段替换）。**验收**（条目原文）：Goal 块正文固定 ≤1-2 行且信息可辨识；全文仍可经 `/goal`（宿主命令输出）读到；回归全绿 + 真机目视。

## 实现记录

（待实施，前置 = 条目「`⟳` 显示条件」）

## 测试与证据

本轮调研证据：`dsh-goal/lib/index.js:86-102`（严格白名单 + 多键抛错）、`dsh-goal/lib/typert.host.js:438-504`（summary 仅是方法说明）、`dsh-client-ui-goal/lib/client.js:129 / :153 / :289-290`（官方单行截断先例）。未改动任何文件（除本追踪文档与 BACKLOG 状态）。

## 收尾

（待实施后关闭）
