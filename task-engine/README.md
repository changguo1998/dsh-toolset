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
| `task_status` | — | `{ok, tree}`（嵌套任务列表，`parent_id` + `order` + `executorKind?`，先序） |

- **叶子执行后端（① 执行扩展，2026-10-02）**：叶子（或 `needDecompose:false` 的根）可声明 `executor`，由 `task_execute` 交给**注入式适配器**发起（引擎只做发起 / 证据回填 / 验收，提示词与脚本都由声明方给，引擎不替模型生成）：
  - `model`（缺省语义）= 本会话执行，等价模型自己调 `task_implement`（`task_execute` 会拒绝并指向 `task_implement`）；
  - **`subagent`**：`ctx.subagents.start(provider='spawn', {label, prompt, parent, signal, agentOptions})` —— `prompt` 缺省由引擎按「标题 + spec + 验收清单 + 上次反馈」拼装；只有声明了 `model` / `budget` 才传 `agentOptions`（`{provider, model, maxTokens}`），未声明则**不传** = 保持宿主「合并父 agent 选项」的语义；取 `result.output` 文本为证据后 `dispose`；`stopReason` 非 `completed` / `max-tokens` 视为失败（`aborted` = 用户中止，不打回）；
  - **`workflow`**：`ctx.workflowEngine.start({script, meta, parent})` —— `script` 必给（引擎不生成脚本）；`meta` 由引擎生成默认值（`name = task:<frame>`、`description = 帧标题`）并与声明**浅合并**（叶子给谁覆盖谁）；`value` 为对象 / 数组时记入 `plan/frame-executed.structured`，文本证据为缩进 JSON；失败分类：`start` 同步抛错（META_INVALID / SCRIPT_PARSE）= **声明错误 → 不打回不计重试**，`cancelled`（用户取消）= 不打回，`error` = 交 bounded retry（反馈附 `已启动子代理 N 个`）；
  - **`command`**：`/bin/sh -c`（可带 `cwd`），退出码非 0 = 失败（可重试）；证据 = stdout + stderr；
  - 可选字段：`model`（`{provider, model}` 覆盖）、`budget.maxTokens`（映射宿主 `agentOptions.maxTokens`，即输出上限语义）、`cwd`、`prompt` / `script` / `meta`（按后端取用）；
  - 用量计量（②）：subagent 事后经 `tokenMeter.measure(子会话)` 记录 `tokens` 并标 `tokensKind: "pressure"`（上下文压力口径，含系统提示词 / 工具定义，真机实测 1.9 万量级）；**只有 `usage` 口径参与 `overBudget` 判定**（pressure 不与输出预算比较——真机曾因此误报），且无论哪种口径都**只标注、不据此打回**；
  - 校验收在**机械门禁**（`rule: "executor"`，带反馈打回）：只允许叶子声明、kind 白名单、`command` 必给 `command`、`workflow` 必给 `script`、`meta.name` / `meta.description` 非空、`model` 覆盖须给全 provider/model、`budget.maxTokens` 须为正数；
  - 执行记录落 `plan/frame-executed`（`executor` / `model` / `tokens` / `overBudget` / `structured` / 证据摘要 / `retryable`），**证据全文**仍走 `plan/frame-implemented`（既有验收链不看新事件）；三类后端证据统一**截断**到 8000 字符（超出标注原始长度）；
  - 宿主服务（`subagents` / `workflowEngine` / `agentDefaultModel` / `tokenMeter`）在**执行期惰性解析**（当前工具执行 ctx 优先 → 回退插件 ctx）：apply 期服务 fiber 未激活时 `ctx.get` 会返回 undefined（真机实测），故装载期不缓存句柄，只在发起时按名读取，apply 期探测仅打印告警；
  - 失败分流：`retryable` 缺省 true → 走 bounded retry（`maxRetries` 后置 `failed`）；`retryable: false`（宿主面缺失 / 能力位不足 / 脚本声明错 / 用户取消）→ **不打回、不计重试、不改帧状态**，只把反馈交给模型改声明。
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
    **隔离（git worktree）未实现**：原计划经本机插件 `dsh-git-worktree`，而该插件当前在本机
    不存在实现（只有空目录、profile 未挂载），已另开 BACKLOG 条目，本包只做 `cwd` 透传；
  - 模型路由与计量：`llm` / `agent-default-model`（不自研路由）；
  - 审批与语义验收：`approval`、`audit` / `entail` 注入 hook（宿主 fork run）；
  - 工具注册与会话面：`tools` / `agents` / `sessions`（需要时的 jobs / schedule 只用于等待，不作调度器）。
  - **明确不替换**：宿主 `todo`（模型面清单，无契约 / deps / 验收 / 溯源，不能当帧栈）、
    `experimental-agent-team` 任务板（跨执行器调度板，可作呈现或辅助，不作 Frame 底座）。
- 引擎内核零 DSH 依赖：`audit`（semantic 验收）与 `entail`（语义蕴含）都是**注入式 hook**，真实链路（`ctx.subagents` fork audit run / 语义模型判定）由宿主侧接线；缺 hook 时分别降级为 fail-closed 与跳过。
- fan-out 有界并发只是引擎侧 claim 语义；真实多执行器并行（agent-team DAG）属宿主编排层，
  引擎侧只保证「帧在途」的记账与上限。
- 单会话实例：一个引擎持有一棵任务树。
- 快照持久化依赖 `snapshotPath`；未配置时跨进程恢复不可用。
- mechanical 验收命令由插件以 `/bin/sh -c` 执行，信任契约内命令、无额外沙箱（进程级沙箱由宿主策略承载）。
- abort 语义：宿主中止 turn 后重启，`resumeFromSnapshot` 为每个在途 active 帧补记 `plan/frame-interrupted`，回收为 pending 且不增 `retryCount`。
- `ctx.tools` 缺失时告警并跳过工具注册；`ctx.approval` 缺失或 `request` 抛错时静默 fail-closed（human 级一律视为未批准），保证 bundle 加载不崩。

## 目录结构

```
src/
  types.ts      # Frame / Acceptance / PlanEvent / TaskTree / StepVerdict
  events.ts     # 事件溯源：materialize 折叠、嵌套视图、快照/恢复
  gate.ts       # 分解门禁：粒度四规则 + coverage + deps（DEFAULT_GATE）
  acceptance.ts # RET 裁决：mechanical / human / semantic
  engine.ts     # TaskEngine：decompose / implement / stop、有界就绪池、join、bounded retry、查询面
  tools.ts      # 模型侧工具族（纯数据 + 处理器，零 DSH 依赖）
  main.ts       # cordis 插件入口（结构面适配，防御降级）
index.ts        # 包入口：re-export src/main（编译产出 dist/index.js）
demo/main.ts    # mock demo（脚本化模型，自断言）
tests/          # node:test 单测
```

## 测试

```sh
npm run check   # 类型检查（tsc --noEmit）
npm run build   # 编译到 dist/
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'（62 例：engine / events / gate / query / tools）
npm run demo    # npm run build && node dist/demo/main.js；脚本化模型跑步骤 0-7 + 演示 8-13，
                # 覆盖全链路（门禁打回→implement→stop→join）、fan-out 有界并发、
                # 语义验收 audit、step 裁决、语义蕴含门、abort 恢复、叶子执行后端；输出 DEMO_OK / DEMO_FAIL，退出码 0/1
npm run smoke:executor  # npm run build && node scripts/executor-smoke.mjs；dist 级 + 假宿主面冒烟，
                # 覆盖**主机适配层**（单测与 demo 都踩不到的部分）：subagent 的 `agentOptions` 映射与
                # pressure 口径用量、未声明模型不传 `agentOptions`、command 真跑 `/bin/sh`、
                # workflow 默认 meta 合并与对象证据、同步抛错不打回不计重试、`cancelled` 反馈、
                # 宿主服务惰性解析、证据截断边界、`execute → stop → join`；输出 SMOKE_PASS / SMOKE_FAIL，退出码 0/1
```

架构对照见 `docs/host/AGENT-ARCHITECTURE-ANALOGY.md`。
