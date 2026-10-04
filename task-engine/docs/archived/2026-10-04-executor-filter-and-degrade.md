# executor 工具面收窄 + `toolFilter` 失效兜底（同任务接取两条条目）

接取条目（`task-engine/docs/BACKLOG.md`）：**executor 子代理的工具面未收窄（可反向操作引擎 / 树）**、**裁决 run 的 `toolFilter` 失效兜底**。

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `task-engine/src/main.ts`（`ExecutorWireOptions` 两个新字段；`makeExecutor` 的 subagent 分支传 filter；`runChildOnce` 重试降级；apply 侧接线与共用 once 告警）
- `task-engine/tests/semantic.test.ts`（fake 支持 `failWithFilter` + `attempts`；新增 2 例）
- `task-engine/README.md`（语义验收一节的口径）
- `task-engine/docs/BACKLOG.md`（两条目进行中 → 收尾移除）
- 本追踪文档

## 调研（已核）

- 条目①：`makeExecutor`（模块级函数）里 `subagent` 分支调 `runChildOnce` 时**不传** `toolFilter`，故执行子代理与裁决子代理同为完整 agent，工具面里带 `task_decompose` / `task_implement` / `task_execute` / `task_stop` / `task_status`——执行方可反向操作任务树（自行 `task_stop` 别人的帧）。裁决 run 已于 2026-10-04 收窄，执行 run 未收窄。
- 作用域约束：`ownToolNames` 在 `apply()` 作用域里（注册完成后被赋值为 `registeredNames`），而 `makeExecutor` 是**模块级函数**且在其外调用 → 不能直接闭包，须经 `ExecutorWireOptions` 惰性传入（与 `resolve` 同理：执行期读，不在 apply 期快照）。
- 条目②：`runChildOnce` 的 `svc.start` 失败一律返回「发起失败」（可重试标记），但**带 filter** 的失败成因可能是 deny 名单里的名字在宿主**全局注册表**已失效（名字按本实例**注册成功**收集，宿主 `restrict()` 按全局校验）→ 加固把本次 run 直接打死，而这不是模型的问题。
- 能力位告警现状：`apply` 侧的 once 标志只覆盖裁决路径（跳过 `semanticEnabled` 判定），执行路径没有告警。

## 决策

1. **执行 run 与裁决 run 同口径收窄**：`makeExecutor` 的 `subagent` 分支复用 `judgeToolFilter(ownToolNames)` → `toolFilter.deny` = 本引擎注册成功的 `task_*` 族。理由：执行方的产物由调用方经 `task_implement` / `task_stop` 回写，它不需要 `task_*`；保留可见性等于把「反向操作引擎」的能力交给被测方（与裁决方同理）。
1. **工具名经惰性回调传入**（`ExecutorWireOptions.ownToolNames?: () => readonly string[]`），在 apply 侧接 `() => ownToolNames`：沿用既有「执行期读服务」的纪律，避免 apply 期快照拿到空数组。
1. **去 filter 重试一次**（条目②）：`runChildOnce` 把请求构造提成 `buildRequest(withFilter)`；带 filter 的 `start` 抛错 → 告警留痕 + **不带 filter 重试一次**；重试仍失败才返回失败。加固失败不该让语义门 / 执行步直接不可用（裁决 fail-closed 打回会让「名字失效」表现为「判定不通过」，语义上更糟）。
1. **降级告警合并为一个实例级 once**（`warnFilterDegradedOnce(who)`，裁决 / 执行共用）：两侧各自打印会重复；文案保留「未声明 toolFilter 能力位」关键词与「每插件实例一次」的既有承诺。
1. **不做的**：不改 `judgeToolFilter` 的名字与签名（它的纯函数测试与语义保持；仅其文档注释改为「裁决 run 与 executor run 共用」）；不改宿主的 `restrict()` 校验口径；不改 fail-closed 的验收语义。

## 实现记录（2026-10-04）

- `main.ts`：
  - `ExecutorWireOptions` += `ownToolNames?: () => readonly string[]`、`onFilterDegraded?: (who: string) => void`；
  - `makeExecutor` 的 `subagent` 分支：算 `judgeToolFilter(ownToolNames)`，能力位缺失时 `onFilterDegraded("执行子代理")`，请求带 `toolFilter`；
  - `runChildOnce`：请求构造提成 `buildRequest(withFilter)`；`useFilter = wantsFilter && filterSupported`；带 filter 失败 → 告警 + 去 filter 重试一次；
  - apply：新增 `warnFilterDegradedOnce(who)`（实例级 once），裁决路径改调它，并经 `makeExecutor({... ownToolNames: () => ownToolNames, onFilterDegraded: warnFilterDegradedOnce ...})` 接线。
- `tests/semantic.test.ts`：`fakeSubagents` 支持 `failWithFilter`（带 `toolFilter` 的发起抛错，模拟全局注册表失效）并记录 `attempts`；新增 2 例——① executor run 带 `deny` = 5 个 `task_*`（经 `bench` 真接线跑 `task_execute`）；② 带 filter 失败 → 两次尝试（首带 filter、重试不带）+ 成功 + 告警含「去 filter 重试一次」。
- `README.md`：`semantic` 段落口径改为「执行后端同口径收窄 + 带 filter 发起失败去 filter 重试一次并告警」。

## 测试与证据（2026-10-04）

- `task-engine`：`npm run check` ✓、`npm test` **120 例全绿**（既有 118 + 新增 2）。
- 反向验证（脚本式，未留痕）：`git stash push -- task-engine/src/main.ts` → 新用例**恰好两条变红**（executor 收窄 / 去 filter 重试），其余 118 绿；恢复后 120 例全绿。

## 子代理审阅

（决策后 + 收尾前**合并一轮**（两条条目同任务，机制同源）；审阅提出 2 条次要 + 3 条提示，均已处理）

### 审阅（2026-10-04）

只读审阅（120 例全绿）结论「需修」——两处已同批修：

1. **[次要] 重试前未判 `timedOut` / `signal.aborted`**（已修）：超时 / 取消后 `start` 若失败还会再发起一次 → 二次建会话（可能重复计费），且失败文案变成「去 filter 重试仍失败」而 `retryable: true`，掩盖既有的「超时不计重试」口径。→ 重试门槛加 `!timedOut && !controller.signal.aborted`，命中时按原样返回发起失败。
1. **[次要] 降级告警标签取先到者**（已修）：`onFilterDegraded` / `warnFilterDegradedOnce` 的标签原为「裁决子代理」/「执行子代理」，而共用一个 once 标志 → 先跑哪种 run 就打哪种标签，之后另一侧静默。→ 两处统一传中性的「裁决 / 执行子代理」。
1. **[提示] 重试是否重复副作用取决于宿主 `restrict()` 校验是否先于建会话**——本机无宿主源码未核验，**记为假设**（见下「已知边界」）。
1. **[提示] 缺「执行侧降级」用例** → 已补（`bench` 挂 subagent executor + 无能力位 provider；合并捕获 stderr，断言不带 filter 照跑 + 只打一条告警——同时验证两侧共用 once）。
1. **[提示] diff 混入并行任务（md-logic）** → 提交按层拆分（本任务只提交 `task-engine/` 下 5 个文件）。

已核无问题：deny 只取 `ownToolNames` 里 `task_` 前缀（不误伤其它插件工具名）；执行子代理确实不需要 `task_*`（prompt 未指示其调用，产物由调用方经 `task_implement` / `task_stop` 回写）；`buildRequest(false)` 与正常请求除 `toolFilter` 外逐字段一致；`controller` / `timer` 复用使重试后的 run 仍受超时中止；`README.md` 口径与代码一致。

### 已知边界（本任务记录）

- **重试的副作用假设**：`start` 抛错时是否已经建了子会话 / 已计费，取决于宿主 `restrict()` 校验发生在建会话之前（`dsh-subagent` 的 `applyChildComposition` 在 spawn 前调用）——本机只核到能力位与调用面，未核宿主源码顺序；若宿主改为「先建会话后 restrict」，重试会多一次空转会话（已在守卫里排除超时 / 取消路径，其余场景影响面为一次额外 start 尝试）。

## 收尾

- 两条条目从 `task-engine/docs/BACKLOG.md` 移除（该表随后为空，按模块惯例置「（当前无未完成项）」）。
- 本追踪文档移入 `task-engine/docs/archived/`；本次变更合并为一次提交（`src/main.ts` + 测试 + `README.md` + BACKLOG + 归档文档），提交见 git 历史。
- 复跑记录：`task-engine` `npm run check` ✓、`npm test` **121 例全绿**（既有 118 + 新增 3）；根 `npm run check` / `npm run build` 见收尾复跑。
