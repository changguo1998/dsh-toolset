# 启动自检 kickoff 注入时序（接取条目：`docs/BACKLOG.md`「启动自检 `[AUTO]` 的入队与领取都排在 rule-engine 注入之后」）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

新会话开局：kickoff（`source.kind:"tool-bootstrap"`）必须先于任何 rule-engine / 消费者注入入队、并被 turn1/step1 首位领取（`[AUTO]` 在 `[RULE]` 之前）；恢复会话「等历史折叠落定再发」的既有约束不退化；`dedupeInRecord` / `directWrite` 语义不动。

## 调研

- 现象（本会话记录 `tui-e0973ace` 实测，与条目证据同形）：seq 3 `agent/inbox/spliced`（rule-engine `[RULE]` 合并注入，time 1791038215778）→ seq 4 `turn/start`（…779）→ seq 5 claim（removedCount=1，…780）→ **seq 6 kickoff `[AUTO]` spliced（…783）** → seq 7 `step/start`（…915）。即 rule 先 splice、且先唤醒（turn1 由 rule 的 steer 开启），kickoff 迟到约 5ms，只能在 step 2 前被领取。
- 两侧时机：
  - rule-engine（`rule-engine/src/main.ts:210` `session/created` → `engine.ts:840` 派发 `session-start` → `inject.ts:101`）：会话创建期同步派发 → 注入进 `setTimeout(deliver, 0)`（宏任务 A，排入早）。
  - TUI（`TUI/src/app/index.ts:2439` 启动路径、`:3773` `/new` 路径）：`App.start()` 里 `setTimeout(submitBootstrapKickoff, 0)`（宏任务 B，排入晚）→ B 后跑，kickoff 晚到。
- 宿主 inbox（`@deepseek-ai/dsh-agent-loop/lib/index.js`）：`steer` = `splice("next-step", Infinity, 0, [msg])` **追加** + 唤醒；类内另有 **`prepend`**（头部插入，未见于插件公开面）；step 边界 `claim` 取**整个** next-step 队列（顺序 = 队列序）。
- 验收：首条 spliced 即 `tool-bootstrap`，且 turn1/step1 领取的首条用户可见内容为 `[AUTO]`；补一条时序断言 + 反向验证（撤修复必红）。

## 真机时序实验（复现方式；产物为临时目录，随任务清理）

1. `P=tmp/kickoff-exp; mkdir -p $P/home/profiles; cp -a ~/.dsh/profiles/fff $P/home/profiles/fff`
1. 副本 `node_modules` 下的相对 symlink 逐个改写为绝对路径（按原 profile `readlink -f` 后 `ln -sfn`）——否则 `dsh` 报 `cannot resolve profile bundle`。
1. `node tmp/kickoff-smoke.mjs $P/home 9000`（PTY：`script -qec "env DSH_HOME=$P/home dsh --profile fff" …`；9s 后 SIGTERM→SIGKILL 进程组）。
1. `zstd -dc $P/home/sessions/*/tui-*/session.v4.jsonl.zstd | head -12` 比对 splice / turn / claim / step 的 seq 与 time。

## 决策（2026-10-04，实验定案）

**选 (a)：TUI 启动自检改为「启动期同步发送」，不走宏任务**（启动路径与 `/new` 路径各一处）；rule-engine 行为不动，只补一条时序契约注释。

- 实验证据：
  - baseline（现码）：seq 3 rule splice（t…743）→ seq 4 `turn/start` → seq 5 claim `removed=1` → **seq 6 kickoff（t…748）** ✗ 复现。
  - 候选 (a)（同步发送）：**seq 3 kickoff（t…882）→ seq 4 `turn/start` → seq 5 claim（踢走 kickoff）→ seq 6 rule（t…895）** ✓ 验收两条均满足。
- 原理：`session/created` 时 rule-engine 才把注入排入宏任务；TUI 侧 `await createNewSession()` 决议后的续跑是**微任务**，`main()` → `app.start()`（`TUI/src/main.ts:140`）全同步、无 await 间隙 → 同步发送必然先于任何待跑宏任务入队：结构性顺序，非竞速。
- 候选 (b)（rule-engine 让位握手）被否：同一结果、跨插件耦合更重；候选 (c)（`prepend`）被否：`prepend` 只在宿主 inbox 类内部，插件面（`agent.steer/inject/followup`）无此原语。
- 约束保持：恢复会话仍「等历史折叠落定再发」；`dedupeInRecord` / `directWrite` 语义不动；不动宿主。

## 规划

1. 子代理只读审阅决策（本条）→ 按意见修订。
1. 实现：`TUI/src/app/index.ts` 两处同步发送（已实验改毕，待按审阅意见定稿注释）；`rule-engine/src/inject.ts` 补时序契约注释（session-start 注入恒延后一宏任务，先让 App 启动自检入队）。
1. 测试：`TUI/tests` 新增「启动即同步发送（不 flush 定时器即已发）」断言 + 反向验证（改回宏任务必红）；核对既有 kickoff 用例（`app.test.ts` 的 `/new`、`adapter-steer.test.ts`）。
1. 验证：根 `npm run check` + TUI `build` + `test:tui` + 真机时序实验复跑（验收两条）。
1. 回写：`TUI/docs/DESIGN.md` 锚定一节把「新会话：启动后宏任务发送」改为同步口径；追踪文档收尾；BACKLOG 标完成并清理；提交（每条目一提交）。

计划改动文件清单（**只改这些**）：

- `docs/BACKLOG.md`（条目状态）
- `docs/implementation/2026-10-04-bootstrap-kickoff-order.md`（本追踪文档）
- `TUI/src/app/index.ts`
- `rule-engine/src/inject.ts`（仅注释）
- `TUI/tests/app.test.ts`（时序断言；按审阅意见）
- `TUI/docs/DESIGN.md`（关闭时回写锚定·时序）

明确不做：不动恢复会话「等历史折叠落定再发」；不改 `dedupeInRecord` / `directWrite` 语义；不动宿主包；不顺手改相邻代码；不引入 (b)/(c) 方案。

## 实现记录（2026-10-04）

- 子代理只读审阅（决策后、实现前）：决策通过；要求一并处理——① 同步发送属启动关键路径，宿主抛错不得冒出 `App.start()`（加 try/catch 退化为 warn notice）；② `/new` 门控求值窗口（`sessionModel.current` 在异步回填落定前仍是上一会话）→ 不顺手修，另立条目；③ 不变量注释写进 TUI 调度 / rule-engine 注入器 / rule-engine DESIGN；④ 测试须在「同一同步回合」断言（一旦 `await`，旧实现的宏任务也会先跑，测不出差异）；⑤ 文档口径三处同步。
- 代码：`TUI/src/app/index.ts`——启动路径与 `/new` 分支改同步发送；`submitBootstrapKickoff()` 的宿主调用加 try/catch（失败记 warn notice，不冒泡）；`rule-engine/src/inject.ts` 头注释补「启动期顺序契约」（无行为改动）。
- 文档：`TUI/docs/DESIGN.md` 锚定·启动自检两处口径改同步；`rule-engine/docs/DESIGN.md` §1 补契约条目；`rule-engine/README.md` 注入一节补一句顺序说明。
- 测试：`TUI/tests/app.test.ts` 新增「启动：kickoff 在 `app.start()` 内同步发出（不 flush 定时器）」；`/new` 用例标题改「同步发送」。
- 未做：候选 (b)/(c) 不引入；`/new` 门控窗口问题另立 TUI 条目（见「收尾」）。

## 测试与证据

- 根 `npm run check`：exit 0（`error TS` 计数 0）；TUI / rule-engine `npm run build`：exit 0。
- `npm run test:tui`：1301 pass / 0 fail（含新增 1 条）；`rule-engine && npm test`：85 pass / 0 fail。
- 反向验证（撤修复必红）：把 `startBootstrapKickoff` 临时改回 `setTimeout(…, 0)` → 新用例 `✖ AssertionError: start() 返回即已发送（同步）`（fail 1）；恢复修复态后复绿。
- 真机时序实验（临时 `DSH_HOME` + 复制 fff profile + PTY；最终代码）：seq 3 `agent/inbox/spliced kinds=[tool-bootstrap]` → seq 4 `turn/start` → seq 5 claim（踢走 kickoff）→ seq 6 `kinds=[rule-engine]` → seq 7 `step/start`——验收两条满足（首条 splice 即 kickoff；turn1/step1 首位领取）。

## 收尾

- 回写已落：`TUI/docs/DESIGN.md` / `rule-engine/docs/DESIGN.md` / `rule-engine/README.md`（见「实现记录」）。
- 新发现问题另立条目：`TUI/docs/BACKLOG.md`「`/new` 启动自检门控取到上一会话的模型（求值窗口）」（子代理审阅发现，交其他 agent）。
- 观察项（宿主面，未立项）：turn1/step1 能首位领取 kickoff 还依赖宿主「maintenance 收尾后才唤醒」的现行为（`dsh-agent-loop`）；若宿主改为先 `kick()` 后 resolve，kickoff 会退到 step 2——届时回退方案是让 rule-engine 的 `session-start` 注入再推迟一层。
- 临时产物已清理：`tmp/kickoff-exp/`（实验 home 与会话日志）、`tmp/kickoff-smoke.mjs`（实验脚本）；复现方式见「真机时序实验」一节。
- 本文件移入 `docs/archived/`；`docs/BACKLOG.md` 对应条目清理（仅留未完成项）。
