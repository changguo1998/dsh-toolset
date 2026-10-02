# task-engine 设计

模块：`task-engine`（帧栈与验收引擎）。本文件记架构与设计取舍；契约与用法见 `../README.md`，过程记录见 `./archived/`。

## 目标与边界

把「长任务」变成**机器可判**的结构：拆解成帧树，每帧带验收契约，逐帧推进并在父帧处合取复核；模型负责判断与自证，不变量由引擎兜。

明确的边界（与 README「边界与外包」一致，这里是取舍理由）：

- **不自研机制**：并发调度（只做引擎侧 claim 记账）、会话与工具的宿主面、模型路由 / 计量、审批 —— 全部复用宿主；引擎内核零 DSH 依赖（`audit` / `entail` / `approve` / `executor` 都是注入式 hook）。
- **不替换宿主 `todo`**：模型面清单没有契约、deps、验收与溯源，不能当帧栈。
- **单会话一棵树**：一个引擎实例持有一棵 `TaskTree`；跨会话协作由 session-channel 承担。
- **机械命令信任契约**：mechanical 验收以 `/bin/sh -c` 执行声明里的命令，引擎不加沙箱（进程级策略归宿主）。
- **执行期复查（2026-10-02）**：命令**执行之前**各过一次 security-guard —— ① `executor` 的 `command` 后端（`task_execute` 发起前）、② mechanical 验收命令（含**不在** `task_decompose` 登记表里的 `root.acceptance[].command`）。复查走服务面 `ctx.get('guard').inspectCommand(command, source)`（本包惰性读取、不进 `inject`，跨包零硬依赖），`source` = `task-engine{executor} <frameId>` / `task-engine{acceptance} <frameId>`：命中即**不执行**，回执原文作为失败原因（`ok:false` / 验收不通过）。取舍：该检查点**需 guard 挂载**，未挂载 / 复查抛错一律 **fail-open 放行 + 每种失效模式只告警一次**（不刷屏、不让既有流程失败）；它与声明处检查（`task_decompose`，只覆盖工具入参里的命令）互补——Config / 状态旁路带进来的命令正是声明处查不到的那部分。
- **语义面已接线（2026-10-02）**：插件形态经 `ctx.subagents` 跑独立**裁决子代理**（与 subagent 执行后端共用 `runChildOnce`）——`audit`（semantic 验收）与 `entail`（拆解第二道门）都**按次构造**（hook 闭包捕获本次工具执行的 `exec`：宿主 `SubagentStartRequest.parent` 必填，且避免跨会话串线）；裁决走宿主 `outputSchema` 信封（`{pass|ok: boolean, feedback?: string, structured?: …}`，子会话经 `structured_output` 上报、宿主校验 → 不再依赖模型自报）；`unavailable`（环境/超时/不可解析）分流：audit **fail-closed**、entail **跳过该门**（不烧重试预算）；父帧无验收跳过 entail；开关见 Config `semantic`。

## 分层

```text
main.ts       插件入口：name / inject / provide / Config / apply
              ├─ 宿主服务惰性解析（工具执行 ctx → 插件 ctx）
              ├─ executor 适配器（subagent / workflow / command → engine.execute）
              ├─ ctx.tools.register ← tools.ts（ctx.tools 缺失 → 告警并跳过）
              └─ ctx.provide('taskEngine', { query, frameStack })（供 TUI /task 只读接线）
engine.ts     编排：帧状态机（decompose / implement / execute / stop / join / retry）
              + 有界就绪池（DFS 先序栈，maxConcurrent 上限）+ 查询面与快照
              ├─ gate.ts       机械门禁：粒度四规则 + coverage + deps + executor 校验
              ├─ acceptance.ts RET 裁决：mechanical / human / semantic
              └─ events.ts     事件溯源：append → 物化视图 / 嵌套视图 / 快照与恢复
types.ts      领域类型：Frame / Acceptance / ExecutorSpec / PlanEvent / TaskTree / StepVerdict
tools.ts      模型面工具族（纯数据 + 处理器，零 DSH 依赖）
index.ts      包入口：re-export src/main（编译产出 dist/index.js）
scripts/      executor-smoke.mjs：主机适配层冒烟（dist 级 + 假宿主面）
```

依赖方向单向：`main → engine → {gate, acceptance, events}`、`main → tools`；`engine` 只认注入的 hook 与接口，不认识宿主（可用假实现单测）。

## 关键设计取舍

### 1. 帧树是事件溯源的物化视图

`PlanEvent` 日志是唯一事实来源（`plan/root-created`、`node-expanded`、`frame-activated`、`frame-implemented`、`frame-executed`、`frame-rejected`、`frame-failed`、`frame-completed`、`frame-interrupted`、`acceptance-verdict`、`step-verdict`），`Frame` / `TaskTree` 由 `materialize` 折叠得出。收益：撤销式变更不需要，且**恢复语义天然**——`resumeFromSnapshot` 重放日志，并把在途 `active` 帧补记 `plan/frame-interrupted` 回收为 `pending`（不增 `retryCount`，用户 2026-09-30 口径）。

### 2. 双重门禁：机械先挡、语义可选

机械门禁（`gate.ts`）判**可机械判定的坏拆解**：越级（父帧已可执行却下钻）、过粗（子帧粒度超过父）、过细（子帧自身还需拆）、数量（0 或超 `maxChildren = 7`）、coverage 完备（父每条验收 id 必须有本次子帧覆盖）、deps 前置（只允许引用前序兄弟）、executor 声明合法。任一命中即带反馈打回并记 `retryCount`。

`entail`（合取是否蕴含父契约）是**语义**问题，做成注入 hook：未接线 / 关掉 / 裁决 run 不可用时**跳过该门**（不做「假装判过」，也不因环境故障烧重试预算）；模型明确判 `{"ok": false}` 才打回。见上「语义面已接线」。

### 3. RET 三级路由，缺能力 fail-closed

- `mechanical`：`/bin/sh -c` 退出码 0 = 通过；
- `human`：`ctx.approval.request`，仅 `allowed-once` 视为通过，拒绝 / 无人应答 / 抛错一律视为未批准；
- `semantic`：注入式 `audit` hook 的独立 run；缺 hook、或声明了 `outputSchema` 却没拿到 `structured`，一律 fail-closed 打回。

不通过 → `rejectFrame` 打回重做（带反馈），达 `maxRetries = 3` 置 `failed`；`failed` 帧使父帧 join 失败，避免「局部失败被静默吞掉」。

### 4. join 是逐级合取复核，不是「子帧全 done 就完事」

父帧的 `stop` 需要：父帧自身验收全过、且非叶子帧的子帧全 `done`；随后父帧转 `done` 并**继续向上递归**复核。`plan/frame-completed` 与 `step-verdict.next` 一起构成「下一步该做哪一帧」的显式信号（`next = null` 表示整树完成）。

### 5. 就绪池只有引擎侧 claim 语义

池是 DFS 先序栈（`pushPool` 逆序入栈 → 先序出栈；打回重试 `pushPoolFront` 放栈顶），`maxConcurrent = 4` 只限制**在途帧数**，不做真实并行调度——真实多执行器并行属宿主编排层。`nextReady` / `peekNextReady` 是「推进」与「预看」两个只读程度不同的入口。

### 6. 叶子执行后端（`executor`）契约

叶子（或 `needDecompose: false` 的根）可声明 `executor`，由 `task_execute` 交给注入式适配器发起：

- `model`（缺省语义）= 本会话执行，等同模型自己调 `task_implement`（`task_execute` 拒绝并指向它）；
- `subagent`：`ctx.subagents.start(provider='spawn', …)`；只在声明了 `model` / `budget` 时才传 `agentOptions`（未声明就不传 = 保持宿主「合并父 agent 选项」的语义）；取 `result.output` 后 `dispose`；
- `workflow`：`ctx.workflowEngine.start({script, meta, parent})`；`meta` 由引擎补 `name` / `description` 默认值后与声明浅合并；`value` 为对象时另记 `structured`；
- `command`：`/bin/sh -c`（可带 `cwd`），退出码非 0 = 失败。

**引擎只做发起 / 证据回填 / 验收，不替模型生成脚本或提示词**（提示词缺省时按标题 + spec + 验收清单 + 上次反馈拼装，仅此）。

### 7. 失败分流：执行失败可重试，声明 / 环境问题不打回

适配器返回 `retryable: false` 时（宿主面缺失、能力位不足、脚本 / meta 声明错、用户取消），引擎**不打回、不计重试、不改帧状态**，只落 `step-verdict` 把反馈交给模型改声明——重试这类错误没有意义，反而会烧掉重试预算并让帧进 `failed`。执行期失败（命令非零退出、子代理 `error` 等）才走 bounded retry。

### 8. 用量只记信息量；超预算只认权威信号

`budget.maxTokens` 映射宿主 `agentOptions.maxTokens`，语义是**每次请求**的输出上限。三个候选读数都不是同口径：

| 读数 | 口径 | 为何不能与 `budget.maxTokens` 比较 |
| --- | --- | --- |
| `tokenMeter.measure(子会话).totalTokens`（`pressure`） | 上下文压力（含系统提示词 / 工具定义，真机 1.9 万量级） | 与输出无关，真机曾稳定误报 |
| `sessionProjections.stateOf(子会话, "tokenUsage").totals.outputTokens`（`usage`） | provider 上报的**输出 token 累计**（跨 turn / 跨请求，含重试尝试） | 累计 vs 每请求上限：真机 12 个 spawn 子会话 totals 6–81,955，实际声明预算 256/512/4000 → 数值比较会把 10/12 恒判超预算 |
| `last.buckets.outputTokens` | 最后一次请求的输出 | 「最后一次」不等于「触顶的那次」 |

因此：**用量只作信息量**（优先 `usage` 投影、回退 `pressure`，用 `tokensKind` 区分），**超预算判定改用宿主权威信号** `stopReason === "max-tokens"`（叶子声明了预算时才采纳），`overBudget` 仍只标注、不据此打回。事件同时给 `tokens` / `tokensKind` / `overBudget`，读的人按需取。

宿主投影坐标（2026-10-02 真机核对）：`stateOf` 返回宿主 **state**（`{totals, last}`；未注册 key → `undefined`），而 `snapshot()` 的 wire view 是**裸 4 桶**（`view = state => state.totals`）——两者不同构，别混用；key `tokenUsage` 由 `dsh-token-meter` 自己注册（它在组合里就有）。子会话可读：registry 按会话缓存（`WeakMap<Session>`），宿主 UI（`dsh-client-ui-subagent`）自己就这么读子会话；`spawn` 无 seed（totals 只含子会话自身），若改用 `fork` 则会含父会话前缀。

### 9. 宿主访问：结构面 + 执行期惰性解析

不引 `@deepseek-ai/dsh-*` 运行时依赖，`ctx` 按结构面访问（最小接口）；`inject` 只要 `tools`（缺则降级告警），其余服务用 `ctx.get()`。

**关键教训（2026-10-02 真机）**：cordis 的 `ctx.get()` 虽不要求 `inject`，但服务 fiber 未激活时**静默返回 undefined** —— apply 期读 `subagents` / `workflowEngine` 拿到 undefined（包在磁盘、patch 已挂载），到工具执行期才可读。因此服务句柄**不在装载期缓存**，每次发起时按名解析（工具执行 ctx 优先 → 回退插件 ctx），apply 期探测只用于告警。

### 10. 查询面与工具面分离

`provide('taskEngine', { query, frameStack })` 是**只读**接线（TUI `/task` 面板用），与模型面工具族（`task_decompose` / `task_implement` / `task_execute` / `task_stop` / `task_status`）互不替代：前者不产生事件、零副作用，后者是唯一的写入口。`tools.ts` 保持纯数据 + 处理器，便于无宿主单测。

### 11. Config 用类型声明、不做运行时 schema

沿用本仓松口径：`Config` 不导出运行时校验器 → 宿主跳过校验、配置原样透传；非法值在 `normalizeRoot` / 门禁处收敛（打回或降级），换宿主版本不炸，代价是配置错误只体现在运行时反馈里。
