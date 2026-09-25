# @dsh-toolset/task-engine

DSH（DeepSeek Harness）任务树引擎：Frame 状态机 + decompose / implement / stop / status 工具族，分解双重门禁与 RET 验收（mechanical / semantic / human）路由。

## 能力

模型侧工具（`inject: ["tools"]`）：

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `task_decompose` | `parent_id`、`children`（`{id, title, spec, acceptance, need_decompose, coverage, deps}`） | `{ok, accepted, next, feedback?}` |
| `task_implement` | `task_id`、`result` | `{ok, feedback?}` |
| `task_stop` | `task_id` | `{ok, accepted, next, feedback?}` |
| `task_status` | — | `{ok, tree}`（嵌套任务列表，`parent_id` + `order`，先序） |

- **分解双重门禁**：先跑机械门禁——粒度四规则（越级 / 过粗 / 过细 / 数量）+ coverage 完备性（父每条验收须有本次子任务覆盖）+ `deps` 前置传递（只允许引用前序兄弟，自引用/前向引用/未知 id 拒绝）；通过后若配置 `entail` hook，再跑语义蕴含（合取是否蕴含父契约）。任一拒绝都带反馈打回并记 `retryCount`，达 `maxRetries` 置 `failed`。
- **RET 验收路由**：mechanical → `/bin/sh -c` 退出码 0；human → `ctx.approval.request`（`allowed-once` 视为通过，拒绝 / 无人应答 / 抛错一律 fail-closed）；semantic → 注入式 `audit` hook 的独立 audit run（缺 hook，或声明了 `outputSchema` 却无 `structured`，均 fail-closed 打回）。
- **完成与 join**：一个帧的全部验收通过才弹栈，并向上 join（全部子任务 done 后复核父契约）。
- **事件溯源**：所有变更 append 事件流（`plan/root-created`、`plan/node-expanded`、`plan/frame-activated`、`plan/frame-implemented`、`plan/acceptance-verdict`、`plan/step-verdict`、`plan/frame-rejected`、`plan/frame-completed`、`plan/frame-interrupted`、`plan/frame-failed`），树由事件流折叠重建；配置 `snapshotPath` 后每次事件串行写盘（unload 时再写一次），`resumeFromSnapshot` 可恢复。
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
  "need_decompose": false, "coverage": { "r1": ["c1"] } }] }
{ "task_id": "c1", "result": "实现产出" }
{ "task_id": "c1" }
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

- 引擎内核零 DSH 依赖：`audit`（semantic 验收）与 `entail`（语义蕴含）都是**注入式 hook**，真实链路（`ctx.subagents` fork audit run / 语义模型判定）由宿主侧接线；缺 hook 时分别降级为 fail-closed 与跳过。
- fan-out 有界并发只是引擎侧 claim 语义；真实多执行器并行（agent-team DAG）属宿主编排层。
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
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'（42 例：engine / events / gate / query）
npm run demo    # npm run build && node dist/demo/main.js；脚本化模型跑步骤 0-7 + 演示 8-12，
                # 覆盖全链路（门禁打回→implement→stop→join）、fan-out 有界并发、
                # 语义验收 audit、step 裁决、语义蕴含门、abort 恢复；输出 DEMO_OK / DEMO_FAIL，退出码 0/1
```

架构对照见 `docs/host/AGENT-ARCHITECTURE-ANALOGY.md`。
