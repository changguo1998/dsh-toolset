# @dsh-toolset/dsh-task-engine

DSH（DeepSeek Harness）任务树引擎：Frame 状态机、decompose/implement/stop/status 工具族、
机械门禁与 RET 验收路由。架构对齐 `docs/AGENT-ARCHITECTURE-ANALOGY.md` §10/§13-§18 与
`DSH-CTX-API.md`，契约参考 `docs/DEVELOPMENT-BACKLOG.md` #1-#4（P0）。

## 首版范围（第一迭代）

- **引擎**：Frame 状态机、`decompose`/`pop`、join 续体、就绪池（**单执行器**）、bounded retry；
- **事件溯源**：`plan/node-expanded` 等自定义事件 + 内存树 + 周期快照；
- **模型侧工具族**：`task_decompose` / `task_implement` / `task_stop` / `task_status` + 嵌套任务列表（`parent_id` + `order`）；
- **机械门禁**：粒度四规则（越级 / 过粗 / 过细 / 数量）+ coverage 完备性映射，拒绝带反馈打回；
- **RET 验收路由**：mechanical（命令退出码）+ human（approval 链，fail-closed）两级；semantic 级在第二迭代实现，当前 fail-closed 打回；
- **第二迭代不做**：fan-out（多执行器 + agent-team DAG）、semantic 级验收（独立 audit run + outputSchema）、step 级 `accepted`/`next` 字段。

## 命令（在 `task-engine/` 目录下执行）

```sh
npm run check   # 类型检查（tsc --noEmit）
npm run build   # 编译到 dist/
npm run test    # 运行 tests/*.test.ts（node --test）
npm run demo    # 构建并运行 mock demo（无 DSH 依赖）：decompose→implement→stop 全链路 + 门禁打回 + mechanical/human 级验收，退出码 0/1
```

## 目录结构

```
task-engine/
  src/
    types.ts      # Frame / Acceptance / PlanEvent / TaskTree 领域类型
    events.ts     # 事件溯源：materialize 折叠、嵌套视图、快照/恢复
    gate.ts       # 分解门禁：粒度四规则 + coverage（机械部分）
    acceptance.ts # RET 裁决：mechanical / human / semantic(fail-closed)
    engine.ts     # TaskStack：decompose/implement/stop、就绪池、join、bounded retry、resume
    tools.ts      # 模型侧工具族（纯数据 + 处理器，零 DSH 依赖）
    main.ts       # cordis 插件入口（零运行时依赖的结构面适配）
  index.ts      # 包入口：re-export src/main（编译产出 dist/index.js，package.json main）
  demo/main.ts    # mock demo（脚本化模型，自断言）
  tests/          # node:test 单元测试（events / gate / engine）
```

## 设计要点

- **树 = 栈 = todo 的一面三体**（§14）：树是本体，栈是单线程 DFS 遍历器（子任务逆序压栈、先序出栈 = 就绪池），todo 是嵌套序列化视图。
- **事件溯源**（§15）：所有变更 append 事件流，树由 `materialize` 折叠重建；快照 = 事件流 JSON，`resumeFromSnapshot` 可恢复。
- **门禁双重校验**（§17.2）：粒度四规则 + coverage 完备性（机械部分）；语义蕴含属第二迭代。
- **验收路由**（§17.4）：mechanical → `/bin/sh -c` 退出码；human → `approval` 链 fail-closed；全部通过才 `completeUp` 并向上 join（合取复核父 Q，§17.3）。
- **打回重试**：门禁拒绝 / 验收失败统一记 `retryCount`，达 `maxRetries`（默认 3）置 `failed`；打回帧放回就绪池顶部，带反馈供模型重试。
- **审批 turn-enclosed**：human 级验收只在工具 `execute`（open turn 内）发起 `ctx.approval.request`，满足 DSH 审计对约束；失败/无人应答一律 fail-closed。

## profile 挂载（部署到 dsh-toolset-tui）

在 `~/.dsh/profiles/dsh-toolset-tui/`：

1. `package.json` 的 `dependencies` 增加 `"@dsh-toolset/dsh-task-engine": "link:<本包绝对路径>"`，
   `dsh.profile.bundles` 增加 `"@dsh-toolset/dsh-task-engine"`；
1. `cordis.patch.yml` 追加：

```yaml
- id: dsh-task-engine
  name: '@dsh-toolset/dsh-task-engine'
```

1. profile 目录执行 `pnpm install`（link 依赖）后 `dsh --profile dsh-toolset-tui` 加载。

## 已知边界（v1）

- 单执行器、单会话实例：一个引擎持有一棵任务树，服务于当前会话；多执行器 fan-out 属第二迭代。
- semantic 级验收未实现（第二迭代），遇到即 fail-closed 打回。
- mechanical 验收命令由插件以 `/bin/sh -c` 执行：信任契约内命令，无额外沙箱（进程级沙箱由宿主策略承载）。
- `ctx.tools` / `ctx.approval` 缺失时降级告警而非抛错，保证 bundle 加载不崩。
