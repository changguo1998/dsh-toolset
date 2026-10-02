# TUI `$` 模式执行面不经 guard（接取条目：`docs/BACKLOG.md`「TUI `$` 模式执行面不经 guard（观察项）」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

TUI 的 `$` 模式（`TUI/src/app/local-shell.ts`）直接执行**用户手输**命令，不经 security-guard 的命令层（guard 的 pre-execute 只覆盖**模型侧工具调用**）。属用户输入面、风险等级低于模型面，但同一台机器上「模型侧拦截、用户侧放行」的口径不一致，值得补齐或明确记为边界。本条目按 **P3 观察项**处理：**能接就接**（有 guard 服务时先复查），并把边界写清楚。

## 决策

- **D1（接入方式）**：`$` 模式执行前**惰性** `ctx.get("guard")`（与 metric-loop/task-engine 同口径）→ `inspectCommand(cmd, "tui:$")`；命中即**不执行**，把回执原文渲染到输出区（含来源标注与规则 id）。
- **D2（fail-open）**：guard 未挂载 / 抛错 → **告警一次** + 照常执行（不得让 TUI 因 guard 缺失而不可用）；不影响既有 `$` 模式的其它行为。
- **D3（不做）**：不引入沙箱；不改模型侧工具面；不改 `local-shell.ts` 的解析/补全/历史逻辑；不动其它包。
- **D4（测试）**：① 命中（假 guard 命中）→ 命令**未执行**、输出含回执与来源标注；② 放行 → 照常执行；③ guard 缺失 → fail-open + 只告警一次；④ 既有 `$` 模式用例不回归。
- **D5（反向验证）**：撤掉复查调用 → ① 必失败；还原全绿。
- **D6（文档）**：`TUI/README.md`（或 `TUI/docs/SPEC.md` 的 `$` 模式段）补「执行前经 security-guard 复查（需 guard 挂载；未挂载 fail-open + 一次告警）」；`security-guard/README.md` 的边界段补一句「TUI `$` 模式在挂载 guard 时会经 `inspectCommand` 复查（来源 `tui:$`）」。
- **D7（验证）**：TUI 包 `npm run check` / `build` / `test`（**`npm run test:tui`** 单包跑，避免全包并行）+ 根 check/test/build；`format`；真机（若可）用 `dsh --profile fff` 在 `$` 模式跑一条命中命令看拦截面；否则记残余。

## 计划改动文件清单

- `TUI/src/app/local-shell.ts`（复查缝）+ `TUI/tests/*`（或既有本地 shell 测试文件）+ `TUI/README.md`（或 `TUI/docs/SPEC.md`）+ `security-guard/README.md`（一句）
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 交子代理审阅本文件「决策」。
1. 实现 + 测试 + 反向验证 + 全仓 `check` / `build` / `test`。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02）

- **落点（三段式，审阅确认「可达性问题已解决」）**：纯 helper 在 `local-shell.ts`（`SHELL_GUARD_SOURCE="tui:$"`、`ShellGuardServiceLike` 结构子集、`makeShellGuardChecker(getGuard, warn)`、`shellGuardBlockedLines`、`SHELL_GUARD_SKIPPED_LINE`）；调用在 App（`index.ts` 的 `runLocalShell`，**唯一插入点**，严格早于 `shellRunner`）；读点在 `main.ts`（apply 作用域内**惰性** `ctx.get("guard")`，与既有 getSymbols/getSessionChannel/getRuleEngine 同款）。`local-shell.ts` 无 ctx，原 D1 字面写法不可行。
- **语义**：命中 → **不执行**（runner 调用数 0），输出「命令回显 → 回执原文逐行（首行含 `命令复查来源：tui:$。`）→ 尾行 `→ 已拦截（未执行） · security-guard`」；**不自加来源标注**（回执已带）；`skipped` → **逐次淡色留痕**「→ 未复查（security-guard 不可用，按放行执行）」（与 metric-loop/task-engine 的 `guardSkipped` 同口径）；未挂载/形状不符/读取或调用抛错 → fail-open + **每种失效模式各一次** `warn: ` 前缀告警（保证在活动区是**黄色 warn** 而非灰 log）。
- **不改**：沙箱 / 模型侧工具面 / 解析·补全·历史逻辑 / input-status；被拦命令仍入历史（入栈在模式分支之前）。
- 规模：7 文件、**+192/-7**；新测试 `TUI/tests/shell-guard.test.ts`（8 例）。
- **偏离清单**（相对计划）：计划外新增 `TUI/src/main.ts`（读点必须在插件 apply 作用域）、`TUI/src/app/adapter/types.ts`（服务面类型子集补 `inspectCommand?`）、`TUI/src/app/index.ts`（复查是 App 的执行缝，且 `deps.runShell` 可注入假执行器，必须在 App 层 gate 住 runner）。

## 测试与证据（2026-10-02）

- 用例：`TUI/tests/shell-guard.test.ts` **8 例**（① 命中：source 字面量 `tui:$`、`inspectCommand` 调用一次、**runner 调用数 0**、输出行序与尾行、首行仍回显、无任何执行摘要行；② 放行：照常执行且无 guard 行；③ 未挂载：两命令都执行 + 告警仅 1 条且 `/^warn: /` + 两条「未复查」留痕；④ 抛错（App 级 + 单元级）；⑤ **App 未接线**：不复查不告警不留痕；⑥ 空/非字符串回执：`{receipt:null,skipped:false}` 且不告警）。既有 `$` 用例**零改动**、无回归。
- TUI：`npm run test:tui` → **1298 pass / 0 fail**；`check` + `build` 通过。根：`check` / `test`（20 包全 `fail 0`）/ `build` exit 0；`format` 7 文件 unchanged；`git diff --name-only | grep src/` 仅 4 个预期 src 文件。
- **反向验证两态**：态 A 撤掉复查调用 → 4 例必失败；**态 B 错序**（runner 调到复查之前）→ 5 例必失败（「runner 调用数 0」断言抓住「检查排在 runner 之后」的错误实现）；两次还原均与备份**逐字节一致**。
- **真 GuardEngine 集成探针**（临时脚本已删）：回执首行 `[security-guard] 命令复查来源：tui:$。`、含规则 id（拼接构造）、渲染 7 行且尾行为 `→ 已拦截（未执行） · security-guard`、来源标注**仅出现 1 次**、`recent()[0].toolName === "tui:$"`（`/guard` 面板可见）、放行 `{receipt:null,skipped:false}` 且 0 告警。

## 审阅（子代理 `71419d2c`）——结论：**不能按现状收口** → 全部处置

| 审阅发现 | 处置 |
|---|---|
| P2-a fail-open 告警实测落**灰 log** 而非黄 warn | 已改：`warn: ` 前缀（`index.ts` 的 logger 调用），用例断言 `/^warn: /` |
| P2-b `skipped` 被丢弃（承诺「必须可见」未消费，与两包口径不一致） | 已取方案①：**逐次淡色留痕** `→ 未复查（guard 不可用，按放行执行）` |
| P2-c D4 缺 5 条锚点 + D5 反向验证太弱 | 五条锚点全部落测；D5 加强为「runner 调用数 0 + source 透传 + 拦截块首行=回显」，并加**错序变异**态（专门排除「检查排在 runner 之后」） |
| P3-a 拦截块缺 `→` 收尾行；自加来源与回执首行重复 | 已补 `→ 已拦截（未执行） · security-guard`；去掉自加来源 |
| P3-b 计划外文件未列（main.ts / adapter/types.ts） | 已记偏离清单（见上） |
| P3-d 敏感层看不到 cwd | 已在 `security-guard/README.md` 补同款边界句（TUI 的 cwd 来自状态栏） |
| 漏项：SPEC.md 无 `$` 段；COMMANDS\*.md 不需同步；guard README 落点；D7 真机四步 | 已按此执行（落 `TUI/README.md:169`；COMMANDS\* 明确不做；guard README 调用方列表加 TUI 子条目） |
| P3-c adapter 的 `guard` 仍是 apply 期快照、与惰读并存 | **不在本条目不扩范围** → 已立项 BACKLOG 观察项 |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：① **真机交互式手测未做**（本会话无 TTY，进不了 `$` 模式）→ 以真 GuardEngine × TUI 缝集成探针替代；② `TUI/docs/SPEC.md` 无 `$` 模式段（本次只落 README，SPEC 需另条目不）；③ `adapter` 的 `guard` 快照与 `$` 复查的惰读**读法不一致** → BACKLOG 观察项；④ 晨间已立项的「扫描面前缀过滤」等无关。
