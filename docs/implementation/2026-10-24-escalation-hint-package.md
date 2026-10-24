# 新增 `escalation-hint` 插件：补齐「沙箱拒绝但升级提示缺失」的一类问题（接取条目：`docs/BACKLOG.md`「新增 `escalation-hint` 插件：补齐「沙箱拒绝但升级提示缺失」的一类问题」）

状态：测试　　开启：2026-10-24
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
- 本地依赖用软链复用 `md-table-check/node_modules`（无网络，未改任何 package-lock）；`escalation-hint/node_modules` 与 `dist/` 均在忽略规则内。

## 偏差

- 落点从「rule-engine 消费者 + `steer`」改为「`tools/post-execute` + `additionalContexts`」：`tool/result` 事件不带工具返回值，原方案拿不到 `exitCode` / `sandbox`，已由用户 2026-10-24 批准改道（决策 10）。
- 因此「`rule-engine` 透传」条目作废（其追踪文档关闭为不立项），第 3 层不再等待依赖，三层一次落地。
- `auto-approve/README.md` 的澄清句未写（跨条目，留给该包自己的条目）。

## 测试与证据

- `cd escalation-hint && npm run check` → 通过（`tsc --noEmit` + 测试 tsconfig，无输出）。
- `cd escalation-hint && npm test` → `tests 21 / pass 21 / fail 0`（判据 10 例 + 挂载 11 例）。
- `cd escalation-hint && npm run build` → 生成 `dist/index.js` 等产物。
- 根 `npm run check` → 全包通过（含 `escalation-hint`；输出末行为本包 check）。
- 根 `npm run test` → 全包跑完；唯一失败是 `clock-base/tests/timers.test.ts:182`（interval 至少触发两次，实际 1），该包单独跑 24/24 通过 —— 并行负载下的既有时序抖动，与本次改动无关（未触碰 `clock-base`）。
- 未做：真机验证（worktree 会话 `git add` + `git commit` → 提示 → 带参重试 → 审计 `allowed-once`），需人工。

## 收尾

- 未关闭：等待人工真机确认（验收第二条）后再关闭并归档。
- 关闭时需做：条目移出 `docs/BACKLOG.md`、本文件移入 `docs/archived/`、按需回写 `docs/STATUS.md`（用户择时）。
