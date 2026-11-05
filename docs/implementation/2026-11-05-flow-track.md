# 标准流程固化插件 flow-track（接取条目：docs/BACKLOG.md「标准流程固化插件 `flow-track`」）

状态：调研 / 决策（进行中）　　开启：2026-11-05　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

把项目「标准流程」（`docs/WORKFLOW-STANDARD.md` / `AGENTS.md` 内容变更规范）从「文档规范 + agent 自觉」固化为插件机制：

- 流程阶段由 **task-engine** 承载为任务树——根下第一层分解 = 标准流程各阶段（**目标 / 调研 / 决策 / 规划 / 实现 / 测试 / 审查 / 收尾**，八阶段于 2026-11-05 用户裁定），各帧 `deps` 指前序、`acceptance` 设门（mechanical / human / semantic），审查与提交询问走 `approval.request` = human 门禁；
- 流程正文与状态落 **memory-base**（P 层 project 库，`registerKind` 写句柄 + 本插件补模型侧写工具）；
- 回合边界经 **rule-engine** 消费者注入阶段模板、检查合规、带路推进。

命名定稿（2026-11-05 用户裁定）：`flow-track`，项目内「动词+对象」风格（与 `pin-note` / `term-check` 同构）。避让：不用 `workflow` 作包名（task-engine 叶子执行后端已占用该 kind 语义）。

## 调研（来源：既有代码与既有裁定）

- `task-engine/README.md`：工具族 `task_decompose` / `task_implement` / `task_execute` / `task_stop` / `task_status`; 引擎内核 `TaskEngine.decompose` / `implement` / `execute` / `stop` / `query` / `frameStack`（`engine.ts:63-609`, 零 DSH 依赖）; `provide('taskEngine')` 服务面只暴露只读 `query()` / `frameStack()`; config `root` 只收 `{title, spec, acceptance[], needDecompose?}`; 机械门禁四规则（`DESIGN.md:66`）：越级 / 过粗 / 过细 / 数量（数量本身不设上限, >8 才要枚举来源）+ coverage + deps（只允许引用前序兄弟）+ executor 校验; RET 验收：mechanical（`/bin/sh` 退出码）/ human（`ctx.approval.request`, fail-closed）/ semantic（audit / entail 子代理裁决）; 事件溯源 `plan/*` + `snapshotPath` 快照 + `resumeFromSnapshot`。
- `memory-base/README.md:9`：**不注册写工具**——模型侧只有只读 `memory_query`; 写权限留在各扩展的 `registerKind(spec)` 返回的写入句柄（`writableTiers` 声明可写层, P 层 project 库）。
- `rule-engine/README.md`：消费者 `decide`（每回合边界按注册节点询问, 返回值注入）+ guard 面（`tools/pre-execute` 拦截）+ `agent/pre-step` 注入面（goal-round-driver / agent-instructions 同款通道）。
- 既有裁定：先例插件 `pin-note` / `term-check` 同为「跨压缩 / 治理类」插件条目; 追踪文档仍是 md 文件（git / check:docs / md-map / 归档三件套); 流程**状态与流程文档正文**落 memory-base（用户在 2026-11-05 讨论中选定「混合」取向: 正文留文件、状态落库, 分支见「决策」）。

## 调研补充（2026-11-05 接续: 决策项 4 所需事实）

- **服务面写能力**：`task-engine/src/plugin.ts:377-383` 的 `provide('taskEngine')` 只给 `query()` / `frameStack()` 两个只读方法; 引擎内核 `TaskEngine`（`task-engine/src/engine.ts:63-609`）零 DSH 依赖, 但实例与其事件溯源 / 快照接线由 `plugin.ts` 持有。故「插件在回合边界自动 `TaskEngine.decompose`」有两条路: ① 扩 `taskEngine` 服务面（属 task-engine 包改动, 须另开条目）; ② 直接 import 内核并自建实例——会与工具族使用的树分裂成两份状态, 不可取。**当前服务面下不可行**, 除非先改 task-engine。
- **模板注入面**：rule-engine 两类消费面齐备——`decide`（回合边界按注册节点询问, 返回值统一注入, `rule-engine/src/consumers.ts:41-136`）与 guard（`tools/pre-execute` 拦截, 先例 `behavior-correction`）; 注入节点十个含 `turn-start` / `user-message` / `step-start`（`rule-engine/src/rules.ts:29`）。
- **阶段状态存储**：`memory-base` 的 `registerKind({kind:"flow", writableTiers:["project"]})` 给 `put` / `forget` 句柄（`memory-base/README.md:17-38`）; 模型侧无写工具（`:82-88`）, 故 `flow_record` 一类写工具须由本插件注册。P 层库惰性创建、带隐私闸与容量控制。
- **分流判据的可用信号**：`session/event` 里可观测 `tool/call`（是否写类工具）与 `user/message`（用户是否指定快速流程）; 追踪文档存在性可从文件系统判断（`docs/implementation/` / `<模块>/docs/implementation/`）。三者都可作为判据, 但都需要显式阈值, 否则误判成本高于收益。
- **硬档代价**：guard 拦截「未登记就改源码」会挡 `write` / `edit` / `bash` 的常规改动, 一旦判据失误就把正常改动挡死（用户须手工放行）, 风险明显高于软 / 中两档。

## 决策

- 决策项 1 = 插件命名
  - 候选（动词+对象风格）: `flow-track` / `flow-check` / `change-track` / `flow-gate`
  - 选定：`flow-track`（用户 2026-11-05 裁定）。理由：动词 track + 对象 flow, 覆盖「流程状态跟踪 + 阶段推进」核心; 与 `term-check` / `pin-note` 同构; `flow-check` 只突出合规检查, `change-track` 语义窄, `flow-gate` 偏硬固化。
- 决策项 2 = 流程承载形态
  - a. **task-engine 骨架（选定）**: 根下第一层 = 标准流程各阶段, 每帧 `deps` 指前序、`acceptance` 设门, human 验收 = 提交询问点
  - b. 自研状态机: 重复实现拆解 / 验收 / 重试, 不采用
- 决策项 3 = 流程存储形态（用户 2026-11-05 改判: **b 全文入库**）
  - ~~a. **混合（选定）**: 追踪文档正文仍是 md 文件（git / check:docs / md-map / 归档不变）; 流程状态 / 检查点 / 提交询问记录落 memory-base P 层~~（2026-11-05 被 b 取代）
  - **b. 全文入库（选定）**: 追踪文档正文整体存 memory-base, 文件体系仅留入口
  - 边界（2026-11-05 用户澄清）: 本项是**插件启用后的目标形态**, 不是现在的作业流程; flow-track 未启用期间, 本仓仍按原流程（追踪文档 = `implementation/<日期>-<slug>.md`）执行, 现有工作不受影响。
  - 启用前待评审（届时另开任务, 不并入本任务）: ① `docs/WORKFLOW-STANDARD.md` §6/§7 的追踪文档模板与归档规则改成「正文入库 + 文件只留入口」; ② `dev/standard` 与 `md-map` 对追踪文档的检查 / 索引是否仍适用; ③ `AGENTS.md`「所有文档变更只写这份追踪文档」口径与「正文落库」的衔接。
- 决策项 4 = 固化强度与模板来源（用户 2026-11-05 裁定: **4.1 = a, 4.2 = a, 4.3 = b**；候选保留备查）
  - 4.1 阶段模板来源: **a 选定** —— 模型照注入模板手动 `task_decompose`（零改引擎, 服务面现状可行）; b. 插件回合边界自动 `TaskEngine.decompose`（**当前服务面不可行**, 须先扩 `taskEngine` 写方法, 属 task-engine 包改动 + 另开条目）; c. 先 a 后 b（二期扩服务面）
  - 4.2 大 / 小流程分流判据: **a 选定** —— 不自动分流, 由模型自行声明走标准流程或快速流程（零误判成本, 靠注入提醒）; b. 按改动规模（文件数 / 行数）判, 阈值写配置; c. 按是否已建追踪文档判
  - 4.3 固化强度档: **b 选定** —— 中档（每轮注入当前推进状态 + 合规检查提示）; a. 软（回合开始注入阶段模板提醒）; c. 硬（guard 拦截, 误判即挡死正常改动）
  - 裁定理由: 服务面现状下 a 可行且零改引擎; 分流交模型最不易误判; 中档能带路又不阻断。

## 规划（实现计划, 2026-11-05 定稿并复核；**尚未开工**）

### 0. 步骤与验证（每步都可执行、可判定）

| 步骤 | 产物 | 验证命令 | 判据 |
| --- | --- | --- | --- |
| 1 建包骨架 | `package.json` / `cordis.patch.yml` / `tsconfig.json` / `tests/tsconfig.json` | `pnpm -C flow-track run check` | 0 错；`dsh.bundle.patch` 指向存在的文件 |
| 2 阶段模板 | `src/stages.ts` | `pnpm -C flow-track run test`（`tests/stages.test.ts`） | 8 条阶段、`deps` 成链、阶段 7 门禁为 `human`、其余 `mechanical` |
| 3 状态读取 | `src/status.ts` | `tests/status.test.ts` | 帧栈末位 → 阶段名映射用例；空快照 → `undefined` |
| 4 存储 | `src/store.ts` | `tests/store.test.ts` | 写后 `list({kind:"flow", tier:"project"})` 读回一致 |
| 5 合规观测 | `src/observe.ts` | `tests/observe.test.ts` | 收到 `tool/call` 判为写类工具；只读工具不计 |
| 6 注入 | `src/inject.ts` | `tests/inject.test.ts` | 四类输入组合的注入文本断言（见 §8） |
| 7 工具面 | `src/tools.ts` | `pnpm -C flow-track run test` | `flow_record` / `flow_status` schema 合法 + 读回用例 |
| 8 接线与降级 | `src/index.ts` | `docs` 检查 + 单测 | 三服务缺席各有降级用例 |
| 9 构建 | `dist/` | `pnpm -C flow-track run build` | `dist/src/index.js` 存在且导出 `apply` / `name` / `inject` |
| 10 根级接线 | 根 `package.json` / `scripts/*` / `AGENTS.md` / README 双侧 | `pnpm run check:docs` / `pnpm run check` | 两项通过 |

已核实可用的宿主/本仓接口：`taskEngine` 服务面只读 `query()` / `frameStack()`（`task-engine/src/plugin.ts:381-383`），快照字段见 `task-engine/src/engine-types.ts:170-179`；rule-engine 节点含 `turn-start` / `user-message`（`rule-engine/src/types.ts:18-29`），`delivery` 含 `inject`（`:37`）；`tool/call` 会话事件载荷含 `name`（宿主 `packages/core/session/src/types.ts:369`）；P 层全局 `list` 会 `openExisting` 打开库（`memory-base/src/index.ts:388-390`）。

### 1. 包结构与文件

```
flow-track/
  package.json / cordis.patch.yml / tsconfig.json / tests/tsconfig.json / README.md
  src/stages.ts     # 标准流程阶段模板（常量 + 渲染文本），8 阶段, deps 链
  src/store.ts      # memory-base kind "flow"（P 层）写入 / 列举
  src/status.ts     # 只读 task-engine 快照 → 当前阶段 / 下一步文本
  src/observe.ts    # session/event 观测写类工具调用（内存态, 不落盘）
  src/tools.ts      # flow_record（记录推进 / 合规事件）、flow_status（读当前阶段）
  src/inject.ts     # rule-engine 消费者：回合边界注入模板 / 推进状态 / 合规提示
  src/index.ts      # Config / resolveConfig / apply（服务接线与降级）
  tests/stages.test.ts / status.test.ts / store.test.ts / observe.test.ts / inject.test.ts / main.test.ts
```

### 2. 阶段模板 `src/stages.ts`（决策项 2 + 4.1 = a）

固定八阶段（2026-11-05 用户裁定: 目标 / 调研 / 决策 / 规划 / 实现 / 测试 / 审查 / 收尾）, 每阶段 = 单动作 spec（无「首先 / 然后 / 第 n 步」标记、无实现细节, 防过细 / 越级打回）, `deps` 指前序, `acceptance` 设门:

| 阶段 | spec（单动作） | acceptance | deps |
| --- | --- | --- | --- |
| 1 目标 | 写清任务目标与验收口径 | mechanical: 追踪文档含「目标」节且写明验收 | - |
| 2 调研 | 读相关代码与宿主面, 结论带来源锚点 | mechanical: 含「调研」节且有 `文件:行` 级来源 | 1 |
| 3 决策 | 决策项按数字、选项按 abcd 列候选并选定 | mechanical: 每项写明选定字母与理由 | 2 |
| 4 规划 | 写计划改动文件清单与明确不做 | mechanical: 含「计划改动文件清单」 | 3 |
| 5 实现 | 按清单改动并追加实现记录 | mechanical: `pnpm run check` 通过 | 4 |
| 6 测试 | 跑相关 `test` / `check:docs` 并补「测试与证据」 | mechanical: 命令与输出入档 | 5 |
| 7 审查 | 交审查方审阅 diff 与效果, 结论入档 | human（`approval.request`） | 6 |
| 8 收尾 | 归档追踪文档、清理 BACKLOG 条目、按需回写文档 | mechanical: 文件移动 + 条目移除 | 7 |

- 提交询问点（`docs/WORKFLOW-STANDARD.md` §5 的四处）落在阶段 3 / 5 / 6 / 8 内部, 阶段 7 的 human 门禁即「人工确认 / 审阅」那一次。
- coverage 覆盖根契约验收（「一次标准流程变更全程走通 + 审查与提交询问经 human 验收」）。
- 数量 8 ≤ 8, 免枚举来源（符合引擎门禁的「数量」规则）。
- 模板以文本注入（`renderStages()`），模型据此手动 `task_decompose`。

### 3. 存储 `src/store.ts`（决策项 3 = b 的目标形态, 本任务先落「状态 + 正文」两列）

- `ctx.memory.registerKind({ kind: "flow", writableTiers: ["project"] })` → `MemoryScope`。
- `putFlowRecord({ slug, stage, status, body? })`：一条记录 = 一个字段（`title: "<slug>@<stage>"`，`content: status + 正文`），便于按标题列举与追加。
- `listFlowRecords(slug?)`：`ctx.memory.list({ kind: "flow", tier: "project", limit: 50 })`（P 层全局 `list` 会 `openExisting` 打开库, 可直接读回, 与 S 层不同）。
- 正文入库仅在 flow-track 启用后生效; 本任务实现「可写入正文」的能力, **不改** `docs/WORKFLOW-STANDARD.md` 的追踪文档规则（见决策项 3 边界）。

### 4. 推进状态 `src/status.ts`

- 从 `ctx.taskEngine`（只读 `query()`）取 `TaskEngineSnapshot`：`tasks` / `frameStack` / `activeCount` / `isComplete`（`task-engine/src/engine-types.ts:170-179`）。
- `currentStage(snapshot)`：帧栈末位 → 阶段名; 无任务时返回 `undefined`（注入文案降级为「尚未建阶段树」）。
- 渲染「当前阶段：N/8 名称；下一步：…；门禁：mechanical / human」。

### 5. 注入 `src/inject.ts`（决策项 4.3 = b 中档）

- `registerConsumer({ id: "flow-track", sources: ["turn-start", "user-message"], delivery: "inject", dedupeInRecord: 0, decide })`。
- `decide` 产出三类文本（合并为一条, 顺序固定）：
  1. 阶段模板（首次回合 / 无阶段树时给出八阶段与建树提示）；
  2. 当前推进状态（有阶段树时给「当前阶段 / 下一步 / 门禁」）；
  3. 合规提示（观测到本轮有写类工具调用（`write` / `edit` / `bash`）但 BACKLOG 未登记、或未写追踪文档时, 给一条提醒；**只提示不拦截**）。
- 合规观测（`src/observe.ts`）：消费者只在注入时机唤醒、不能兼做记账，故**另挂一个** `ctx.on("session/event", (session, event) => …)`，只认 `event.type === "tool/call"`（载荷含 `name`），按会话记「最近一次写类调用」（`write` / `edit` / `bash` / `pwsh`）；只读工具（`read` / `grep` / `glob`）不计。状态只留内存、不落盘。
- 无阶段树 + 无写类调用 → 不注入（避免每轮刷屏）；同一会话同一回合只注入一次（引擎的 `dedupeInRecord` 与 `cooldownTurns` 都按摘要计数，正文相同即被去重）。

### 6. 工具面 `src/tools.ts`

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `flow_record` | `slug`、`stage`、`status`、`body?` | 写一条流程记录（P 层） |
| `flow_status` | `slug?` | 读阶段树快照 + 最近记录, 渲染推进状态 |

### 7. 服务接线与降级

- `inject: ["ruleEngine"]`; 可选面 `taskEngine` / `memory`（`ctx.get` 探测）:
  - `ruleEngine` 缺席 → 告警、不注册消费者;
  - `taskEngine` 缺席 → 状态注入降级为「模板 + 记录」（无阶段树信息）;
  - `memory` 缺席 → 工具返回可读错误、不写库。

### 8. 测试清单

| 用例 | 断言 |
| --- | --- |
| `renderStages()` | 八阶段文本含阶段名、门禁类型、deps 顺序 |
| `currentStage(snapshot)` | 帧栈末位映射正确; 空快照返回 undefined |
| `observe` 写类 / 只读工具 | 写类记入、只读不计 |
| `decide` 无阶段树无写调用 | 返回 null（不刷屏） |
| `decide` 无阶段树有写调用 | 含模板 + 「未登记」提示 |
| `decide` 有阶段树 | 含「当前阶段 N/8 … 下一步 …」 |
| `flow_record` / `flow_status` | 写入与读回一致；memory 缺席时返回错误文本 |
| 降级 | `ruleEngine` / `taskEngine` / `memory` 缺席各一条断言（告警 + 降级行为） |

### 9. 根级接线（与 `term-check` 同款的九处，逐项在 §0 步骤 10 验证）

根 `package.json` 两条链、`pnpm-workspace.yaml`、`scripts/install.sh`、`scripts/test-parallel.sh`、`AGENTS.md`（计数 33 → 34、包清单、描述、轻量包口径）、根 `README.md` / `README.zh.md`（表 + 目录树）、`profiles/example/*`、本包 `README.md`、追踪文档；关闭时清理 BACKLOG 条目。

### 10. 顺序（验证口径见 §0）

1. `stages.ts` + `status.ts` 纯函数与单测（零依赖，先做）。
2. `store.ts`（memory 替身）+ 单测；P 层读面已核实可用（`memory-base/src/index.ts:388-390`）。
3. `observe.ts` + 单测（`session/event` 替身）。
4. `inject.ts`（rule-engine 替身）+ 单测。
5. `tools.ts` + `index.ts` → `pnpm -C flow-track run check` / `build` / `test`。
6. 根侧 `pnpm run check:docs` + `pnpm run check`; 人工确认（真机跑一次标准流程到提交询问）。

### 11. 风险与未决点

- **注入频率**：`turn-start` + `user-message` 双节点可能一轮多注；`decide` 内按会话记「同一文本本回合已注入」, 只留一条。
- **阶段树分裂**：本插件只读 `taskEngine.query()` 的服务面实例（不 import 内核）, 与工具族同一棵树, 无分裂风险。
- **正文入库**：决策项 3 = b 的文档体系改动不在本任务（见决策项边界），本任务只保证「正文可入库存得下」，不改变现有追踪文档写法。
- **合规判据偏简**：只按「写类工具调用 + 无 flow 记录」触发，不解析「改了哪类文件」；判据失真时改提示文案即可，不升级为拦截（决策项 4.3 = b 中档的边界）。

计划改动文件清单：

- `flow-track/`（新包：上述文件）
- `docs/BACKLOG.md`（条目登记, 已完成；关闭时清理）
- 本追踪文档
- 根 `package.json`、`pnpm-workspace.yaml`、`scripts/install.sh`、`scripts/test-parallel.sh`、`AGENTS.md`（插件清单与包计数, 非流程口径）、根 `README.md` / `README.zh.md`、`profiles/example/*`

明确不做：

- 不改 task-engine 引擎内核与门禁规则（阶段分解在既有能力内表达）
- 不改 memory-base（不把写工具内联到 memory-base, 保持"写权限留扩展句柄"口径）
- 不改 `docs/WORKFLOW-STANDARD.md` / `AGENTS.md` 的流程口径（决策项 3 边界）
- 不替换宿主 todo / experimental-agent-team
- 不动 `STATUS.md`（用户择时更新）

## 实现记录

（待写）

## 偏差

（待写）

## 测试与证据

（待写）

## 收尾

（待写）
