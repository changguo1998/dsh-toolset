# @dsh-toolset/dsh-task-engine

DSH（DeepSeek Harness）任务树引擎：Frame 状态机、decompose/implement/stop/status 工具族、
机械+语义双重门禁与 RET 验收路由。架构对齐 `docs/AGENT-ARCHITECTURE-ANALOGY.md` §10/§13-§18 与
`DSH-CTX-API.md`，契约参考 `docs/DEVELOPMENT-BACKLOG.md` #1-#5、#13（P0/P1）。

## 范围

### 第一迭代（首版最小闭环）

- **引擎**：Frame 状态机、`decompose`/`pop`、join 续体、就绪池、bounded retry；
- **事件溯源**：`plan/node-expanded` 等自定义事件 + 内存树 + 周期快照（配置 `snapshotPath` 时每次事件后近实时写盘）；
- **模型侧工具族**：`task_decompose` / `task_implement` / `task_stop` / `task_status` + 嵌套任务列表（`parent_id` + `order`）；
- **机械门禁**：粒度四规则（越级 / 过粗 / 过细 / 数量）+ coverage 完备性映射，拒绝带反馈打回；
- **RET 验收路由**：mechanical（命令退出码）+ human（approval 链，fail-closed）两级。

### 第二迭代（DSH-CTX-API 0.1.5-rc.2 对齐）

- **fan-out 多执行器**（BACKLOG #13）：就绪池增加 `maxConcurrent`（默认 4）有界并发——`nextReady()`
  在 active 帧数达上限时不弹栈；`activeCount()` 统计在途帧；join 续体语义不变（全部子任务 done 后父帧才完成）。
  宿主多 worker 编排可用 `ctx.subagents.start()` / agent-team DAG，引擎侧只提供有界 claim 语义；
- **semantic 级验收**：独立 audit run（注入式 `audit` hook，零 DSH 依赖）+ `outputSchema` →
  `structured` 裁决；缺 hook 或声明了 `outputSchema` 但无 `structured` 一律 fail-closed；裁决进 `plan/acceptance-verdict` 事件流（审计证据链）；
- **step 级裁决**（BACKLOG #5）：`decompose`/`stop` 结果新增 `accepted` / `next` 字段
  （打回 `next` 指向本帧重做；终态 `next=null`），并落 `plan/step-verdict` 事件（§11.2）；
- **语义蕴含第二道门**（§17.2）：decompose 在机械门禁通过后再跑注入式 `entail` hook
  （`∧Qᵢ ⟹ Q_parent` 的独立语义运行）；缺 hook 时只做机械门禁（结构蕴含跳过）；
  子任务 `deps` 前置传递（只允许引用前序兄弟，自引用/前向引用/未知 id 打回）；
- **turn/end reason 对齐**：approval 失败/无应答/抛错一律 fail-closed（拒绝）；
  中止路径新增 `plan/frame-interrupted` 事件——恢复时在途 active 帧回收为 pending
  （**不**增重试计数，区别于打回），可重新 claim 继续执行。

## 命令（在 `task-engine/` 目录下执行）

```sh
npm run check   # 类型检查（tsc --noEmit）
npm run build   # 编译到 dist/
npm run test    # 运行 tests/*.test.ts（node --test）
npm run demo    # 构建并运行 mock demo（无 DSH 依赖）：全链路 + 门禁打回 + mechanical/human/semantic 级验收 + fan-out/step 裁决/蕴含门/abort 恢复，退出码 0/1
```

## 目录结构

```
task-engine/
  src/
    types.ts      # Frame / Acceptance / PlanEvent / TaskTree / StepVerdict 领域类型
    events.ts     # 事件溯源：materialize 折叠、嵌套视图、快照/恢复
    gate.ts       # 分解门禁：粒度四规则 + coverage + deps（机械部分），GateConfig 含 maxConcurrent
    acceptance.ts # RET 裁决：mechanical / human / semantic（audit hook + outputSchema）
    engine.ts     # TaskStack：decompose(async, 双门禁)/implement/stop、有界就绪池、join、bounded retry、resume 回收
    tools.ts      # 模型侧工具族（纯数据 + 处理器，零 DSH 依赖；accepted/next 透出）
    main.ts       # cordis 插件入口（零运行时依赖的结构面适配；maxConcurrent 配置）
  index.ts      # 包入口：re-export src/main（编译产出 dist/index.js，package.json main）
  demo/main.ts    # mock demo（脚本化模型，自断言；演示 1-12 覆盖两迭代）
  tests/          # node:test 单元测试（events / gate / engine，34 例）
```

## 设计要点

- **树 = 栈 = todo 的一面三体**（§14）：树是本体，栈是 DFS 遍历器（子任务逆序压栈、先序出栈 = 就绪池），todo 是嵌套序列化视图。fan-out 下就绪池变为有界多 worker 共享的 claim 队列。
- **事件溯源**（§15）：所有变更 append 事件流，树由 `materialize` 折叠重建；快照 = 事件流 JSON，`resumeFromSnapshot` 可恢复（含 abort 后在途帧回收）。
- **门禁双重校验**（§17.2）：机械（粒度四规则 + coverage + deps）通过后，若配置 `entail` hook 再跑语义蕴含；两道任一拒绝都带反馈打回。
- **验收路由**（§17.4）：mechanical → `/bin/sh -c` 退出码；human → `approval` 链 fail-closed；semantic → 独立 audit run（`audit` hook）+ `outputSchema` 结构化裁决；全部通过才 `completeUp` 并向上 join（合取复核父 Q，§17.3）。
- **打回重试**：门禁拒绝 / 验收失败统一记 `retryCount`，达 `maxRetries`（默认 3）置 `failed`；打回帧放回就绪池顶部，带反馈供模型重试。
- **step 级裁决**（§11.2）：`decompose`/`stop` 均返回 `{ ok, accepted, next, feedback? }` 并落 `plan/step-verdict` 事件；`next` 由 `peekNextReady()` 给出（不消费候选）。
- **审批 turn-enclosed**：human 级验收只在工具 `execute`（open turn 内）发起 `ctx.approval.request`，满足 DSH 审计对约束；失败/无人应答/抛错一律 fail-closed。
- **abort 语义**（turn/end reason=aborted）：宿主中止 turn 后进程可终止；重启后 `resumeFromSnapshot` 为每个在途 active 帧补记 `plan/frame-interrupted`，回收为 pending、不增 `retryCount`，执行器可无缝继续（依赖宿主配置 `snapshotPath` 持久化事件流，未配置时纯内存运行）。

## profile 挂载（部署到 fff）

在 `~/.dsh/profiles/fff/`：

1. `package.json` 的 `dependencies` 增加 `"@dsh-toolset/dsh-task-engine": "link:<本包绝对路径>"`，
   `dsh.profile.bundles` 增加 `"@dsh-toolset/dsh-task-engine"`；
1. `cordis.patch.yml` 追加：

```yaml
- id: dsh-task-engine
  name: '@dsh-toolset/dsh-task-engine'
```

1. 构建产物经 symlink 实时可见，直接 `dsh --profile fff` 加载（无需 `pnpm install`；勿用 `file:` 依赖）。

## 已知边界（v2）

- 引擎内核零 DSH 依赖：semantic 验收与语义蕴含均为**注入式 hook**（`audit`/`entail`），真实链路（`ctx.subagents` fork audit run / 语义模型判定）由宿主侧接线；缺 hook 时 semantic 验收与 entail 各自降级（fail-closed / 跳过）。
- fan-out 有界并发是引擎侧 claim 语义；真实多执行器并行（agent-team DAG）属宿主编排层，本迭代不接线。
- 单会话实例：一个引擎持有一棵任务树，服务于当前会话。
- 快照持久化依赖宿主配置 `snapshotPath`（配置后每次变更近实时写盘 + unload 时最终写）；当前 profile 未配置，引擎纯内存运行，跨进程恢复需宿主侧接线。
- mechanical 验收命令由插件以 `/bin/sh -c` 执行：信任契约内命令，无额外沙箱（进程级沙箱由宿主策略承载）。
- `ctx.tools` / `ctx.approval` 缺失时降级告警而非抛错，保证 bundle 加载不崩。
