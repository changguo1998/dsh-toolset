# 单会话内用户面板人工放行的调用进会话指纹（接取条目：`auto-approve/docs/BACKLOG.md`「单会话内: 用户面板人工放行的调用进会话指纹（同会话后续等价调用免问）」）

状态：规划（调研 17 项 + 决策 15 项 + 规划 10 步；实现待派工）　　开启：2026-10-21　　关闭：待定

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把「用户在审批面板人工放行」的调用也记进**本会话**指纹表，使同会话内后续等价调用不再弹面板；等价判定在现有精确参数指纹之外加**形态层**（命令按 shell 词法拆段 + 每段抹易变参归一，按段覆盖判定）。跨会话不生效、拒绝不入表、与现有层级的优先级关系不变。

## 调研

01. **现状：只有本插件自己裁的 `allowed-once` 进指纹**。`recordApproval` 在 `runtime.commit` 里对 `outcome === "allowed-once"` 记指纹（`src/decide.ts:231-248`、`src/runtime.ts:59-75`），来源只有判定阶梯（指纹 / 只读 / 白名单 / 升级白名单 / LLM）；人工面板的放行完全绕过本插件 → 表里没有。

02. **宿主审批事件对**（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js:126-144`）：

    - `approval/asked` → `{id, toolName, callId?, reason?}`（`id` 由宿主 `randomUUID()` 生成，`callId` 可选）；
    - `approval/decided` → `{id, outcome}`，**只有这两个字段**，没有 decider / 来源 / 工具名 / callId / 参数；
    - 两者必须在 open turn 内成对 append（`:130` 强制），顺序固定：先 asked、再 await 应答链、最后 decided。

03. **事件时序可用**：`session.append` 提交后**同步**派发 `session/event`（`dsh-session/lib/index.js:1517-1590`，`commit` 里 `invokeContainedSessionObservers`），而 asked 的 append 发生在 `decide()` 之前（`:132-139`）→ 本插件订阅 `session/event` 必然先看到 asked，再在应答链里跑自己的 `approval/request` 应答者，最后看到 decided。故「asked 先建配对表、decided 结尾」这条路径成立，无需额外同步。

04. **「是不是本插件裁的」必须自己推断**：decided 不带 decider。两条可选依据 ——

    - (i) 本插件应答者返回 `allowed-once` 时，把该 `callId` 记进短期「自己裁过」集合；decided 按 asked.id → callId 回查是否在集合里；
    - (ii) 与本插件审计行按 `callId` 比对（`scripts/inspect-session.mjs:104-130` 的巡检已用同法区分「自动 / 人工」，`:207` 算 `manual = rows - autoRows`）。

05. **人工面板的返回值就是 `allowed-once`**：TUI 审批面板 `settle(id, allow ? "allowed-once" : "rejected")`（`TUI/src/app/adapter/dsh.ts:3141`），Web 面板同样（`dsh-client-ui-approval/lib/client.js:79`）。故「decided = allowed-once 且非本插件裁定」≈ 人工放行。

06. **条目场景的 ask 带 `callId`**：沙箱升级请求由 `dsh-sandbox/lib/index.js:105-115` 发起，携带 `{agent, toolName, callId, reason: "escalate sandbox to <mode>: ...", signal}` → 能用 `callId` 反查参数。其它 ask 来源（策略式 ask / 插件直连）若不传 `callId`，则无法配对参数（只能放弃学习，记边界）。

07. **参数反查有两条路**：`tools/pre-execute` 的 `CallTable`（`src/gate.ts:89-95`、`src/calls.ts:12-55`，容量 `callTableCapacity`）为主；`session/event` 的 `tool/call`（`src/sessions.ts:58-73`，每会话 200 条）兜底。两条都不命中的调用学不了。

08. **切分口径在 `security-guard`**：`splitCommandSegments`（`security-guard/src/blacklist.ts:28-58`）按 `;` / `|` / `&` / 换行切段，引号内分隔符不切，已从 `security-guard/src/index.ts:46` 导出。本包现有 `normalizeCommand` 只折叠空白 + 去成对引号（`src/patterns.ts:13-23`），**没有**切段能力。

09. **形态归一没有现成实现**：全仓 grep（`形态归一` / `抹易变` / `<msg>` 占位等）零命中，需在本包新增纯函数。

10. **配置面是扁平的**：`fingerprintCapacity` / `callTableCapacity` 直接挂在 `Config` 与 `ResolvedConfig` 上（`src/config.ts:115-117`、`:146-153`），新增开关（是否学习 / 段表容量 / 自己裁定的保留窗口）需按同一风格扩展并补 `resolveConfig` 的诊断。

11. **视图与命令面不区分来源**：`FingerprintView` 只有 `sessionId` / `fingerprintHash` / `toolName` / `approvedAt`（`src/types.ts:147-153`）；`/autoapprove clear-fingerprints` 整表清空（`src/command.ts`）；`status` 只报总数。要不要标「手工学来的」属决策项。

12. **审计行按 `callId` 去重、不带参数原文**（`src/runtime.ts:53-75`、`src/audit.ts`）；「学习」这一刻目前没有落点（不新增事件词汇是既有边界）。

13. **本仓/本 profile 的审批应答者只有两个：本插件 + 人工面板**；host 侧 `experimental-auto-review` 未挂载。故「非本插件裁定的 allowed-once」实际等价于人工（边界：将来接入其它自动应答者会误判，需在实现里留判据）。

14. **一次调用可能触发多次 ask**（例如同一 `callId` 先写权限、后升级）——待实现时验证；学习必须按 **ask id** 配对，不能假设一个 callId 只有一次 ask。

15. **段覆盖语义举例**：`git commit -m "修复 a"` 与 `git commit -m"修复 b"` 归一后同为 `git commit -m <msg>`；`git push origin main` 与 `git push origin dev` 是否为同一形态取决于占位粒度（分支名算不算易变参），属决策项。粘连形式（`-m"b"`）需要词法而非正则切 token，也是决策项。

16. **风险面**：人工放行一次等于认可「这一类命令形态」，比精确指纹宽；误归一（占位太激进）会把不同危险命令并成一类。现有边界声明「不做跨会话持久授权」「不做 GUI 面板」不受影响，但需在 README 明确「同会话内按形态放宽」的代价。

17. **执行结果可观测**：`tool/result` 事件的 `data.message` 带 `isError`（布尔）与 `toolCallId`（主会话样本：712 条 `tool/call` 对 727 条 `tool/result`，`message` 键恒含 `role` / `source` / `toolCallId` / `content` / `isError` / `id`），故「这次调用是否成功」能按 callId 关联，不需要读工具输出正文。

## 决策

01. **学习入口** = 订阅 `approval/asked` + `approval/decided` 事件对（asked 建配对表，decided 收尾）；不轮询日志、不新增事件词汇。
02. **「非本插件裁定」判据** = 双轨：运行时用应答者自记集合（返回 `allowed-once` 时记 `(ask id, callId)`，按 ask id 回查）；重启回填阶段用本会话审计文件的 `callId` 集合比对（调研 04-ii）。
03. **形态层适用范围** = 只对命令类工具（`SHELL_TOOLS` + `COMMAND_KEYS`）；非命令工具仍只走精确参数指纹。
04. **词法层** = 先按 `security-guard` 口径切段（引号内分隔符不切），再用词法扫描切 token（处理 `-m"b"` 这类粘连），最后做固定抹值：引号串 → `<msg>`、长 hex（≥16）→ `<hex>`、纯数字 token → `<n>`；**不抹**路径 / 分支名 / URL / 选项名（宁可少泛化）。
05. **学习算法** = **A 为基线 + B 为增量**（2026-10-21 用户裁定「AB」）：
    - A：段形态集合（每会话），一次调用**每一段**都在集合内才 `allowed-once`（顺序无关）；
    - B：同一段**第二次**观测且仅值位不同时，做最小泛化（anti-unification），把变化位升级为占位；**段首命令词与子命令永不通配**，单段最多 2 个变体位；`learnGeneralize: "off"` 可关掉 B。
06. **学习结果先经 LLM 审阅**（2026-10-21 用户裁定「学习结果用 llm 审阅」）：候选形态提交 `ctx.llm`，带工具名 / 段形态 / 原文 / cwd / 人工放行理由，返回 JSON `{allow, risk, reason}`；`allow` 且 `risk ≤ maxRiskAllow` 才入表。审阅不可用 / 超时 / 抛错 / 解析失败 → **不学**（`onFailure: "skip"` 缺省，fail-closed）；`learnReview.enabled: false` 时跳过审阅直接按 A/B 入表。审阅只判「该形态能否自动放行」，**不参与运行时裁定**。
07. **段覆盖与优先级** = 精确指纹优先，形态覆盖次之，未命中再走后续层；空命令 / 切分失败 / 段数 0 → 形态层不命中（不猜）。
08. **配置面**（扁平风格，缺省合法即用）：
    - `learnFromManual: true`（总开关）
    - `learnGeneralize: "on"`（B 的开关）
    - `learnReview: { enabled: true, onFailure: "skip" }`（审阅；路由沿用 `review` 的显式路由或会话路由）
    - `formCapacity: 256`（每会话形态数，近似 LRU）
    - `selfDecidedCapacity: 512` + `selfDecidedTtlMs: 300000`（运行时自记集合）
    - `learnRehydrate: true`（重启回填）
09. **可观测性** = `FingerprintView` 加 `source: "decision" | "manual"`；`status` 加 `forms`（形态条目总数）；学习 / 审阅结果只写插件 logger（每会话首次一条）与视图，**不新增审计 schema、不新增会话事件词汇**。
10. **切分实现** = 在本包复制 `security-guard` 的 25 行口径（零跨包依赖，守住 R3「不调 guard」）；抽公共模块属跨包改动，另立条目。
11. **安全边界** = 只在**同一会话**内放宽，且只放宽到「同形态」；危险命令仍由 `security-guard` 守卫层否决；形态不参与 `deny` 名单的放宽；LLM 审阅只做准入判断。
12. **关闭态** = `enabled: false` 或 `mode: off` 时既不学习也不审阅（重启回填同样跳过）。
13. **重启回填**（2026-10-21 用户裁定「可以」）= 首次在某会话用到学习层时，经 `ctx.get("sessionQuery").readSession()` 回读 `approval/asked` / `approval/decided` / `tool/call`，用本会话审计文件的 `callId` 集合排除本插件自己的裁定，重建该会话形态集；仅本会话、一次性（进程内标记），逐条过 LLM 审阅，单次最多 20 条（超出丢弃并记一条日志），`sessionPaths` / `sessionQuery` 缺失或读失败 → 空集且不抛。
14. **触发形态 = 自动学习 + 命令面管控**（2026-10-21 用户裁定「C」）：缺省自动学（人工放行即生成候选，同一轮 2 s 内的多条候选**合并成一次** LLM 审阅以摊薄调用）；命令面提供 `learn off` / `learn on`（只切学习，不动运行时裁定）、`learn list`（本会话已学形态与 `source`）、`learn undo <hash>`（撤单条）、`learn clear`（清本会话形态表）。不做「候选待人工确认后才生效」的 `require-confirm` 形态。
15. **失败只挡泛化，不挡首次学习**（2026-10-21 用户裁定「b」）：订阅 `tool/result`，按 `toolCallId` 记 `isError === false` 的成功标记（每会话有界表，容量与 `callTableCapacity` 同口径）；A（首次入表）不看结果，B 的「第二次观测」只累加**成功执行**的调用 —— 先写错失败、再跑相似命令，只算一次成功观测，不会把值位提前升级；回填阶段同样只计成功（`tool/result` 与 `tool/call` 按 `toolCallId` 配对）。

## 规划

01. `src/learn.ts`（新）：词法切段与切 token、固定抹值、`formOfCommand`（命令 → 段形态数组）、`FormStore`（每会话集合 + 容量 + `source`）、`Generalizer`（B：同段第二次观测的最小泛化，段首不通配、变体位 ≤2）。
02. `src/learn.ts` 学习器：`approval/asked` 建配对表、`approval/decided` 收尾、自记集合（容量 + TTL）、候选入队、**2 s 窗口合并审阅**（同批多条 → 一次 LLM 调用，结果按条落地）、去重（同形态不重复审阅）、**执行结果表**（`tool/result` 的 `toolCallId → isError === false`，供 B 的观测计数与回填过滤）。
03. `src/review.ts` 扩展：新增学习审阅的提示与 JSON 解析（复用既有 `ctx.llm` 调用 / 超时 / 失败兜底口径），不改运行时裁定用提示。
04. `src/decide.ts`：精确指纹之后加形态覆盖层（`ruleId: fingerprint:form`，`source: "fingerprint"`）；关闭态与无命令场景直接跳过。
05. `src/main.ts`：订阅 `approval/asked` / `approval/decided` / `tool/result` 三个事件、注入学习器与审阅器、dispose 清理；`status` / 服务面透出 `forms`。
06. 重启回填：首用触发 `sessionQuery.readSession` + 本会话审计文件 → 重建形态集（上限 20、逐条审阅、只计成功执行、失败降级）。
07. `src/command.ts`：新增 `learn off` / `learn on` / `learn list` / `learn undo <hash>` / `learn clear` 五个子命令（只读查询走服务面，写操作走学习器句柄）；`status` 输出加 `learn` 行。
08. `src/config.ts` / `src/types.ts`：新增配置键与校验诊断、`FingerprintView.source`、`AutoApproveStatus.forms`。
09. 测试：新增 `tests/learn.test.ts`，更新 `wiring` / `decide` / `config` / `command` 相关用例。
10. 文档：`README.md`（判定表加形态层、配置表、命令表、边界与代价、巡检口径）、`docs/BACKLOG.md`（条目状态）、本文件（实现记录 / 偏差 / 证据）。

## 计划改动文件清单

- `auto-approve/src/learn.ts`（新：切分 / 归一 / 形态表 / 最小泛化 / 事件学习器 / 回填）
- `auto-approve/src/review.ts`（学习审阅提示与解析）
- `auto-approve/src/decide.ts`（形态覆盖层接入判定阶梯）
- `auto-approve/src/main.ts`（事件订阅、注入、服务面）
- `auto-approve/src/command.ts`（`learn` 五个子命令与 `status` 行）
- `auto-approve/src/config.ts`（六个新配置键与诊断）
- `auto-approve/src/types.ts`（视图与状态类型）
- `auto-approve/tests/learn.test.ts`（新）+ `tests/{decide,wiring,config,command}.test.ts` 调整
- `auto-approve/README.md`（能力表、配置、边界、巡检）
- `auto-approve/docs/BACKLOG.md`（条目状态）
- 本文件

## 测试要点

01. 人工 `allowed-once` → 同会话等价调用走形态层（`source: fingerprint`、`ruleId: fingerprint:form`），不再弹面板。
02. 本插件自己裁定的 `allowed-once` 不入学习（自记集合命中即跳过）。
03. 拒绝 / `cancelled` / `unavailable` 不入表。
04. 跨会话不生效。
05. A：`git commit -m "a"` 学一次后 `git commit -m"b"` 命中；不同命令 / 不同子命令不命中。
06. B：同段第二次仅值位不同 → 升级占位；只观测一次不泛化；段首命令词与子命令永不通配；单段变体位超过 2 个不泛化。
07. 段覆盖：复合命令逐段判定，缺一段即不命中；顺不同不影响结果。
08. 切段口径与 `security-guard` 一致（引号内 `;` `|` `&` 不切）。
09. 取不到 `callId` / 参数原文 → 不学习、不报错。
10. LLM 审阅：`allow` + 风险达标 → 入表；`deny` / 高风险 → 不入；超时 / 抛错 / JSON 非法 → 不入且不抛。
11. `learnReview.enabled: false` → 跳过审阅直接按 A/B 入表；`learnFromManual: false` → 整条路径不启用。
12. 回填：历史 3 对（2 人工 + 1 本插件）→ 只重建 2 条；超过 20 条截断；`sessionQuery` / 审计文件缺失 → 空集不抛；回填只做一次。
13. 容量与 TTL：形态表 256 近似 LRU；自记集合 512 + 5 min 后失效。
14. 关闭态（`enabled: false` / `mode: off`）不学习、不审阅、不回填；既有 115 例保持全绿。
15. 合并审阅：2 s 窗口内 3 条候选 → 只发 1 次 LLM 请求，结果按条落地；窗口外另起一次。
16. 命令面：`learn off` 后人工放行不再学习、`learn on` 恢复；`learn list` 只列本会话形态并带 `source`；`learn undo <hash>` 只删一条；`learn clear` 清本会话；`learn` 子命令不影响运行时裁定与精确指纹表。
17. 失败只挡泛化：同一段先失败后成功（仅一次成功观测）→ 不泛化，但仍按 A 入表（首次学习不看结果）。
18. 两次成功观测（值位不同）才泛化；`tool/result` 缺失（无该 `toolCallId`）按「未成功」处理，不推进 B。

## 实现记录

01. **词法层（`src/learn.ts`）**：`splitCommandSegments`（`:80`，复制 security-guard 的 25 行口径 + `balanced` 标记）、`tokenizeSegment`（`:113`，引号串整体成 token，引号紧贴前文时断开 → `-m"b"` 与 `-m "b"` 同形）、`maskToken`（`:155`，引号串 `<msg>` / 长 hex `<hex>` / 纯数字 `<n>`）、`segmentForm`（`:167`，段首命令词保持原文，引号串也不抹）、`formOfCommand`（`:177`，空命令 / 引号不配对 / 段数 0 → `undefined`）、`commandOfCall`（`:192`，`SHELL_TOOLS` + `COMMAND_KEYS`）、`formHash`（`:198`，sha256 前 16 位，带升级目标）、`matchesForm`（`:209`，`<v>` 通配只认第 3 位起）、`mergeForm`（`:247`，最小泛化）。
02. **形态表（同文件 `FormStore`，`:294`）**：每会话一张 `Map<formHash, entry>`，`formCapacity` 近似 LRU；`covers` 按「每一段都能匹配（顺序无关、缺一段即不命中）」；`noteSuccess` 记成功观测（`callId + 形态` 去重、有界）；`mergeCandidate` / `applyUpgrade` 承载 B 层（升级后清掉被覆盖的旧条目）；`list` / `remove` / `clear` 供视图与命令面。
03. **学习器（同文件 `createLearner`，`:632`）**：`approval/asked` 建配对表（容量 256）→ `approval/decided`（`allowed-once` 且非自记裁定才是人工放行）→ `tool/result`（`message.toolCallId` + `message.isError === false`，每会话有界表）→ 候选入队 → 2 s 窗口合并成一次审阅（`LEARN_REVIEW_WINDOW_MS = 2000`）→ 通过才落表；`reviewed` 去重同形态；`selfDecided` 容量 / TTL 按 `selfDecidedCapacity` / `selfDecidedTtlMs`；`noteSelfDecision` 由判定层在 `allowed-once` 记账时调用（`src/decide.ts:295`）；`readAuditCallIds`（`:1196`）读本会话审计文件的 `callId` 集合供回填排除；`rehydrate` 只重建形态（`REHYDRATE_LIMIT = 20`，逐条过审阅、只计成功执行、一次性、失败降级空集）。
04. **学习审阅（`src/review.ts`）**：`LEARN_POLICY`（`:437`，只做准入）、`renderLearnText`（`:455`，候选带工具名 / 段形态 / 原文 / cwd / 人工放行理由 / 升级目标）、`parseLearnDecisions`（`:496`，批量 `{results:[{id,allow,risk,reason?}]}` 与单条 `{allow,risk,reason?}` 两种形态，非法组合逐条丢弃）、`runLearnReview`（`:543`，超时 / 失败归一）；两条审查路径共用 `withAbort`（`:292`），`riskAtMost` 迁到 `:75`（`decide.ts` 重新导出，外部口径不变）。
05. **判定阶梯（`src/decide.ts`）**：`DecisionContext` 加 `forms?` / `learn?`（`:66`、`:68`）；精确指纹之后接形态覆盖 `coverageOf`（`:158`，`ruleId: fingerprint:form`、`source: fingerprint`，顺手记原文指纹，并触发首用回填）；`recordApproval` 记指纹时带 `source: "decision"` 并自记裁定（`:293`、`:295`）。`learnFromManual: false` 或 `forms` 缺省时该层整体不生效。
06. **接线（`src/main.ts`）**：`FormStore` + 学习器创建（`:163`、`:189`，建运行时之后注入 `runtime.context.forms` / `.learn`）；`session/event` 单监听器内转发 `learner.observe`（`:223`，不新增第二个监听器）；学习审阅器沿用运行时审查的路由（`learnReviewerOf`，`:351`）；回填数据源（`historyOf`，`:373`：`sessionQuery.readSession` + 本会话审计文件）；服务面加 `forms(sessionId?)`（`:276`）；`statusOf` 加 `forms` / `learnEnabled`（`:466`）；启动日志加 `learn=` / `forms=`（`:319`）；bundle 暴露 `learn` 句柄（`:287`）。
07. **配置（`src/config.ts`）**：`learnFromManual` / `learnGeneralize` / `learnReview{enabled,onFailure}` / `formCapacity` / `selfDecidedCapacity` / `selfDecidedTtlMs` / `learnRehydrate`（Config `:127-139`，Resolved `:177-185`）；非法值回落缺省并进 `diagnostics`（`intWithDiagnostic` / `boolWithDiagnostic`）；缺省 256 / 512 / 300000 / 全开。
08. **类型面（`src/types.ts`）**：`FormSource`（`:20`）、`FingerprintView.source`（`:161`）、`FormView`（`:165`，`formHash` / `form` / `toolName` / `source` / `target?` / `approvedAt`）、`AutoApproveStatus.forms` + `.learnEnabled`（`:146`、`:148`）、`AutoApproveService.forms()`。
09. **指纹表（`src/fingerprint.ts`）**：条目带 `source`，`approve` 第四参 `source = "decision"`（`:81`），`list()` 透出（`:55` 字段）；人工放行的那次调用也按原文记一条精确指纹（`source: manual`，`learn.ts` 的 `learnFromApproval`）。
10. **命令面（`src/command.ts`）**：`LearnCommandHandles`（`:40`）、`renderForms`（`:103`）、`dispatchLearn`（`:120`，`off` / `on` / `list` / `undo <hash>` / `clear`）、`status` 加学习行（`:82`）；只读查询走服务面 `forms()`，写操作走学习器 / 形态表句柄；`undo` 支持列表里显示的 8 位前缀。
11. **用例**：`tests/learn.test.ts`（31 例）覆盖词法 / 形态表 / 最小泛化与 18 组测试要点（含 e2e：`createBundle` + 假宿主 + 假 LLM，人工放行 → 形态命中 → 审计行 `fingerprint:form`）；`tests/config.test.ts` 新增 3 例（学习键缺省 / 合法值 / 非法回落诊断）；既有 `tests/{command,fingerprint}.test.ts` 因新增字段与 `approve` 签名同步调整（`command` 加学习行断言）。

## 偏差

01. **计划清单外的必要改动**：`src/fingerprint.ts` 与 `tests/fingerprint.test.ts` 未列入「计划改动文件清单」，但 `FingerprintView.source` 必须由指纹表条目记录（`approve` 加 `source` 参数），否则该字段无从取值。
02. **人工放行同时记精确指纹**：条目原始期望是「把人工放行的调用写进会话指纹」，且 `FingerprintView.source` 的 `manual` 取值需要它才有意义；实现为「按原文记一条 `source: manual` 的精确指纹 + 逐段形态候选（过审阅）」。计划步骤只写了形态候选。`learn off` 会同时停掉这两条。
03. **B 层值位额外收紧**：除「段首命令词与子命令永不通配、单段 ≤ 2 位」外，差异位两侧还必须是可作值的字面量（`-` 开头、含 `/` `\` `=` `*` `$`、`~` `.` 开头、`<…>` 占位一律不作值位）—— `rm -rf /tmp/a` 与 `rm -rf /tmp/b` 不会泛化成 `rm -rf <v>`，按「宁可少泛化」。
04. **形态条目绑定升级目标模式**：同一段形态在不同 `sandbox_permissions` 目标下各存一条、互不覆盖；非升级放行学到的形态不会放宽后续的升级请求（计划未写，属安全收紧）。
05. **`Generalizer` 落成纯函数**：`mergeForm` + `FormStore.mergeCandidate` / `applyUpgrade`（计划写的是类）；行为与「第二次成功观测才升级」一致。
06. **`AutoApproveStatus` 多加 `learnEnabled`**：`status` 要出 `learn` 行（开启 / 关闭），仅有 `forms` 不够。
07. **`AutoApproveService` 加 `forms(sessionId?)`**：按计划「只读查询走服务面、写操作走学习器句柄」，`learn list` 的数据来自服务面。
08. **`learn undo` 支持 8 位前缀**：`learn list` 显示的就是前缀，只按完整 id 匹配会让用户无法复制使用；不足 8 位按完整 id 精确匹配。
09. **回填只重建形态、不重建精确指纹**：决策 13 的措辞是「重建该会话形态集」；放行效果一致（形态层同样免问），且回填不写共享状态。
10. **学习日志按会话各记一条**：同一 2 s 批次可能跨会话（多个会话并发时），逐会话记一条而不是只记批次首会话。
11. **`learnReview.onFailure` 只认 `skip`**：其它取值记诊断并回落 `skip`（fail-closed），未实现 `panel` 之类的兜底（决策 06 只定义了 `skip`）。
12. **`tests/fingerprint.test.ts` 的 `approve` 调用补 `source` 参数**：签名变更的必要同步，断言不变。

## 测试与证据

实现完成后在本 worktree 依次执行（`auto-approve/` 下，`node_modules` 软链主 worktree，未执行 `npm install`）：

```sh
npm run check   # tsc -p tsconfig.json --noEmit
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'
npm run build   # tsc -p tsconfig.json
```

结果（原文摘要）：

```
=== check ===
> tsc -p tsconfig.json --noEmit          （无输出 = 0 错误）
=== test ===
ℹ tests 149
ℹ pass 149
ℹ fail 0
=== build ===
> tsc -p tsconfig.json                  （无输出 = 0 错误）
```

既有 115 例保持全绿；新增 34 例（`tests/learn.test.ts` 31 + `tests/config.test.ts` 3）覆盖「测试要点」18 组：

| 要点 | 用例 |
| --- | --- |
| 01 人工放行 → 形态层命中（不弹面板，`source=fingerprint` / `ruleId=fingerprint:form`） | `01 学习入口：…`（e2e：`createBundle` + 假宿主 + 假 LLM，断言审计最后一行与面板调用次数） |
| 02 本插件自记裁定不入学习 | `02 本插件自己裁定的 allowed-once 不入学习` |
| 03 拒绝 / cancelled / unavailable 不入表 | `03 拒绝 / cancelled / unavailable 不入表` |
| 04 跨会话不生效 | `04 跨会话不生效` |
| 05 A 层：同形不同值命中；不同命令 / 子命令不命中 | `05 A 层：…` |
| 06 B 层：第二次成功观测才泛化；段首 / 子命令不通配；≤ 2 位 | `06 B 层：…` + `最小泛化：…`（`mergeForm` 直接断言） |
| 07 段覆盖：逐段判定、缺段不命中、顺序无关 | `段覆盖：复合命令逐段判定` |
| 08 切段口径与 security-guard 一致（引号内不切） | `切段口径与 security-guard 一致` |
| 09 取不到 callId / 参数原文 → 不学不报错 | `09 取不到 callId / 参数原文` |
| 10 审阅 allow / deny / 高风险 / 超时 / 抛错 / 非法 JSON | `10 审阅：…`、`10 审阅解析：…`、`10 审阅超时：…` |
| 11 审阅关闭直接入表；`learnFromManual: false` 整条不启用 | `11 审阅关闭：…`、`14 关闭态：…` |
| 12 回填：3 对（2 人工 + 1 本插件）→ 2 条；> 20 截断；数据源缺失空集；一次性 | `12 回填：…` ×2 |
| 13 形态表容量 / 自记集合容量与 TTL | `形态表容量：…`、`13 自记集合：…` |
| 14 关闭态不学习 / 不审阅 / 不回填 + 既有 115 例全绿 | `14 关闭态：…`、全量 `npm run test` |
| 15 合并审阅：窗口内 3 条 → 1 次请求；窗口外另起 | `15 合并审阅：…`（断言窗口 2000 ms 与请求次数） |
| 16 命令面：off / on / list / undo / clear，不动运行时裁定与精确指纹 | `16 命令面：…`、`16 learn off 后…`、`16 形态列表渲染：…` |
| 17 失败只挡泛化（先失败后成功不泛化，A 层照常入表） | `17 / 18 失败只挡泛化：…` |
| 18 两次成功观测才泛化；`tool/result` 缺失不推进 B | `17 / 18 失败只挡泛化：…`、`06 B 层：…` |

未验证项（按派工要求留给主分支）：

- **真机验证未做**：未启动 dsh、未触碰真实会话与 profile。真机要看的点：`approval/asked` / `approval/decided` / `tool/result` 三个事件在真实会话里的顺序与 `callId` 可得性（调研 03 / 06）、`sessionQuery.readSession` 回填的事件形态（`tool/result.message.toolCallId` / `isError`）、面板放行后形态在下一轮是否真的不再弹。
- **形态层的实际收益（少弹几次面板）未度量**：需要真实会话样本。
- **跨 shell 工具的形态共享**（`bash` / `pwsh` 同会话共用一张表）只做了 token 级匹配的单测，未在 pwsh 真机上验证。

## 估时

单线程约 **2.0 天**：新增 1 个模块（约 450 行）+ 审阅链路 + 回填 + 命令面 + 执行结果表 + 用例 18 组；真机验证另计。

## 收尾

（待：实现 / 测试 / 真机验证后填）
