# @dsh-toolset/task-engine

DSH（DeepSeek Harness）任务树引擎：Frame 状态机 + decompose / implement / stop / status 工具族，分解双重门禁与 RET 验收（mechanical / semantic / human）路由。

## 能力

模型侧工具（`inject: ["tools"]`）：

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `task_decompose` | `parent_id`、`children`（`{id, title, spec, acceptance, need_decompose, coverage, deps, executor}`） | `{ok, accepted, next, feedback?}` |
| `task_implement` | `task_id`、`result` | `{ok, feedback?}` |
| `task_execute` | `task_id` | `{ok, accepted, next, evidence?, usage?, feedback?}` |
| `task_stop` | `task_id` | `{ok, accepted, next, feedback?}` |
| `task_status` | — | `{ok, tree}`（**多轮：森林**——每轮一棵树，树根带 `round`；`parent_id` + `order` + `executorKind?`，先序） |

- **多轮根帧（会话 = 解释器，2026-10-05）**：一轮 = 一棵完整树（根帧会 `done`，不变量不变）；对**已完成的当前轮根**再 `task_decompose` 会**自动开新一轮**——新根 `root-2` / `root-3…`（首轮仍是 `root`，向后兼容），沿用同一根契约（`root` 示例行的 `{title, spec, acceptance[], needDecompose?}`），旧轮**只读保留**在事件流里。`"root"` 始终解析为**当前轮**根；子帧 id 跨轮必须唯一（复用会覆盖旧轮帧并污染 pool / worktree 注册表 → 门禁拒绝）；`plan/root-created` 载荷带 `round`（旧事件缺省 = 1）；`resumeFromSnapshot` 取**最后**一条 `plan/root-created` 作为当前轮。**非根父帧 done 仍照旧拒绝**；当前轮根 **done 或 failed** 都可开新轮（`failed` 是逃生口——否则一次失败后会话会永久卡住）。注意**轮次与 id 后缀会不同步**：轮次由 `round` 字段表示（1 起，按开轮顺序），`root-<n>` 只是**避让后**的 id（子帧已占 `root-2` 时新根用 `root-3`）。

- **叶子执行后端（① 执行扩展，2026-10-02）**：叶子（或 `needDecompose:false` 的根）可声明 `executor`，由 `task_execute` 交给**注入式适配器**发起（引擎只做发起 / 证据回填 / 验收，提示词与脚本都由声明方给，引擎不替模型生成）：

  - `model`（缺省语义）= 本会话执行，等价模型自己调 `task_implement`（`task_execute` 会拒绝并指向 `task_implement`）；
  - **`subagent`**：`ctx.subagents.start(provider='spawn', {label, prompt, parent, signal, agentOptions})` —— `prompt` 缺省由引擎按「标题 + spec + 验收清单 + 上次反馈」拼装；只有声明了 `model` / `budget` 才传 `agentOptions`（`{provider, model, maxTokens}`），未声明则**不传** = 保持宿主「合并父 agent 选项」的语义；取 `result.output` 文本为证据后 `dispose`；`stopReason` 非 `completed` / `max-tokens` 视为失败（`aborted` = 用户中止，不打回）；
  - **`workflow`**：`ctx.workflowEngine.start({script, meta, parent})` —— `script` 必给（引擎不生成脚本）；`meta` 由引擎生成默认值（`name = task:<frame>`、`description = 帧标题`）并与声明**浅合并**（叶子给谁覆盖谁）；`value` 为对象 / 数组时记入 `plan/frame-executed.structured`，文本证据为缩进 JSON；失败分类：`start` 同步抛错（META_INVALID / SCRIPT_PARSE）= **声明错误 → 不打回不计重试**，`cancelled`（用户取消）= 不打回，`error` = 交 bounded retry（反馈附 `已启动子代理 N 个`）；
  - **`command`**：`/bin/sh -c`（可带 `cwd`；声明 `isolate` 时 `cwd` 被隔离工作区路径覆盖），退出码非 0 = 失败（可重试）；证据 = stdout + stderr；
  - 可选字段：`model`（`{provider, model}` 覆盖）、`budget.maxTokens`（映射宿主 `agentOptions.maxTokens`，即输出上限语义）、`cwd`、`isolate`（隔离，见下条）、`prompt` / `script` / `meta`（按后端取用）；
  - 用量计量（②）：subagent 事后**优先读宿主 `tokenUsage` 投影**（`sessionProjections.stateOf(子会话, "tokenUsage")` → `totals.outputTokens`＝provider 实际上报的**输出 token 累计**），记 `tokens` 并标 `tokensKind: "usage"`；投影不可用（服务缺失 / 子会话**尚无 usage 样本**（`last === null`）/ 字段非法 / 抛错）时**回退** `tokenMeter.measure(子会话)` 的 `tokensKind: "pressure"`（上下文压力，含系统提示词 / 工具定义）；
  - 超预算（②）：**不做 tokens 数值比较**——`pressure` 与上下文相关、`usage` 的 `totals` 是跨请求累计，而 `budget.maxTokens`（宿主 `agentOptions.maxTokens`）是**每次请求**的输出上限（真机 12 个 spawn 子会话实测：totals 6–81,955，实际声明预算 256/512/4000 → 数值比较会把 10/12 恒判超预算）。判定改用宿主的**权威信号**：叶子声明了 `budget.maxTokens` 且子代理 `stopReason === "max-tokens"`（因输出上限被截断）→ `overBudget: true`；未声明预算或后端没给信号 → 不写该字段；无论哪种都**只标注、不据此打回**；
  - 校验收在**机械门禁**（`rule: "executor"`，带反馈打回）：只允许叶子声明、kind 白名单、`command` 必给 `command`、`workflow` 必给 `script`、`meta.name` / `meta.description` 非空、`model` 覆盖须给全 provider/model、`budget.maxTokens` 须为正数、`isolate` 只认 `"worktree"` 且仅 `command` 后端 + 必须同时给 `cwd`（`rule: "isolate-id"` 另拒 id 里的危险词 / 敏感文件形状，见下条）；
  - 执行记录落 `plan/frame-executed`（`executor` / `model` / `tokens` / `overBudget` / `structured` / 证据摘要 / `retryable`），**证据全文**仍走 `plan/frame-implemented`（既有验收链不看新事件）；三类后端证据统一**截断**到 8000 字符（超出标注原始长度）；
  - 宿主服务（`subagents` / `workflowEngine` / `agentDefaultModel` / `tokenMeter` / `sessionProjections`）在**执行期惰性解析**（当前工具执行 ctx 优先 → 回退插件 ctx）：apply 期服务 fiber 未激活时 `ctx.get` 会返回 undefined（真机实测），故装载期不缓存句柄，只在发起时按名读取，apply 期探测仅打印告警；
  - 失败分流：`retryable` 缺省 true → 走 bounded retry（`maxRetries` 后置 `failed`）；`retryable: false`（宿主面缺失 / 能力位不足 / 脚本声明错 / 用户取消）→ **不打回、不计重试、不改帧状态**，只把反馈交给模型改声明。

- **executor 隔离（`isolate: "worktree"`，2026-10-02 自建简易版）**：叶子声明 `executor.isolate = "worktree"`
  且 `kind` 为 `command` 时，`task_execute` 先建 git worktree（`<repo>/.worktree/<leafId 安全化>`，分支
  `dsh/<leafId 安全化>`），再把该路径**覆盖** `cwd` 交给命令后端；帧进入终态（`done` / `failed`）时回收。

  - 只对 **`command` 后端**生效：宿主 `SubagentStartRequest` / workflow 面**都没有 cwd 参数**，隔离无处落地
    → 声明期直接报错（不「假装隔离」）；必须同时声明 `cwd`（仓库根只在它下面用 `git rev-parse --show-toplevel`
    定位，**不猜 `process.cwd()`**）；`isolate` 只认 `"worktree"`。
  - **id 规则**（`rule: "isolate-id"`）：隔离目录名 / 分支名由 leafId 派生，会原样出现在 git 命令文本里，
    故 id 里含危险词（提权 / 磁盘 / 关机类）或形似敏感文件名（凭据 / 私钥 / env）时**声明期拒绝**并提示改 id
    —— 否则建与回收的 git 命令都会被 security-guard 拦下。
  - **路径收敛**：leafId 中非 `[A-Za-z0-9_-]` 的字符替换为 `_`（被清洗过时追加 8 位短哈希防撞名），建之前
    再断言最终路径落在 `<repo>/.worktree/` 之内（`../../evil` 这类穿越 id 收敛在隔离目录内）。
  - **回收永不 `--force`**：先查注册表（不在册 = 已回收，幂等）；干净工作区才 `worktree remove`，成功后才
    `branch -D`；**脏树（有未提交改动 / 未跟踪产出）一律保留现场** —— 路径 + 取回提示写进
    `plan/frame-completed.notice`、`stop` 返回与 stderr 告警（三处可见，不静默）；回收失败同样保留现场，
    崩后残留（分支在、目录不在）先 `worktree prune` 再用 `-B` 重建。
    **注意：隔离区产出不会被自动 merge**；要留用请自行提交 / 复制出去（成功路径也会尝试回收干净工作区）。
  - **时序边界**：只有**终态**才回收；打回重试（非终态失败）保留现场供二次执行复用（同 leafId 复用同一
    worktree，不重复 `add`）；abort / resume 把在途帧回收为 `pending` 时**不回收**（重入按注册表复用）；
    插件 unload 时 best-effort 回收在册工作区（脏树同样保留）。已知残余：跨进程残留、隔离区无 `node_modules`。
  - **复查与审计**：git 调用一律 `execFile` 直调（不经 shell，超时 60s），且**复用** `makeCommandGuard` 做
    执行前复查（`source` 形如 `task-engine{worktree} <leafId> cwd=<repo>`）：命中即不执行，回执原文原样返回。
    该 `source` 只是回执首行的**来源标注（便于审计定位）**，不参与 guard 判定，不构成安全缓解。

- **分解双重门禁**：先跑机械门禁——粒度四规则（越级 / 过粗 / 过细 / 数量）+ coverage 完备性（父每条验收须有本次子任务覆盖）+ `deps` 前置传递（只允许引用前序兄弟，自引用/前向引用/未知 id 拒绝）+ `executor` 声明校验；通过后若配置 `entail` hook，再跑语义蕴含（合取是否蕴含父契约）。任一拒绝都带反馈打回并记 `retryCount`，达 `maxRetries` 置 `failed`。

- **RET 验收路由**：mechanical → `/bin/sh -c` 退出码 0；human → `ctx.approval.request`（`allowed-once` 视为通过，拒绝 / 无人应答 / 抛错一律 fail-closed）；semantic → 注入式 `audit` hook 的独立 audit run（缺 hook，或声明了 `outputSchema` 却无 `structured`，均 fail-closed 打回）。

- **完成与 join**：一个帧的全部验收通过才弹栈，并向上 join（全部子任务 done 后复核父契约）。

- **事件溯源**：所有变更 append 事件流（`plan/root-created`、`plan/node-expanded`、`plan/frame-activated`、`plan/frame-implemented`、`plan/frame-executed`、`plan/acceptance-verdict`、`plan/step-verdict`、`plan/frame-rejected`、`plan/frame-completed`、`plan/frame-interrupted`、`plan/frame-failed`），树由事件流折叠重建；配置 `snapshotPath` 后每次事件串行写盘（unload 时再写一次），`resumeFromSnapshot` 可恢复。

- **有界并发（fan-out）**：就绪池是 DFS 栈，active 帧数达 `maxConcurrent` 时不再弹栈；`activeCount()` 统计在途帧。

- **step 级裁决**：`decompose` / `stop` 结果带 `accepted` / `next`，并写入 `plan/step-verdict` 事件。`next` 语义：`stop` 打回时指向本帧（重做）、帧置 `failed` 时为 `null`、通过时取就绪池候选（不消费）；`decompose` 成功时为第一个子任务 id，拒绝时为 `null`（事件内记为父帧，供审计）。

- **只读查询面**：`provide('taskEngine')`，暴露 `query()`（任务清单 / 帧栈 / active 计数 / 是否完成）与 `frameStack()`，纯读取、零副作用。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `root` | 示例根（标题「当前任务」、空 spec、`needDecompose: true`、无验收） | 根任务契约 `{title, spec, acceptance[], needDecompose?}`；`acceptance[].level` 非法时归一为 `mechanical`。此处的验收项只收 `{id, check, level, command?}`，`outputSchema` 只能经工具入参 `output_schema` 声明 |
| `snapshotPath` | 未配置（纯内存运行） | 事件流快照路径；配置后每次变更近实时写盘 |
| `commandTimeoutMs` | `30000` | mechanical 验收命令超时（ms） |
| `maxConcurrent` | `4` | 有界并发上限 |
| `semantic.audit` | `true` | semantic 级验收的独立 audit run（经 `ctx.subagents` 裁决子代理；`false` → 回到 fail-closed 文案） |
| `semantic.entail` | `true` | 拆解第二道门的 entail run（`false` → 该门跳过，回到旧行为） |
| `semantic.timeoutMs` | `120000` | 单次裁决 run 超时（超时/失败：audit **fail-closed** 打回；entail **跳过该门**并告警——不烧重试预算） |

门禁默认值 `maxChildren=7`、`maxRetries=3`、`maxConcurrent=4` 定义在 `DEFAULT_GATE`；插件 config 只暴露 `maxConcurrent`（其余两项供引擎级调用覆盖）。

## 使用示例

工具调用（模型侧）：

```jsonc
{ "parent_id": "root", "children": [{ "id": "c1", "title": "…", "spec": "…",
  "acceptance": [{ "id": "a1", "check": "…", "level": "mechanical", "command": "npm run check" }],
  "need_decompose": false, "coverage": { "r1": ["c1"] },
  "executor": { "kind": "subagent", "prompt": "…", "budget": { "maxTokens": 4000 } } }] }
{ "task_id": "c1" }              // 未声明 executor（model 语义）→ 模型自己写产出
{ "task_id": "c1", "result": "实现产出" }
{ "task_id": "c1" }              // 声明了 executor → 用 task_execute 发起后端（此处为 subagent）
// 隔离（仅 command 后端）：命令在 <repo>/.worktree/c1 里跑，主树不动
{ "id": "c2", "title": "…", "spec": "…", "acceptance": [], "need_decompose": false, "coverage": {},
  "executor": { "kind": "command", "command": "npm run check", "isolate": "worktree", "cwd": "/abs/path/to/repo" } }
```

profile 挂载（`~/.dsh/profiles/<p>`）：`package.json` 的 `dependencies` 加
`"@dsh-toolset/task-engine": "link:<本包绝对路径>"`，`dsh.profile.bundles` 加 `"@dsh-toolset/task-engine"`。构建产物经 symlink 实时可见，直接 `dsh --profile <p>` 加载（无需 `pnpm install`；勿用 `file:` 依赖）。

需要覆盖插件配置（如 `snapshotPath`、`maxConcurrent`）时，在同一 profile 的 `cordis.patch.yml` 追加：

```yaml
- id: task-engine
  name: '@dsh-toolset/task-engine'
  config:
    maxConcurrent: 4
```

## 边界与限制

- **边界与外包**（2026-09-30 决策）：引擎自研「语义与不变量」——帧栈与状态机（decompose / implement /
  stop / join / retry / 快照恢复）、拆解门禁（粒度 + coverage + deps）、RET 验收路由、事件溯源与查询面；
  「机制与资源」一律复用宿主，不重复造：
  - 执行与隔离：叶子可声明 `executor`（`model` = 本会话执行，缺省；`subagent` / `workflow` / `command`
    后端由模板或叶子显式声明，引擎不替模型生成脚本）——**已实现**（2026-10-02，见上「叶子执行后端」）；
    **隔离（git worktree）已实现（自建简易版，2026-10-02）**：`executor.isolate = "worktree"`，**仅 `command`
    后端**（宿主 subagent / workflow 面无 cwd 参数）；不自动 merge、不做审查 / checkpoint、不处理远程、不并发
    复用同一 leafId（见上「executor 隔离」）。原计划复用的第三方 `dsh-git-worktree` 至今无实现（本机不存在），
    官方 316 个公开包里也没有 worktree 隔离实现，故自建简易版；未隔离时 `cwd` 仍只做透传（既有行为不变）；
  - 模型路由与计量：`llm` / `agent-default-model`（不自研路由）；
  - 审批与语义验收：`approval`、`audit` / `entail` —— **已接线**（2026-10-02）：两者各跑一次**裁决子代理**（经 `ctx.subagents`，与 `subagent` 执行后端共用 `runChildOnce`；prompt 只输出一个 JSON 对象，`{"pass"|"ok": boolean, "feedback": string}`，声明了 `outputSchema` 时另带 `structured`）；开关与超时见 Config `semantic`（缺省都开，`timeoutMs` 120s）；**任一次裁决 run 失败 / 超时 / 输出不可解析 → fail-closed 打回**（不假通过）；**工具面收窄**（2026-10-04）：裁决 run 带 **`toolFilter.deny` = 本引擎注册成功的全部 `task_*` 工具名**（宿主 `spawn` provider 支持 `toolFilter` → `ctx.tools.restrict`），裁决子代理**看不到** `task_decompose` / `task_implement` / `task_execute` / `task_stop` / `task_status`，无法反向操作同一引擎与任务树（不再只靠 prompt 约束）；名单只在工具**注册成功**后收集（注册是 best-effort；一个都没成功 → 不收窄，避免宿主 `restrict()` 因未知工具名拒绝整次裁决 run）；provider 未声明该能力位时**降级**（不收窄、裁决照跑）并在 stderr 留一条告警（每插件实例一次）；**执行后端**（`subagent` executor）自 2026-10-04 起**同口径收窄**（执行方的产物由调用方经 `task_implement` / `task_stop` 回写，不需要 `task_*` 族）；带 `toolFilter` 的发起若失败（deny 名单里的名字在宿主**全局注册表**已失效——插件 remount / 卸载重注册的空窗）→ **去 filter 重试一次**并在告警留痕（加固降级，不让本次裁决 / 执行 run 直接挂掉）；
  - 工具注册与会话面：`tools` / `agents` / `sessions`（需要时的 jobs / schedule 只用于等待，不作调度器）。
  - **明确不替换**：宿主 `todo`（模型面清单，无契约 / deps / 验收 / 溯源，不能当帧栈）、
    `experimental-agent-team` 任务板（跨执行器调度板，可作呈现或辅助，不作 Frame 底座）。
- 引擎内核零 DSH 依赖：`audit`（semantic 验收）与 `entail`（语义蕴含）在**引擎侧**仍是注入式 hook，插件形态（`apply`）已按上条接线（裁决 run 经 `ctx.subagents`）；显式关掉（`semantic.audit=false` / `semantic.entail=false`）时分别回到 fail-closed 与跳过。父帧（无自身产出）的裁决证据由**子帧结论汇总**（§17.3），否则语义门对父验收无产出可审。
- fan-out 有界并发只是引擎侧 claim 语义；真实多执行器并行（agent-team DAG）属宿主编排层，
  引擎侧只保证「帧在途」的记账与上限。
- 单会话实例：一个引擎持有一棵任务树。
- 快照持久化依赖 `snapshotPath`；未配置时跨进程恢复不可用。
- mechanical 验收命令由插件以 `/bin/sh -c` 执行，信任契约内命令、无额外沙箱（进程级沙箱由宿主策略承载）。
- **执行期复查**（2026-10-02；留痕口径同日硬化）：命令**执行之前**各过一次 security-guard —— ① `executor` 的 `command` 后端（`task_execute` 发起前）、② mechanical 验收命令（含不在 `task_decompose` 登记表里的 `root.acceptance[].command`）。复查经 `ctx.get('guard').inspectCommand(command, source)`，`source` 形如 `task-engine{executor} <frameId>` / `task-engine{acceptance} <frameId>`；命中即**不执行**，回执原文作为失败原因（`task_execute` → `ok:false`；验收 → 不通过）。
  该检查点**需 guard 挂载**（security-guard 插件经 `provide('guard')` 暴露，本包惰性读取、不进 `inject`）：**未挂载或复查抛错 → fail-open 放行 + 每种失效模式只告警一次**（不刷屏、不让既有流程失败）——即未挂载 security-guard 时执行期无复查，与声明处检查（`task_decompose`）的覆盖一起构成纵深。
  **复查不可用要可见（D1，不静默）**：fail-open 照旧，但「这条命令没复查过」写进事件流与反馈 —— 命令缝落 `plan/frame-executed.guardSkipped`，验收缝落 `plan/acceptance-verdict.guardSkipped` 并随 `task_stop` 反馈透出（「复查留痕：security-guard 执行前复查不可用（fail-open 放行），验收命令未复查即执行（guardSkipped）」，成功路径也带 feedback）。
  **隔离的 git 调用**（`rev-parse` / `worktree add` / `prune` / `list` / `status` / `remove` / `branch -D`）走同一复查面与同一 `makeCommandGuard` 实例，`source` 形如 `task-engine{worktree} <leafId> cwd=<repo>`；该 `source` 只是回执首行的来源标注（便于审计定位），**不参与判定**。隔离只对 `command` 后端生效 → 隔离执行必经命令缝，`guardSkipped` 已在同一 `plan/frame-executed` 上留痕；**回收期**（终态钩子）的 git 调用不走事件流，属已知残余（仅告警可见）。
- abort 语义：宿主中止 turn 后重启，`resumeFromSnapshot` 为每个在途 active 帧补记 `plan/frame-interrupted`，回收为 pending 且不增 `retryCount`；有隔离工作区的帧在这一路径上**不回收**（保留现场，重入按注册表复用），跨进程残留属已知残余。
- `ctx.tools` 缺失时告警并跳过工具注册；`ctx.approval` 缺失或 `request` 抛错时静默 fail-closed（human 级一律视为未批准），保证 bundle 加载不崩。

## 目录结构

```
src/
  types.ts      # Frame / Acceptance / ExecutorSpec / PlanEvent / TaskTree / StepVerdict
  events.ts     # 事件溯源：materialize 折叠、嵌套视图、快照/恢复
  gate.ts       # 分解门禁：粒度四规则 + coverage + deps + executor 校验 + 隔离 id 规则（DEFAULT_GATE）
  acceptance.ts # RET 裁决：mechanical / human / semantic
  engine.ts     # TaskEngine：decompose / implement / execute / stop、有界就绪池、join、bounded retry、终态钩子、查询面
  tools.ts      # 模型侧工具族（纯数据 + 处理器，零 DSH 依赖）
  main.ts       # cordis 插件入口（结构面适配、宿主服务惰性解析、executor 后端接线、worktree 隔离器）
index.ts        # 包入口：re-export src/main（编译产出 dist/index.js）
scripts/        # executor-smoke.mjs：主机适配层冒烟（dist 级 + 假宿主面）
demo/main.ts    # mock demo（脚本化模型，自断言）
tests/          # node:test 单测
docs/           # DESIGN.md（架构与设计取舍）、BACKLOG.md（模块待办）、implementation/、archived/
```

架构与设计取舍见 `docs/DESIGN.md`；模块待办见 `docs/BACKLOG.md`；过程记录见 `docs/archived/`。

## 测试

```sh
npm run check   # 类型检查（tsc --noEmit）
npm run build   # 编译到 dist/
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'（112 例：engine / events / gate /
                # query / tools / semantic / usage / exec-guard / exec-isolate（隔离 14 例：建 / 回收 / 脏树取舍 /
                # id 安全化 / id 规则 / 崩后残留 / 卸载兜底 / guard 命中 / 幂等 / 非 git 仓库 / 声明面）等）
npm run demo    # npm run build && node dist/demo/main.js；脚本化模型跑步骤 0-7 + 演示 8-13，
                # 覆盖全链路（门禁打回→implement→stop→join）、fan-out 有界并发、
                # 语义验收 audit、step 裁决、语义蕴含门、abort 恢复、叶子执行后端；输出 DEMO_OK / DEMO_FAIL，退出码 0/1
npm run smoke:executor  # npm run build && node scripts/executor-smoke.mjs；dist 级 + 假宿主面冒烟，
                # 覆盖**主机适配层**（单测与 demo 都踩不到的部分）：subagent 的 `agentOptions` 映射与
                # usage 投影口径用量 + 无投影回退 pressure + `max-tokens` → `overBudget`、未声明模型不传 `agentOptions`、command 真跑 `/bin/sh`、
                # workflow 默认 meta 合并与对象证据、同步抛错不打回不计重试、`cancelled` 反馈、
                # 宿主服务惰性解析、证据截断边界、`execute → stop → join`；输出 SMOKE_PASS / SMOKE_FAIL，退出码 0/1
```

架构对照见 `docs/host/AGENT-ARCHITECTURE-ANALOGY.md`。
