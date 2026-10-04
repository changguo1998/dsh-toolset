# 裁决子代理的工具面收窄（`toolFilter` 剥掉 `task_*`）（接取条目：`task-engine/docs/BACKLOG.md`「裁决子代理可见 `task_*` 工具」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `task-engine/src/main.ts`（`runChildOnce` 支持 `toolFilter` + 能力位判定；`judgeToolFilter` 助手；audit / entail run 传收窄；`ownToolNames` 由 `createTools` 产物回填）
- `task-engine/tests/semantic.test.ts`（fake provider 能力位与 `toolFilter` 记录 + 新用例）
- `task-engine/README.md`（语义验收接线条目补「工具面收窄」口径）
- `task-engine/docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研（已核，宿主机码）

- 问题：audit / entail 的裁决子代理与执行子代理同为**完整 agent**，工具面里带着 `task_decompose` / `task_implement` / `task_execute` / `task_stop` / `task_status`，prompt 只说「不要调用工具」——理论上可重入同一引擎与任务树（`task_stop` / `task_decompose` 反向操作）。
- 宿主面（`@deepseek-ai/dsh-subagent`）：`applyChildComposition` 在子代理上下文执行 `childCtx.tools.restrict(composition.toolFilter)`；`toolFilter` 形如 `{allow?, deny?}`（`TOOL_FILTER_KEYS = {allow, deny}`，二者至少一个非空，否则 `restrict({})` 抛「no-op」）；请求面 `SubagentStartRequest.toolFilter` 经 descriptor 传到 composition。
- provider 能力位：`dsh-subagent-spawn-in-process` 声明 `capabilities.toolFilter: true`（本引擎用的正是 `spawn`）；`dsh-subagent` 自带的一个 provider 为 `toolFilter: false` → 能力位必须判。
- `restrict()` 还会对**未知全局工具名**抛错（"names unknown global tool"）——故 deny 名单必须取自本引擎**实际注册**的工具名，不能手写。

## 决策

1. **按实际注册成功的名单**：`ownToolNames` 在 `toolsSvc.register(...)` **成功之后**逐个收集（`judgeToolFilter()` 只取 `task_` 前缀去重后作为 `deny`）——手写名单会与工具族漂移，写错名字会被宿主 `restrict()` 拒掉整次裁决 run，而注册是 best-effort（单个失败只 warn），故名字必须来自「真的注册上了」的那批（详见「子代理审阅 §决策后」第 1 条）。
1. **能力位缺失时降级（不失败）**：裁决 run 的本质是「读证据判对错」，收窄工具面是**加固**而非正确性前提；因缺能力位而 fail-closed 会让语义门在旧宿主上直接不可用。降级路径 + stderr 告警留痕（`warn` 直写 stderr，与既有告警同路）。
1. **范围只到裁决方**：`subagent` executor 子代理的工具面**不动**（它本来就该干活；本次条目只提裁决 run）。该边界写进 README。
1. **拒绝 `allow` 白名单写法**：用 `deny` 而非 `allow`——裁决方仍需要 `read` / `grep` / `bash`（自行取证）等宿主工具，白名单会随宿主工具面变化而失效。

## 实现记录（2026-10-04）

- `SubagentsLike.getProvider().capabilities` 增 `toolFilter?: boolean`（类型面）。
- 新增导出助手 `judgeToolFilter(toolNames)`：`task_` 前缀去重 → `{deny}`；空 → `undefined`（不过滤）。
- `runChildOnce`：`req.toolFilter?` 新增；`wantsFilter`（allow / deny 任一非空）与 `caps?.toolFilter === true` 判定，仅支持时把 `toolFilter` 放进 `svc.start` 请求（**不在此告警**，见下）。
- `semanticHooksFor`：由 `judgeToolFilter(ownToolNames)` 构造，audit / entail 两个 run 都带上；能力位缺失时在此打**实例级 once** 降级告警（`toolFilterDegradeWarned`）。
- `ownToolNames` 在 `toolsSvc.register(...)` **成功之后**逐个收集（`registeredNames`）——注册是 best-effort，一个都没成功 → 空名单 → 不收窄（宿主 `restrict()` 对未知工具名抛错，会把整次裁决 run 打成发起失败）。

## 测试与证据（2026-10-04）

- `task-engine`：`npm run check` ✓、`npm test` **117 例全绿**（既有 112 + 新增 5）。
- 新增用例（`tests/semantic.test.ts` 新 describe「裁决 run 的工具面收窄」）：① provider 声明 `toolFilter` → entail 与 audit 两个 run 的 `toolFilter` 均为 `{deny: [五个 task_* 名]}`；② provider 未声明 → 裁决照跑、请求**不带** `toolFilter`、stderr 有「toolFilter 能力位」告警（`captureStderr` 捕获）；③ `judgeToolFilter` 纯函数（空名单 / 非 `task_` 名 → `undefined`；重复名去重）；④ 能力位显式 `false` → 与缺省同路（不收窄、裁决照跑）；⑤ `runChildOnce` 直调（executor 路径不传）→ 请求不带 `toolFilter`。
- 反向验证：把请求里的 `toolFilter` 透传改恒假 → 用例①红、其余全绿；恢复后 117 全绿（脚本式验证，未留痕）。

## 子代理审阅

（决策后 / 收尾前各一轮，记录见下）

### 决策后（2026-10-04）

只读审阅（`task-engine` 全绿 + 宿主机码对照）。结论「需改」，一条实施性 + 三条文档 / 覆盖：

1. **[重要] deny 名单与「注册成功」脱节**：`ownToolNames` 取的是 `createTools` **产物**，而注册是 best-effort（单个失败只 warn、`ctx.tools` 缺失时整段跳过）——宿主 `restrict()` 对**未知全局工具名**抛错，会把整次裁决 run 打成「发起失败」→ audit / entail 全量 fail-closed。→ 改为在 `toolsSvc.register(...)` **成功之后**逐个收集（`registeredNames`），一个都没成功 → 空名单 → 不收窄（`runChildOnce` 侧不放 `toolFilter`）。
1. **[次要] README 渲染断裂**：行内代码里嵌反引号且带 `\_` / `\*` 转义。→ 改写为「`toolFilter.deny` = 本引擎注册成功的全部 `task_*` 工具名」。
1. **[次要] 降级告警刷屏**：原实现每次裁决 run 打一条（每任务 ≥ 2 条）。→ 改为**每插件实例一次**（`toolFilterDegradeWarned` 实例级标志在 `semanticHooksFor` 内判定；`runChildOnce` 只做能力位判定、不再告警）。
1. **[次要] executor 范围未登记**：executor 子代理同样能反向操作，原方案只写进 README 边界。→ 按流程另开条目：`task-engine/docs/BACKLOG.md`「executor 子代理的工具面未收窄（可反向操作引擎 / 树）」。
1. **[提示] 覆盖缺口**：缺「executor 路径不带 `toolFilter`」与「能力位显式 `false`」两条断言。→ 已补两例（`runChildOnce` 直调断言请求无 `toolFilter`；`toolFilter: false` 与缺省同路）。

已核无问题：`SubagentStartRequest.toolFilter?: ToolRestriction` 与能力位声明（宿主 `types.d.ts`）→ 判定与传参合法；不会传 `{deny: []}`；`ownToolNames` 的闭包读取时机在两条早退分支（引擎初始化失败 / `ctx.tools` 缺失）下都不会误收窄；三条用例可反向失败（硬名单 `deepEqual` / 无 `toolFilter` + 告警断言）。

### 收尾前（2026-10-04）

只读审阅（117 例全绿 + tsc）。结论「可提交」，四点（均已处理）：

1. **[次要] 决策口径与实现不一致**：追踪文档「决策」仍写「名单由 `createTools` 产物回填」→ 已改为「注册成功后逐个收集」。
1. **[次要] 两侧语义门都关掉时仍告警属误报** → `semanticHooksFor` 的告警判定加 `semantic.audit !== false || semantic.entail !== false`。
1. **[提示] `toolFilter` 失效兜底**（名字按本实例注册成功收集、宿主按全局注册表校验 → 名字失效会让裁决 run 发起失败）→ 按流程另开条目：`task-engine/docs/BACKLOG.md`「裁决 run 的 `toolFilter` 失效兜底」。
1. **[提示] 覆盖缺口**：缺「注册失败的名字不进入名单」用例 → 已补（`registerFailsFor` 选项 + 断言 deny 只含注册成功的四个名字）。

已核无问题：`register` 成功后才收集（同步 void、`toDshTool` 保名、空名单不传 `toolFilter`）；README 行内代码反引号成对、无残留转义符；实例级 once 告警与 `runChildOnce` 走同一 `resolve` 闭包与 `getProvider("spawn")`，无漏报；BACKLOG 原条目已移除、新条目五列格式正确；diff 无越界。

## 收尾

- 条目从 `task-engine/docs/BACKLOG.md` 移除；同表登记两条后续条目（executor 工具面未收窄 / `toolFilter` 失效兜底）。
- 本追踪文档移入 `task-engine/docs/archived/`；本次变更合并为一次提交（`main.ts` + 测试 + README + BACKLOG + 归档文档），提交见 git 历史。
- 复跑记录：`npm run check`（根，20 包）✓、`task-engine` `npm test` **118 例** ✓（收尾前修复后）。
