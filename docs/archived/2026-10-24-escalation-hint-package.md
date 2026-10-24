# 新增 `escalation-hint` 插件：补齐「沙箱拒绝但升级提示缺失」的一类问题（接取条目：`docs/BACKLOG.md`「新增 `escalation-hint` 插件：补齐「沙箱拒绝但升级提示缺失」的一类问题」）

状态：已关闭　　开启：2026-10-24　　关闭：2026-10-25
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

新增包 `@dsh-toolset/escalation-hint`：订阅宿主 `tools/post-execute`，在「调用被沙箱拒绝、但宿主没有给出升级提示」时经 `additionalContexts` 追加一次重试指引，让模型知道可以用 `sandbox_permissions` + `justification` 重试一次，从而让 `auto-approve` 的升级白名单真正有机会命中。

覆盖范围是**整类问题**，不只 git：`bash` / `pwsh` 的越界写、`write` / `edit` / `str_replace_editor` 的越界写。

前置纪录：`docs/archived/2026-10-24-worktree-git-escalation.md` 的「决策 5」「决策 5 修订」「决策 6」（用户 2026-10-24 裁定）。

## 前置依赖

- 无。原计划依赖「`rule-engine` 透传 `tool/result` 结构化上下文」，2026-10-24 查证后作废：`tool/result` 会话事件只带 `message` / `error` / `meta`（`agent-loop/src/tool-calls.ts:282-295`），工具返回值不进事件流；改由 `tools/post-execute` 直接拿 `exec` + `result.value`（见决策 10）。

## 判据（三层，来自决策 6）

1. 结果已含 `[sandbox: escalation available …]`（宿主常量 `escalationHintMarker`）→ 跳过，不重复提示。
2. 结果含 `[sandbox: file access denied under <mode> mode]`（宿主常量 `sandboxDenialMarker`）却没有升级提示 → 补提示。
3. 无任何 marker：结构化显示「沙箱模式内非零退出 / 信号终止」，且命令形状匹配越界写（`git add|commit|tag`、重定向、`tee` / `cp` / `mv` / `ln` / `mkdir` / `touch` / `rm` / `dd` / `sed -i`）→ 补提示。文件类工具无结构化 `value`，由第 2 层的错误码覆盖。

`value.sandbox.denied` 不作判据（对 git 恒 `false`）。

## 决策

> 2026-10-24 用户确认: 决策 4 选 **b**、决策 7 改选**不等依赖**（先实现并写测试，之后等待 `rule-engine` 落地），其余 7 项按推荐 (a / a / b / b / b / b / a) 定稿。

01. **是否独立包**：a 独立包 `escalation-hint` · b 挂在 `auto-approve` 内 · c 挂在 `behavior-correction` 内。**选定 a**（用户 2026-10-24 已裁定包名与「不止 git」的范围）。理由：与 `auto-approve`（审批应答）职责不同，与 `behavior-correction`（执行前拦截）方向相反 —— 本包只提示、不拦。
02. ~~**消费者形态**：a `sources: ["tool-result"]` + `delivery: "steer"` … **选定 a**~~ —— 已被决策 10 取代（改为 `tools/post-execute`）。
03. **判据层数**：a 只做「有 denial marker 无提示」一层 · b 三层 · c 只做结构化兜底。**选定 b**。理由：第 1 层防重复提示，第 2 层判据最稳（宿主常量），第 3 层覆盖 git 这类本地化漏判。
04. **第 3 层首批范围**：a 只 `git add|commit|tag` · b 再加常见写命令（重定向 / `tee` / `cp` 等）· c 不实现第 3 层。**选定 b**（2026-10-24 用户改选；原推荐为 a）。理由：越界写不只有 git，重定向与 `tee` 写工作区外同样会被沙箱拒；清单逐条列在实现里，误报面由「沙箱模式 + 非零退出」两道前提压住。
05. **`sandbox.denied` 是否作判据**：a 是 · b 否。**选定 b**。理由：对 git 恒 `false`（英文签名失配），作判据等于回到文案依赖。
06. **覆盖工具族**：a 只 `bash` · b `bash` / `pwsh` / `write` / `edit` / `str_replace_editor`。**选定 b**。理由：fs 写工具的拒绝同样带 `sandboxDenialMarker`，第 2 层判据可直接复用。
07. **前置依赖处理**：a 等 `rule-engine` 透传落地再开工 · b 先实现第 1、2 层并留接口、第 3 层等依赖。**选定「不等依赖」**（2026-10-24 用户裁定：先实现并写测试，之后等待 `rule-engine`）。~~该依赖已随决策 10 作废，三层一次落地。~~
08. **注入文案粒度**：a 单一通用文案 · b 按工具族分别措辞（命令 / 文件操作）。**选定 b**。理由：宿主本身按 `subject` 区分 `command` / `operation`，文案随之区分更易被照做。
09. **是否顺带做 guard deny**：a 不做 · b 做（事前拦未带参数的写调用）。**选定 a**。理由：`ToolGuardContext` 无 `cwd`，事前拦会误伤普通仓库；留作后续选项。
10. **落点与注入手段（2026-10-24 追加，取代决策 2 / 7 的 rule-engine 路线）**：a 等宿主把 `value` 写进 `tool/result` 事件（不可控）· b rule-engine 消费者（拿不到 `value`，不可行）· c `tools/post-execute` waterfall + `additionalContexts`。**选定 c**。理由：`exec` 有工具名与参数、`result` 有 `value` 与 `error`；`additionalContexts` 让提示随结果同回合进入下一次请求，无需 `steer`、无需改宿主、无需改 `rule-engine`。
11. **第 3 层的正向前提（2026-10-24 真机误报后收紧）**：除「沙箱内非零退出 + 写形状」外，还要求**结果文本命中拒绝特征**（`read-only file system` / `只读文件系统` / `permission denied` / `EACCES` 等），或宿主已判 `denied: true`；命令先归一化（去掉 `2>&1` 与 `>/dev/null`）。理由：真机首测中 `grep -c … 2>/dev/null` 因退出码 1 被误判为越界写并注入提示，属明显误报。
12. **第 3 层的负向前提（2026-10-24 补测试时定）**：`runnerFailed`（沙箱执行器未起来）、`timedOut`、`aborted` 三种情况**不提示**。理由：它们都不是「写越界被拒」，升级重试解决不了（执行器故障 / 超时 / 用户中断），提示只会误导。

## 规划

计划改动文件清单（实现阶段定稿，2026-10-24 落地）：

- `escalation-hint/package.json`（含 `dsh.bundle`）、`cordis.patch.yml`、`tsconfig.json`、`index.ts`（bundle 入口）、`LICENSE`。
- `escalation-hint/src/judge.ts`：三层判据、命令形状表、按工具族的提示文案（纯函数）。
- `escalation-hint/src/main.ts`：`apply` 订阅 `tools/post-execute`（`prepend: true`）、同 `callId` 去重（上限 64）、`additionalContexts` 追加、`ctx.on` 缺失降级告警。
- `escalation-hint/tests/judge.test.ts`（10 例）+ `tests/main.test.ts`（11 例）+ `tests/tsconfig.json`。
- `escalation-hint/README.md`：能力、判据三层、覆盖工具、配置、已知限制、验证步骤。
- 根级接线：`AGENTS.md`（插件清单 32→33、计数、结构与约定、DESIGN 轻量包清单）、`README.md` / `README.zh.md`（包表、目录树、安装计数）、`scripts/install.sh`（`canonical_pkgs`）、`scripts/test-parallel.sh`（`default_pkgs`）、根 `package.json`（check / build 委托链）。
- 未做：`auto-approve/README.md` 的澄清句（挪到其条目里做，避免跨条目改文件）。

明确不做：

- 不实现升级本身（升级仍由宿主 `approveEscalation` 与 `auto-approve` 负责）。
- 不拦截任何工具调用（本包只注入提示，不做 guard deny）。
- 不改宿主源码、不改宿主 profile 配置、不动 `auto-approve` 现有规则。
- 不做 TUI 面板与真机 CI。

## 验收

- 单测：三层判据各命中 / 跳过 / 误判放行；注入为 user-role `additionalContexts` 且同 `callId` 去重生效。
- 真机：worktree 会话 `git add` + `git commit` 失败 → 注入提示 → 模型带参数重试 → `auto-approve-audit.jsonl` 出现 `outcome=allowed-once` / `ruleId=git-worktree-commit`，commit 成功且无面板。

## 实现记录

- 2026-10-24：新建 `escalation-hint/`（package.json / cordis.patch.yml / tsconfig.json / index.ts / LICENSE / README.md / src/judge.ts / src/main.ts / tests）。
- 2026-10-24：根级接线 —— `AGENTS.md`（清单与计数 32→33、结构与约定、DESIGN 轻量包）、`README.md` / `README.zh.md`（包表 + 目录树 + 安装计数 33→34）、`scripts/install.sh` 与 `scripts/test-parallel.sh` 的包枚举、根 `package.json` 的 check / build 委托链追加 `escalation-hint`。
- 2026-10-24（真机首测）：`escalation-hint` 已挂入 fff profile 并生效 —— `additionalContexts` 注入在同一回合到达模型（实测收到提示全文）；但首测暴露误报：`grep -c … 2>/dev/null`（退出码 1，无匹配）被第 3 层当成越界写。已按决策 12 收紧并补 3 例回归。
- 2026-10-24（补测试）：第 3 层加三条负向前提（`runnerFailed` / `timedOut` / `aborted` → 不提示，见决策 11）；测试从 21 例补到 31 例（真实 `tool-bash` 返回值形状、`signal` 分支、`read-only` 模式、多文本块、`callId` 缺失不去重、`maxHints` 淘汰、文件类不走第 3 层、无结构化结果时不靠文案）。
- 本地依赖用软链复用 `md-table-check/node_modules`（无网络，未改任何 package-lock）；`escalation-hint/node_modules` 与 `dist/` 均在忽略规则内。

## 偏差

- 落点从「rule-engine 消费者 + `steer`」改为「`tools/post-execute` + `additionalContexts`」：`tool/result` 事件不带工具返回值，原方案拿不到 `exitCode` / `sandbox`，已由用户 2026-10-24 批准改道（决策 10）。
- 因此「`rule-engine` 透传」条目作废（其追踪文档关闭为不立项），第 3 层不再等待依赖，三层一次落地。
- `auto-approve/README.md` 的澄清句未写（跨条目，留给该包自己的条目）。

## 测试与证据

- `cd escalation-hint && npm run check` → 通过（`tsc --noEmit` + 测试 tsconfig，无输出）。
- `cd escalation-hint && npm test` → `tests 34 / pass 34 / fail 0`（判据 20 例 + 挂载 14 例）。
- `cd escalation-hint && npm run build` → 生成 `dist/index.js` 等产物。
- 根 `npm run check` → 全包通过（含 `escalation-hint`；输出末行为本包 check）。
- 根 `npm run test` → 全包跑完；唯一失败是 `clock-base/tests/timers.test.ts:182`（interval 至少触发两次，实际 1），该包单独跑 24/24 通过 —— 并行负载下的既有时序抖动，与本次改动无关（未触碰 `clock-base`）。
- 真机（已通过，2026-10-25 04:37 至 04:38）：在 `.worktree/hint-test`（worktree 会话，写根 = worktree）执行 `git add` / `git commit`，两条均被沙箱拒（exit 128，`fatal: 无法创建 '.git/worktrees/hint-test/index.lock': 只读文件系统`）→ 每次都在同一回合收到提示 → 按提示带 `sandbox_permissions: "danger-full-access"` + `justification` 重试 → `git add` 与 `git commit` 均成功（commit `344c603`），**无审批面板**。
- 审计证据：`~/.dsh/sessions/--…-dsh-toolset.worktree-hint-test--/tui-870d3f68…/auto-approve-audit.jsonl` 两条记录均为 `outcome="allowed-once"` / `source="upgrade"` / `ruleId="git-worktree-commit"`。
- 误报回归（真机）：修复后再跑 `grep -c … 2>/dev/null`（exit 1、stderr 空）未产生新注入（会话日志最后一条注入仍是修复前的 04:27:11）。
- 清理：coagent 已关闭；`.worktree/hint-test` 与 `hint-test` 分支已删除（commit 仅存在于测试分支）。
- 未做：无（端到端已在真机跑通）。

## 收尾

- 验收两条均已满足（单测 34/34 + 真机端到端），条目「新增 `escalation-hint` 插件：补齐「沙箱拒绝但升级提示缺失」的一类问题」标完成并从 `docs/BACKLOG.md` 移除。
- 本文件移入 `docs/archived/`。
- 回写：`AGENTS.md` / `README.md` / `README.zh.md` / `scripts/install.sh` / `scripts/test-parallel.sh` / 根 `package.json` 已在实现阶段同步（新包清单与计数 33 / 34），无需二次回写。
- 未做（随条目结束）：`auto-approve/README.md` 的澄清句（跨包，留待该包自己的条目）。
- `docs/STATUS.md` 由用户择时更新。
