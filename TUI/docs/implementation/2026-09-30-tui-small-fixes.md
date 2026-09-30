# TUI 小问题批修（接取条目：`TUI/docs/BACKLOG.md`「/help 输出按普通文本显示（不要信息提示的蓝色）」「/agents 面板的「取消」动作无效」「垂直状态栏未自动显示 Agents 列表」「状态列 Agents 块把陈旧子代理显示为「不可用(unavailable)」」「/new 新建会话未接入启动自检（`[AUTO]` kickoff）」）

状态：测试　　开启：2026-09-30
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

一次性修掉 TUI 现存五条小缺陷：

1. `/help` 输出改按普通文本色（去掉「信息提示」蓝）。
1. `/agents` 面板 Enter「取消」给出诚实反馈——宿主只支持中断 live continuable 子代理，一次性条目不再「假装成功」。
1. 状态列 Agents 块无需手动打开面板即可自动出现/更新。
1. 状态列不再显示重启后不可物化的陈旧子代理（`unavailable` 诊断）。
1. `/new` 新建会话补发启动自检（`[AUTO]`），与启动路径对齐（新会话不再停在锁定首请求态）。

## 调研

（来源：本仓源码 / 宿主包 `@deepseek-ai/dsh-subagent`（0.1.7-rc.2）/ 既有归档文档 / 真机现象）

- **`/help` 着色**：help 分支经 `notice`（`index.ts`）以 `tone:"info"` 落入 buffer；`NOTICE_TONE_COLOR.info="blue"`（`layout/content-rules.ts`），`noticeLinePresentation` 仅在有 tone 时配前景色 → 去 tone 即回默认前景；活动区与底部 notice 视图共用该函数，改一处两侧一致。
- **`/agents` 取消**：宿主 `subagents.interrupt(target, {kind:'user', parentSessionId})` 的实现只查 **resident（live continuable）** 登记表——`resident.get(target) === undefined` 直接 return；**一次性目标与不存在目标均为 accepted no-op**（`dsh-subagent/lib/index.js` interrupt；类型注释：「An absent target — including a one-shot or unknown id — is an accepted no-op」）。`interruptByParent(..., 'continuable')` 同为 continuable-only，不能救 one-shot。playbook（command-template）子代理为 `mode:"one-shot"`（`command-template/src/subagent.ts:83`）→ 现状 Enter 会成功返回但实际无操作（「已请求中断」属误导）；authority 不匹配时宿主抛 UNAUTHORIZED（App 现 catch 丢弃原因）。
- **状态列 Agents 自动显示**：链路 = `subagent/start|end` →（adapter）`subagent-activity` → App 即时 `refreshAgentsQuiet()`；5s StatusTicker 保鲜带「**无数据不轮询**」空闲停止。真机（playbook 场景）块不自动出现、需打开 `/agents`（面板打开路径主动拉一次）→ 事件面在该场景未生效（或早于目录可见），空闲停止又使 ticker 永不启动 ⇒ 块只能等手动路径。宿主 `listDescendants` 刷新为内存目录遍历（既有调研），常驻轮询可接受。
- **陈旧子代理**：宿主 `listDescendants` 对被读子条目目录失败的子会话产出 `kind:'diagnostic'`，`reason: corrupt | unavailable`（`SESSION_QUERY_CORRUPT_SESSION` / `SOURCE_CONFLICT` → corrupt，其余读失败 → unavailable）；`mode:'unknown'` → unsupported（`dsh-subagent/lib/index.js`）。真机观察：重启后出现 `不可用(unavailable) <id>` 陈旧条目，撑大状态列且污染计数。
- **`/new` 自检**：`startBootstrapKickoff()` 仅 App 构造期调用（`index.ts:544`，恢复会话先挂起等历史折叠），`startNewSession()`（`:3588`）未接；`bootstrapKickoffText` 是启动时按**启动会话**判定的静态文案，不能复用于运行期新会话（启动会话已解锁时为空）。`shouldAutoKickoff` 门控（`tool-bootstrap.ts:329`）= 开关未关 + 模型命中 deepseek + durable 记录可读且无 `tool/call`；全新会话必未解锁，无需读记录。

## 决策

1. **`/help`**：去掉 help 分支的 `tone:"info"`（不新增 tone 级；不误伤其它命令的语义色与错误红）。
1. **`/agents` 取消**：面板对 one-shot 条目不再提供中断动作——归一化层置空 `payload` 并新增行字段 `blockedReason` 承载原因文案；Enter 时关面板 + info 提示「一次性子代理不支持中断（宿主仅支持 continuable）」，diagnostic 沿用「无可用会话 id」说明。continuable 保持现中断调用；App catch 改为带出错误原文（不再吞原因）。**不改宿主、不追 one-shot 取消能力**（其取消属 command-template 命令面，由 BACKLOG 相应条目跟进）。
1. **状态列自动显示**：去掉 ticker 的「无数据不轮询」停止条件（状态列可见 + 有活跃会话即按 5s 节律刷新）；事件路径保留为加速路径。块内容口径不变（空则整块省略）。
1. **陈旧子代理**：**状态列**过滤 `diagnostic && reason==='unavailable'` 的条目（不显示、不计入计数）；`/agents` 面板保持原样（诊断可见、灰显、不可中断）；corrupt / unsupported 仍按既有口径进状态列红色告警；枚举整体失败的「agents 目录不可用」异常行保留（真实错误，不静默）。
1. **`/new` 自检**：`main.ts` 新增**惰性**门控 `bootstrapKickoffForNewSession()`（开关未关 + 当前有效模型命中 deepseek；全新会话必未解锁，无记录判定）→ App 在 `/new` 切换完成后按启动路径同款时序补发 kickoff（含回显）。同族路径（`/fork`、运行期 `/session`、`/continue`）**不在本任务**，收尾时另立条目。

（本任务不接 #52「问答面板排版残留」，维持暂停。）

## 规划

任务拆分与顺序：文档（本文件 + BACKLOG 状态）→ 实现（`/help` → `/new` → `/agents` → 状态列两项）→ `check`/`build` → 测试 → 收尾。

计划改动文件清单（**只改这些**）：

1. `TUI/src/app/index.ts`：help 分支去 tone；`/agents` Enter 分支读 `blockedReason` + catch 带错误原文；ticker 取消防空停止；`startNewSession()` 成功路径补发 kickoff + AppDeps 增 `bootstrapKickoffForNewSession`。
1. `TUI/src/main.ts`：`/new` 惰性门控接线。
1. `TUI/src/app/adapter/types.ts`：`CommandPanelRow` 增可选 `blockedReason`。
1. `TUI/src/app/adapter/dsh.ts`：one-shot 条目置空 payload + `blockedReason`；状态列过滤 `unavailable` 诊断。
1. `TUI/tests/app.test.ts`：`/help` 着色断言更新（非蓝）；`/new` kickoff 用例。
1. `TUI/tests/helpers/appFakes.ts`：kickoff 记录字段与所需假件补充。
1. `TUI/tests/status-column-agents.test.ts`：轮询语义更新（空数据也轮询）。
1. `TUI/tests/command-panel-agents-tools.test.ts`：one-shot 不可中断用例 + 既有归一化假件同步。
1. `TUI/tests/adapter.dsh.test.ts`（**计划外补入**）：真实 adapter 的 `/agents` 契约用例扩展（一次性行 payload/blockedReason、状态列过滤 `unavailable`）；该文件本就承载此契约面（既有 diagnostic / depth 过滤断言），就近扩展以免重复造夹具。测试面扩展，未动产品代码面；如不认可可撤。
1. `TUI/README.md`：`/agents` 行说明、状态列口径、kickoff 口径（如涉）。
1. `TUI/docs/DESIGN.md`：状态列保鲜/过滤口径、kickoff 路径扩展、面板不可中断口径。
1. `TUI/docs/BACKLOG.md`：五条接取/完成状态与收尾清理。
1. 本追踪文档。

明确不做：`/fork` 与运行期恢复的同族缺口（另立条目）；#52；其它模块与宿主包；不做顺手改。

## 实现记录

- 2026-09-30 `index.ts`：help 分支去 `tone:"info"`（默认前景）；`AppDeps` 增 `bootstrapKickoffForNewSession`（惰性门控）；`startNewSession()` 成功路径按启动同款时序（宏任务 + 回显）补发 kickoff；agents 面板 Enter 的 `!payload` 分支优先取 `row.blockedReason`；`interruptAgent` catch 带出错误原文；`maybeRefreshAgents` 取消「无数据不轮询」（只留状态列隐藏 / 无活跃会话两个停止条件）。
- 2026-09-30 `main.ts`：新增 `kickoffForNewSession()`（toolBootstrap 未关 + **当前有效模型**命中 deepseek；`sessionModel.current` 优先、宿主默认兜底）→ `main()` opts 透传 App。
- 2026-09-30 `adapter/types.ts`：`CommandPanelRow` 增可选 `blockedReason`。
- 2026-09-30 `adapter/dsh.ts`：`refreshAgents` 面板行——一次性条目 payload 置空 + `blockedReason`＝「一次性子代理不支持中断（宿主仅支持 continuable）」；状态列快照过滤 `diagnostic && reason==='unavailable'`（corrupt / unsupported 仍进状态列红色告警）。
- 2026-09-30 测试：`app.test.ts`（`/help` 有效前景断言改写 + `/new` 补发正/反 2 例）、`helpers/appFakes.ts`（补 `bootstrapKickoffs` 记录与 `sendBootstrapKickoff()`）、`status-column-agents.test.ts`（轮询语义改写）、`adapter.dsh.test.ts`（夹具扩为 4 条 + 契约断言）、`command-panel-agents-tools.test.ts`（假件归一化同步 + 一次性条目用例）。
- 调试插曲：`/help` 断言先误用「整行含蓝」判据（行内焦点框竖线本身即蓝），改为断言帮助文本前最后一个 SGR＝主题默认前景（`THEMES.dark.foreground`）。
- 流程记录：提交询问点 1（仅文档）与点 2（代码）均已问，用户均答「暂不提交」→ 合并到关闭后一次提交；等待点 3 的人工（真机）确认。

## 测试与证据

- `npm --prefix TUI run check`（tsc --noEmit）✓（中途一次报错：`main()` opts 未含新字段，补接线后通过）。
- `npm --prefix TUI run build` ✓。
- `npm run test:tui`（全量）：**1217 pass / 0 fail**（新增 3 例：`/new` 补发正/反、`/agents` 一次性条目；改写 4 处：`/help` 有效前景、轮询语义、adapter 归一化契约、command-panel 假件）。
- `npm run demo -- --smoke` ✓（`SMOKE_OK`）。
- 真机人工确认（点 3 门禁）：① `/help` ✓ 通过；② `/new` 自检 ✓ 通过；③④ 真机跑 `/playbook` 子代理时**面板无行**、状态列无块——经取证定位为下述他包缺陷（非本任务实现缺陷），面板无行亦使 ③ 不可试；⑤ 未测。待 `command-template` 条目修复后复验 ③④（并对 /council 之类服务面路径可先验证 ④）。
- 复验（2026-09-30 21:5x，command-template 修复生效 + TUI 干净重启后）：**④ ✓ 状态列自动出现** `Agents` 块（`Agents 0/2`，2 条 command-template 子代；无需开面板）；③ 待用户在 `/agents` 面板选中一次性条目按 Enter 验证原因提示；⑤ 待下次重启观察（当前两条为 `inactive`，非 `不可用(unavailable)`）。
- **途中发现（已登记他包条目；本任务不修）**：
  1. `command-template` 一次性子代理直调 `provider.start`、绕过 `ctx.subagents.start` ⇒ 子代理不进父会话 `subagentCatalog`、无生命周期事件 ⇒ `/agents` 与状态列均不可见（实证：父会话 `subagentCatalog` 投影为空；同会话历史 catalog 仅含 continuable 子代）→ `command-template/docs/BACKLOG.md` #1。
  1. `rule-engine` 对子代理会话的消费者评估 + 已关闭句柄 flush → `SessionHandleClosedError` 告警（显示位置另见项目级 `docs/BACKLOG.md` #61）→ `rule-engine/docs/BACKLOG.md` #1。
  1. `/new` 副作用（记录，暂不计缺陷）：释放旧会话 agent handle → 旧会话在跑的 playbook 命令/子代理随之中止（真机 `command/done` 报「子代理未正常结束（killed）」；用户本次测试即此情形）。
  1. 口径提醒（非缺陷）：`/agents` 与状态列只呈现**当前活跃会话**的 depth=1 直接子代——在 `/new` 出的新会话里看不到旧会话的子代理属预期。

## 收尾

（待写）
