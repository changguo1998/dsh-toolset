# @dsh-toolset/task-engine

DSH（DeepSeek Harness）任务树引擎：Frame 状态机 + decompose / implement / execute / stop / status 工具族，分解双重门禁与 RET 验收（mechanical / semantic / human）路由。

## 能力

模型侧工具（`inject: ["tools"]`）：

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `task_decompose` | `parent_id`、`children`（`{id, title, spec, acceptance, need_decompose, coverage, deps, executor}`） | `{ok, accepted, next, feedback?}` |
| `task_implement` | `task_id`、`result` | `{ok, feedback?}` |
| `task_execute` | `task_id` | `{ok, accepted, next, evidence?, usage?, feedback?}` |
| `task_stop` | `task_id` | `{ok, accepted, next, feedback?}` |
| `task_status` | — | `{ok, rounds, tree}`（**多轮：森林**——每轮一棵树，树根带 `round`；`parent_id` + `order` + `executorKind?`，先序。**默认只展开当前轮**，旧轮折叠为根摘要，细则见下） |

- **多轮根帧（会话 = 解释器，2026-10-05）**：一轮 = 一棵完整树（根帧会 `done`，不变量不变）；对**已终态（`done` / `failed`）的当前轮根**再 `task_decompose` 会**自动开新一轮**——新根 `root-2` / `root-3…`（首轮仍是 `root`，向后兼容），沿用同一根契约（`root` 示例行的 `{title, spec, acceptance[], needDecompose?}`），旧轮**只读保留**在事件流里。`"root"` 始终解析为**当前轮**根；子帧 id 跨轮必须唯一（复用会覆盖旧轮帧并污染 pool / worktree 注册表 → 门禁拒绝）；`plan/root-created` 载荷带 `round`（旧事件缺省 = 1）；`resumeFromSnapshot` 取**最后**一条 `plan/root-created` 作为当前轮。**非根父帧 done 仍照旧拒绝**；当前轮根 **`done` / `failed`** 都可开新轮（`failed` 是逃生口——否则一次失败后会话会永久卡住）。**失败向上传播（2026-10-27）**：子帧重试耗尽转 `failed` 时，仍在进行中的祖先（含根）一并转 `failed`，根因此才真正进终态；否则父帧等在「全部子帧 done」的 join 上，整棵树停在 `pending`，开新轮的逃生口永远用不到。注意**轮次与 id 后缀会不同步**：轮次由 `round` 字段表示（1 起，按开轮顺序），`root-<n>` 只是**避让后**的 id（子帧已占 `root-2` 时新根用 `root-3`）。

  `task_status` 的**模型面**视图（防多轮后森林膨胀）：`rounds` = 已开启轮数（= 当前轮号），`tree` 只展开当前轮（末项，不带 `truncated`），更早的轮折叠为根摘要 —— `children: []` + `descendantCount`（被折叠的后代帧数）+ `truncated: true`；`truncated` 只表示「该轮子树未展开（帧不缺）」，**本工具不提供取回**（旧轮只读，历史细节在事件流 / 追踪文档里）。引擎面不被折叠：`nested()` / `query()` 以及走它们的 TUI 任务面板与 demo 仍是全量森林。

- **叶子执行后端（① 执行扩展，2026-10-02）**：叶子（或 `needDecompose:false` 的根）可声明 `executor`，由 `task_execute` 交给**注入式适配器**发起；引擎只做发起 / 证据回填 / 验收，提示词与脚本都由声明方给。

  - 四 kind：`model`（缺省语义 = 本会话执行，`task_execute` 拒绝并指向 `task_implement`）/ `subagent` / `workflow` / `command`（`/bin/sh -c`，可带 `cwd`）；可选字段 `model`（`{provider, model}` 覆盖）、`budget.maxTokens`、`cwd`、`isolate`、`prompt` / `script` / `meta` 按后端取用。
  - 必填约束（机械门禁 `rule: "executor"`，带反馈打回）：只允许叶子声明；`command` 必给 `command`、`workflow` 必给 `script`；`meta.name` / `meta.description` 非空；`model` 覆盖须给全 provider/model；`budget.maxTokens` 须为正数；`isolate` 只认 `"worktree"`（仅 `command` 后端 + 必须同时给 `cwd`，见下条）。
  - 失败分类：`workflow` 的 `start` 同步抛错（`META_INVALID` / `SCRIPT_PARSE`）= **声明错误 → 不打回不计重试**，`cancelled`（用户取消）不打回，`error` 交 bounded retry（反馈附 `已启动子代理 N 个`）；`subagent` 的 `stopReason` 非 `completed` / `max-tokens` 视为失败（`aborted` = 用户中止，不打回）；`workflow` 的 `value` 为对象 / 数组时记入 `structured`（文本证据为缩进 JSON）；三类后端证据统一**截断**到 8000 字符（超出标注原始长度），**全文**仍走 `plan/frame-implemented`。
  - 执行记录落 `plan/frame-executed`（`executor` / `model` / `tokens` / `overBudget` / `structured` / 证据摘要 / `retryable`）；后端接线细节（`agentOptions` 映射、workflow `meta` 浅合并、用量投影与 `overBudget` 口径、`retryable` 分流）见 `docs/DESIGN.md`「关键设计取舍 6 / 7 / 8」。

- **executor 隔离（`isolate: "worktree"`，2026-10-02 自建简易版）**：叶子声明该字段且 `kind` 为 `command` 时，`task_execute` 先建 git worktree（`<repo>/.worktree/<leafId 安全化>`，分支 `dsh/<leafId 安全化>`），再把该路径**覆盖** `cwd` 交给命令后端。契约三条：

  - ① **只对 `command` 后端**生效且必须同时声明 `cwd`：宿主 `SubagentStartRequest` / workflow 面**都没有 cwd 参数**，隔离无处落地 → 声明期直接报错（不「假装隔离」）；`isolate` 只认 `"worktree"`。
  - ② **回收永不 `--force`**：干净工作区才 `worktree remove`，成功后才 `branch -D`；**脏树（有未提交改动 / 未跟踪产出）一律保留现场** —— 路径 + 取回提示写进 `plan/frame-completed.notice`、`stop` 返回与 stderr 告警（三处可见，不静默）。**隔离区产出不会被自动 merge**，要留用请自行提交 / 复制出去。
  - ③ **只有终态（`done` / `failed`）才回收**：打回重试（非终态失败）保留现场供二次执行复用（同 leafId 复用同一 worktree，不重复 `add`）；插件 unload 时 best-effort 回收在册工作区（脏树同样保留）。
    机制细节（id 安全化与 `rule: "isolate-id"`、注册表幂等与 `prune` 兜底、`execFile` + guard 复查、跨进程残留 / 无 `node_modules`）见 `docs/DESIGN.md`「关键设计取舍 12」。

- **分解双重门禁**：先跑机械门禁——粒度四规则（越级 / 过粗 / 过细 / 数量）+ coverage 完备性（父每条验收须有本次子任务覆盖）+ `deps` 前置传递（只允许引用前序兄弟，自引用/前向引用/未知 id 拒绝）+ `executor` 声明校验；通过后若配置 `entail` hook，再跑语义蕴含（合取是否蕴含父契约）。任一拒绝都带反馈打回并记 `retryCount`（**自动开轮路径除外**：临时新根未落盘即打回，不留空轮、也不把重试计数记到新根），达 `maxRetries` 置 `failed`。

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

- **边界与外包**（2026-09-30 决策）：引擎自研「语义与不变量」——帧栈与状态机（decompose / implement / stop / join / retry / 快照恢复）、拆解门禁（粒度 + coverage + deps）、RET 验收路由、事件溯源与查询面；「机制与资源」一律复用宿主，不重复造：
  - 执行与隔离：叶子可声明 `executor`（`subagent` / `workflow` / `command` 后端由模板或叶子显式声明，引擎不替模型生成脚本）；未声明 `isolate` 时 `cwd` 仍只做透传；隔离（git worktree）仅 `command` 后端、不自动 merge、不做审查 / checkpoint、不处理远程、不并发复用同一 leafId（见上「叶子执行后端」与「executor 隔离」）。
  - 模型路由与计量：`llm` / `agent-default-model`（不自研路由）。
  - 审批与语义验收：`approval`、`audit` / `entail`（接线与工具面收窄见下条）。
  - 工具注册与会话面：`tools` / `agents` / `sessions`（需要时的 jobs / schedule 只用于等待，不作调度器）。
  - **明确不替换**：宿主 `todo`（模型面清单，无契约 / deps / 验收 / 溯源，不能当帧栈）、`experimental-agent-team` 任务板（跨执行器调度板，可作呈现或辅助，不作 Frame 底座）。
- **语义面接线**（2026-10-02）：`audit` / `entail` 各跑一次**裁决子代理**（经 `ctx.subagents`，与 `subagent` 执行后端共用 `runChildOnce`；prompt 只输出一个 JSON 对象，`{"pass"|"ok": boolean, "feedback": string}`，声明了 `outputSchema` 时另带 `structured`）；开关与超时见 Config `semantic`（缺省都开，`timeoutMs` 120s）；**裁决 run 不可用**（失败 / 超时 / 输出不可解析）分流：`audit` **fail-closed 打回**（不假通过）、`entail` **跳过该门**（环境故障不烧重试预算）。**工具面收窄**（2026-10-04）：裁决 run 与 `subagent` 执行后端都带 **`toolFilter.deny` = 本引擎注册成功的全部 `task_*` 工具名**（宿主 `spawn` provider 支持 `toolFilter` → `ctx.tools.restrict`），子代理看不到 `task_*` 族、无法反向操作同一引擎与任务树；名单只在工具**注册成功**后收集（注册是 best-effort；一个都没成功 → 不收窄，避免宿主 `restrict()` 因未知工具名拒绝整次 run）；provider 未声明该能力位时**降级**（不收窄、照跑）并在 stderr 留一条告警（每插件实例一次）；带 `toolFilter` 的发起若失败（deny 名单里的名字在宿主全局注册表已失效——插件 remount / 卸载重注册的空窗）→ **去 filter 重试一次**并在告警留痕。
- **执行期复查**：命令**执行之前**各过一次 security-guard（① `executor` 的 `command` 后端、② mechanical 验收命令（含不在 `task_decompose` 登记表里的 `root.acceptance[].command`）、③ 隔离的 git 调用），`source` 形如 `task-engine{executor|acceptance|worktree} <id>`；命中即**不执行**，回执原文作为失败原因。取舍：**需 guard 挂载**（本包惰性读取、不进 `inject`），**未挂载或复查抛错 → fail-open 放行 + 每种失效模式只告警一次**；且「这条命令没复查过」不静默——命令缝落 `plan/frame-executed.guardSkipped`、验收缝落 `plan/acceptance-verdict.guardSkipped` 并随 `task_stop` 反馈透出。细节见 `docs/DESIGN.md`「目标与边界」的同名条。
- **引擎内核零 DSH 依赖**：`audit`（semantic 验收）与 `entail`（语义蕴含）在引擎侧仍是注入式 hook，插件形态（`apply`）已按上条接线；显式关掉（`semantic.audit=false` / `semantic.entail=false`）时分别回到 fail-closed 与跳过。父帧（无自身产出）的裁决证据由**子帧结论汇总**（§17.3）。
- fan-out 有界并发只是引擎侧 claim 语义；真实多执行器并行（agent-team DAG）属宿主编排层，引擎侧只保证「帧在途」的记账与上限。
- 单会话实例：一个引擎持有一棵任务树；快照持久化依赖 `snapshotPath`，未配置时跨进程恢复不可用。
- mechanical 验收命令由插件以 `/bin/sh -c` 执行，信任契约内命令、无额外沙箱（进程级沙箱由宿主策略承载）。
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
docs/           # DESIGN.md（架构与设计取舍）、BACKLOG.md（模块待办）、archived/（已关闭的过程记录与追踪文档）
```

架构与设计取舍见 `docs/DESIGN.md`；模块待办见 `docs/BACKLOG.md`；过程记录见 `docs/archived/`。

## 测试

```sh
npm run check   # 类型检查（tsc --noEmit）
npm run build   # 编译到 dist/
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'（136 例：engine / events / gate /
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
