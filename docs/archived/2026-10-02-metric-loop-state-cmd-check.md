# `metric_loop` 状态文件命令复查（接取条目：`docs/BACKLOG.md`「`metric_loop` 状态文件命令复查」）

状态：实现　　开启：2026-10-02　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

补上 `security-guard` 命令黑名单层的残余旁路：`metric_loop{action:"tick"}` 执行的 `measureCmd`
取自**状态文件**（`<stateDir>/metric-loop-<id>.json` 的 `spec.measureCmd`），不在任何工具入参里，
故 guard 的 `tools/pre-execute` 判定看不到它。目标是在**命令真正被交给 `/bin/sh -c` 之前**补一个
检查点：命中命令黑名单即拒绝执行，并在工具结果里透出可读回执；未挂 guard 时行为与现状一致。

## 调研

### 已确证证据（父任务/子代理实测，本次复核）

- guard 的插件命令登记表只按**工具入参**提取命令文本：
  `PLUGIN_COMMAND_TOOLS.metric_loop = { commandKeys: ["measureCmd"] }`
  （`security-guard/src/index.ts:218`）——`tick` 入参只有 `action/id/wake/tokensUsed`，
  取不到命令文本 → 走「登记工具但无命令参数」分支 → 放行。
- `tick` 的执行链：`MetricLoopController.tick` → `loadState()` → `runRound()` →
  `this.measure(String(s.spec.measureCmd))` → `runMeasureCommand` → `execFile("/bin/sh", ["-c", cmd])`
  （`metric-loop/src/index.ts:152,229-233`、`metric-loop/src/measure.ts:43-49`）。
- **本次复核（临时脚本，已删除）**：临时目录写入状态文件（`measureCmd` 为「写探针文件 + echo 42」），
  用真实 `/bin/sh -c` 跑 `tick`：`GuardEngine.inspect("metric_loop", {action:"tick",id,wake})` 返回
  `null`（ALLOW），而探针文件确实被创建、`round=1/value=42` —— 旁路成立。
- 既有文档已把该边界记为已知限制：`security-guard/README.md`「边界与限制」条目
  「**命令来自状态文件时不经过本层**（已知边界）」，并在 `docs/archived/2026-10-02-guard-command-layer.md`
  记为 P1 残余 + 项目级新条目（即本条目）。

### 宿主服务面复核

- `security-guard` 已 `provide(["guard"])`，服务面当前只有 `recent()` / `policy()`（`src/index.ts:64,639-650`）。
- `metric-loop` 的 `apply` 目前只用 `ctx.tools` 与 `ctx.provide`；同仓 `task-engine`
  已有「宿主服务**惰性**解析」的既有模式（`task-engine/src/main.ts:921-928,983-986`：
  apply 期 `ctx.get` 常为 undefined，到工具执行期才可读）。
- `TUI/src/main.ts:568-570` 真机可用 `ctx.get('guard')` 读 security-guard 的服务面（BACKLOG C3 已验收），
  说明「跨 bundle 条目、执行期读插件服务」这条路径在本 profile 里是通的。

## 决策

### 候选对比

| 候选 | 改动面 | 误伤风险 | 可验证性 | 跨包依赖 |
| --- | --- | --- | --- | --- |
| **A. guard 在 `metric_loop{tick}` 的 pre-execute 里读状态文件复查** | `security-guard/src/index.ts` 新增「tick → 按 id 拼路径 → 读 JSON → 取 `spec.measureCmd` → 过命令层」，需复制 metric-loop 的存储/配置语义 | 中：guard 要自行复制状态目录语义（默认 `~/.dsh/metric-loop`、`METRIC_LOOP_STATE_DIR`、插件 `config.stateDir`、id 归一化、版本/形状处理）；任一处不一致 → 漏拦（读不到文件）或误拦（读到别的文件）；并把文件 I/O 引入 guard 的纯判定层 | 可测但脆：guard 测试要构造 metric-loop 的私有文件格式 | **反向硬耦合**：guard 依赖 metric-loop 的私有存储格式与配置面 |
| **B. metric-loop 在 tick 执行前经可选服务复查（guard 提供检查 API）** | guard：抽出/新增 `inspectCommand(command, source)` + 服务面暴露（≈25 行，含一处小重构）；metric-loop：控制器新增可选复查缝 + `runRound` 执行前复查 + `apply` 惰性 `ctx.get('guard')`（≈50 行） | 低-中：命令口径与 `bash` 工具**完全同口径**（含 `allowPatterns`）；`echo "# sudo"` 这类文本命中仍会拦（guard 既有「宁可误拦」口径，可用 `allowPatterns` 放行）；不改变任何既有判定 | 强：guard 侧纯函数可单测；metric-loop 侧注入假复查器即可断言「拦 / 放 / 未配置」三态，apply 级用假 ctx 验证接线 | **无硬依赖**：不进 `inject`，不 import 对方代码；契约面是 duck-typed 的 `inspectCommand(command, source?) → string \| null` |
| **B′. B 的变体：只把现有 `inspect` 挂上服务面，metric-loop 调 `inspect("bash", {command})`** | guard 3 行 | 同上 | 同上 | 无硬依赖，但把 guard 的「shell 工具名」语义隐式变成跨包契约 |
| **C. metric-loop 自建最小校验/告警** | metric-loop 内复制一份危险命令正则/白名单 | 高（漏拦或误伤）：双份规则必然漂移，guard 的用户层追加规则与 `allowPatterns` 都不生效 | 可测，但测的是副本而非真实策略 | 无 |

### 选定：B（guard 提供 `inspectCommand` 检查 API，metric-loop 执行前复查）

理由：

1. **检查点落在真实执行前**：命令文本在内存里、就在 `execFile` 之前判定，与状态文件从哪来、
   路径/格式如何变化无关（不需要复制 metric-loop 的存储知识）。
1. **单一事实来源**：复用 guard 的命令黑名单层 + 命令内路径的敏感文件层，用户层规则/放行模式一律生效。
1. **不引入硬依赖**：metric-loop 不把 `guard` 加进 `inject`，只做可选的结构化查询；
   未挂 guard（standalone / 其它 profile）时行为与现状一致（fail-open）。
1. **可测**：guard 侧 `inspectCommand` 是纯同步函数；metric-loop 侧控制器暴露可选复查缝，
   单测可注入假复查器覆盖「拦/放/缺」三态；`apply` 接线用假 ctx（`get('guard')`）验证。

不选 B′：复用 `inspect("bash", …)` 改动更小，但回执与 `recent()` 审计会把来源记成 `bash`
——模型会误以为是一次 shell 工具调用被拦，`/guard` 面板的审计也不再准确；
`inspectCommand(command, source)` 多约 15 行换来来源标注、审计准确与显式契约。故按 B 实现。

### 明确「不做」

- 不让 guard 读 metric-loop 状态文件（候选 A）；不在 metric-loop 复制黑名单（候选 C）。
- 不改 `tick` 的 cadence / defer / stop 语义与状态结构：拦截时**不推进轮次、不写状态文件、不自动 stop**
  （避免一次误拦把循环永久停掉）；`status` / `stop` 不受影响。
- 不做 guard 服务缺失时的硬失败（fail-open + 一次性告警），不把 `guard` 写进 `inject`。
- 不覆盖 task-engine 帧契约类旁路（`children[].executor.command` 的执行期、`root.acceptance[].command`
  等，属 `security-guard/README.md` 已记的另条边界）。
- 不改 `security-guard` 的既有判定语义与既有回执格式（`inspectCommand` 只在既有回执前加一行来源标注）。
- 不改 README / BACKLOG / 其它追踪文档（由用户收尾，见「待办」）。

### 残余风险（明示）

- guard 未挂载、或未来服务名/签名变化 → tick 不复查（fail-open，告警一次）。
- 复查的文本与执行用的是**同一个内存字符串**（`loadState` 后不再读文件），无检查/执行之间的 TOCTOU 窗口；
  但「状态文件被外部进程改写」本身不在本插件职责内。
- `apply` 之外的驱动方式（测试/脚本直接 `createController()`）默认不带复查器——与现状一致。
- 真机端到端（dsh 会话里执行期 `ctx.get('guard')` 可读）本次未跑：证据是 TUI 的同款读取已真机验收，
  仍有环境差异风险（记入「待办/未验证」）。

## 规划

### 计划改动文件清单

- `security-guard/src/index.ts`：`#decide` 尾部抽为 `#decideCollected`；新增
  `GuardEngine.inspectCommand(command, source?)`；新增 `GuardService` 接口并在 `apply` 的
  `provide("guard")` 上暴露 `inspectCommand`。
- `metric-loop/src/index.ts`：新增 `CommandChecker` 类型 + `readService` / `makeCommandGuard`；
  `MetricLoopController` 构造项新增 `commandGuard?`；`runRound` 执行测量前复查（带来源标注）；
  `apply` 惰性接线 `ctx.get('guard')`。
- `metric-loop/src/persist.ts`：`loadState` 补 `spec` 段与 `spec.measureCmd` 的形状校验
  （形状异常给清晰错误，而不是运行期抛 `trim is not a function` 这类隐蔽错）。
- `security-guard/tests/guard.test.ts`：`inspectCommand` 语义（命中/放行/allowPatterns/关层/敏感路径/非字符串防御）
  - 服务面暴露。
- `metric-loop/tests/controller.test.ts`：tick 前复查三态 + apply 接线 + 形状异常。
- `metric-loop/tests/persist.test.ts`：形状校验两例。
- `docs/implementation/2026-10-02-metric-loop-state-cmd-check.md`（本文件）。

### 不做的文件

`README.md` / `README.zh.md` / `docs/BACKLOG.md` / 其它包的源码与测试（README 与本条目的收尾由用户处理）。

## 实现记录

（见下方「测试与证据」；按时间追加关键命令与结果。）

## 测试与证据

待补。

## 待办

- `security-guard/README.md`「边界与限制」的「命令来自状态文件时不经过本层」条目需改为
  「已在 tick 执行前复查（需 security-guard 挂载）」；`metric-loop/README.md`「边界与限制」可补一句复查说明。
- 项目级 `docs/BACKLOG.md` 本条目标「完成」并清理（由用户收尾）。
- 真机验证（可选）：`dsh --profile fff` 下把状态文件改成命中黑名单的命令 → `metric_loop tick`
  应返回 `ok:false` 且回执含 `[security-guard]`；本次未跑（无 headless 凭据环境）。

## 收尾记录（2026-10-02，父会话）

- 实现 + 测试已落盘并验证：`metric-loop` `npm run test` **42/42**（改前 37）、`security-guard` **65/65**（改前 61）；两包 `npm run check` exit 0、全仓 20 包 `npm run test` 全 `fail 0`、根 `check` / `build` exit 0（父会话复跑）。
- 改动面：`metric-loop/src/{engine,index,persist}.ts` + `metric-loop/tests/{controller,engine,persist}.test.ts` + `security-guard/src/index.ts` + `security-guard/tests/guard.test.ts`（两侧协同：状态文件里的命令在 `tick` 执行前经过同一套命令黑名单判定）。
- 残余：① **审阅子代理结论在提交时尚未回**（审阅要点：旁路是否真被堵、改动面是否最小、误伤与边界、复查是否与 guard 同一套规则、检查点是否在**执行之前**、测试鉴别力、漏项）；若命中必修项按后续修正处理；② README / DESIGN 未同步（若审阅要求另开条目）；③ 真机未验；④ 状态目录非默认（`stateDir` 配置）与状态文件异常形状的行为需审阅确认。
- 条目从项目级 `docs/BACKLOG.md` 清理；追踪文档移入 `docs/archived/`。
