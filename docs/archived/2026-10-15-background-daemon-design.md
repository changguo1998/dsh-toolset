# 后台常驻守护机制设计（接取条目：`docs/BACKLOG.md`「后台常驻守护机制（定时任务 / 发布命令 / 可见性与日志 / 持久化）—— 先出设计」）

状态：完成　　开启：2026-10-15　　关闭：2026-10-18
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

条目要求**先交设计、不实现**。本任务 = 走完一轮设计与裁定所需的调研，产出一份可据以拆实现条目的设计文档，覆盖：

1. 两种形态（进程内插件 / 独立常驻进程）逐项对照并给出推荐；
2. 首期四项能力（定时任务 / 发布命令 / 可见性与日志 / 持久化与重启恢复）各自的行为口径与可验证验收；
3. 明确与宿主 `schedule` 包的关系（复用 / 自建 / 并存）；
4. 给出待用户裁定的决策点与实现条目草案（裁定后才登记 BACKLOG）。

首期范围外（条目已定）：「唤醒其他代理」（跨会话跑任务 / 委派子代理）列后续可选项。

**范围口径（用户 2026-10-15 收窄）**：本守护**只面向「已有活跃 agent」的投递**（怎么安排见设计 §B）；「起新 agent / 唤醒冷会话 / 跨进程投递」不在本设计内 —— 其中「herdr 开窗起 agent」已由用户裁定**另立插件**（调研 §5、D12）。

**范围再收窄（用户 2026-10-17 裁定）**：核心收敛为**两块** —— ① **定时执行**（选择器 + 时刻表 + 到点投递文本 / 执行 slash 命令）② **过程结果记录**（任务定义与状态、运行流水与结果、可见性与重启恢复）。两条边界同时外置:

- **记忆**由本仓 `memory-base` 的现成面承担（长期知识、分层作用域、检索）；
- **编排**（多代理建组 / 发言权 / 汇聚结论）归新插件 `peer-group`（工作树 `feat/peer-group`, 设计见 `docs/implementation/2026-10-16-peer-group-protocol-design.md`）——「唤醒其他代理」随之移交, 本设计只保留触发侧的接口假设。

模块归属见设计 §H；记录底座的两条候选对比见调研 §10。

## 调研

来源标注：`安装树` = `~/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（dsh 0.2.0-rc.2 全局安装）；其余为仓内文件。

### 1. 宿主 `schedule` 包的真实能力与可用性（本次调研的主要翻转点）

能力面（`安装树/dsh-schedule/README.zh.md`，与 `lib/types/*.d.ts` 一致）：

- 提供 `ctx.schedule`（`ScheduleService`）与模型侧四工具 `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`；
- 六种选择器：`after_seconds`（一次性延时）/ `at`（绝对时点）/ `every_seconds`（≥ 60 s 固定间隔）/ `daily` / `weekly`（显式 IANA 时区本地钟表时间）/ `cron`（五字段 Vixie 表达式 + 显式时区）；
- 任务定义持久化（storage domain v1）、宿主重启后仍可用、到期**恢复冷会话**并投递；
- 每个周期任务**只补发最近一次**错过的发生时点；同一会话到期的多条合并为一条消息；
- 投递回执 `lastDelivery` + 有界投递历史（`deliveryHistoryDays` 缺省 30 / `deliveryHistoryRecords` 缺省 200）、`schedule/changed` 通知面（TUI 已有「到点 toast」，`TUI/docs/DESIGN.md:218`）；
- 存储面**权威**：文件损坏 / 版本不支持 / 任务非法 → 拒绝启动，不发布部分目录。

**可用性（决定性的否定结论）**：本 profile 挂上它也投不出去。

- `lib/index.js:2590` 的 `static inject = ["agents", "sessions", "tools", "storageDomain", "sessionController", "sessionPersistence"]`；
- 投递路径 `lib/index.js:1576` `await this.ctx.sessionController.resolveAgent(task.sessionId)` → `:1596` `resolved.agent.followup(message)` → `:1597` `ctx.sessions.flush(...)`；
- `sessionController` 由 `api-session-controller` 提供，`docs/host/HOST-PACKAGES.md:431` 标**未挂载**（排除口径见 `:21`「API 控制面 `api-*`」），本机 `~/.dsh/profiles/fff/cordis.patch.yml` 直读亦**无**该行与 `schedule` 行；
- 该类注释自述为 Web 面控制器（`dsh-api-session-controller/lib/index.js:183`「Owns every operation that may create, resume, or configure a Web Agent」），构造期即向 `ctx.typert.lookups/contexts` 注册远程查找面 —— 拉它等于把 Web 远程控制面整套带进 TUI 组合；
- 官方 README 亦明说「Schedule 无法在 headless 或仅 SDK 的组合中单独挂载：投递需要 Host 的 Web Session controller 和 Session 持久化后端」。

⇒ 「解禁并复用宿主 schedule」不是改一行 profile 的事：要么接受 Web 控制器整套依赖（与本仓「只用 TUI、不配 preset、走单组合」口径冲突），要么投递恒失败（inject 不满足 → 服务不启动，只剩一个空壳行）。

另两条间接成本：宿主 schedule **投递失败只记日志、不自动重试**；`metric-loop/README.md:77` 已记录「`schedule_create` 提示的可执行性取决于 profile 是否挂载」这一现状。

**如果改为「挂上它」要付什么（2026-10-15 用户表示「需要的话可以挂载，这不是阻塞点」后核实）**

- `schedule` 的 `inject` 里有 `sessionController` → 必须挂 `api-session-controller`（Web 面 agent 控制器），其服务的 `static inject`（`lib/index.js:2816`）为：`agentDefaultModel` / `agents` / `attachments` / `fileUploads` / `fs` / `llm` / `sessions` / `sessionProjections` / `sessionQuery` / `typert` / `workspaceRegistry`；
- 其中**已具备**：`agents` / `llm`（`HOST-PACKAGES.md:175` 已挂载）/ `sessions` / `sessionProjections` / `typert`（`typert-registry`）/ `workspaceRegistry`（`workspace`）/ `agentDefaultModel`（profile 有该行）；
- **更正**：`sessionQuery` **不缺** —— `session-query-sqlite`（已挂载）自述为「Concrete SQLite owner of the combined `ctx.sessionQuery` service」（`dsh-session-query-sqlite/lib/index.js:475`），`HOST-PACKAGES.md:111` 标「未挂载」的是**缝包行** `session-query`，不是服务本身；
- **存疑的三项**：`attachments`（缝包 `attachment` 未挂载；fff 只挂了 `attachment-local`，而后者 peer 依赖 `dsh-attachment` 且只导出 `LocalAttachmentStore`）、`fileUploads`（持有包 `client-file-upload` 属客户端 UI 面，未挂载）、`fs`（缝包 `fs` 未挂载，仓内另有 `fs-local` 包未挂）。这三者是否必须补行才能让控制器起来 —— **只有实测能定**（属「挂载试验」）。

### 2. 本 profile 已挂载的投递原语（形态 A 的地基）

- `ctx.sessions`（`docs/host/HOST-PACKAGES.md:97`，已挂载）：`create/prepare/enter/announce/flush/get/list/fork`；
- `ctx.agents`（`:32` 已挂载区的 `agent` 行）：`ctx.agents.get(sessionId)` 取活 agent（`dsh-api-session-controller/lib/index.js:372` 的 `liveAgent` 即此调用）；
- **冷会话在进程内可恢复**：`ctx.agents.resume({ resumeSessionId, agentOptions, setup? })` —— Web 控制器走的正是这条路（`dsh-api-session-controller/lib/index.js:404-410`：`ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })`），且 `ResumeAgentOptions.setup` 在类型上是**可选**的（`dsh-agent/lib/types/index.d.ts:124-131`），即不提供组合回调也能按环境组合恢复；缺它意味着守护要自行承担「恢复出来的 agent 用哪套组合」的语义风险（首期可不做，见决策 D5）；
- 注入管线（`session-channel/docs/DESIGN.md` §4）：`agent.followup(user 消息)` + `sessions.flush()`，且**必须避开 `session/event` 的同步派发窗口**（`setTimeout(…, 0)` 推迟宏任务，rule-engine 已实证）；
- `ctx.commands`（`:189` 已挂载）：`register` / `find` / **`execute(agent, line, attachments, signal)`**（`dsh-commands/lib/types/index.d.ts:94/113/142`，注释即「Parse and execute a known command without sending it to the model」）—— 这是「发布命令」里 slash 命令的唯一正确出口；
- `ctx.storageDomain`（`:126` 已挂载）、`sandboxPolicy`（已挂载）、`approval`（已挂载）、`permissionPresets`（已挂载）。

### 3. 「投递 slash 命令」的硬约束（决定了能力②的实现口径）

TUI 的 slash 命令解析只有一个调用点：`TUI/src/app/index.ts:3327` `this.handleSlash(slashLine)`，位于**本地输入提交路径**（`mode === "slash"` 分支）。注入进来的 user 消息（`session-channel` / `rule-engine`）走渲染与模型输入，**不会**被当作命令执行。

⇒ 「向会话投递 `/loop tick` 这类文本」在 TUI 里只是一句话，不会触发命令。要真执行命令，只有 `ctx.commands.execute(agent, line, …)`（进程内）这一条路；进程外形态没有对应面。

### 4. 进程外路径（形态 B 的选项）

- `session-channel`（Redis + unix socket）：投递到**某个 dsh 进程里活着的会话**；`session-channel/docs/DESIGN.md` §3 载明离线策略是**直接报错、不做 spool**（故 `send` 到未运行会话返回 `target_offline`），消息留在流里等目标会话下次运行再投（游标无 TTL、失败不推进游标 → 可补投）。它**不能唤醒冷会话**；
- `dsh-headless`（`dsh --help` 的 `dsh headless "run the tests"`；`安装树/dsh-headless/README.zh.md`）：一次性任务，`--session-id` 可**沿用精确会话**（未知 id 直接失败）、`--json` 出行级 JSON 事件流、退出码 0/1、进程不监听端口、跑完即退。约束：① 会话写者唯一（`session/writer-held` / `SessionAlreadyOwnedError`，会话被 TUI 打开时另一写者失败）；② slash 命令是客户端表层能力，headless 只能收提示文本。

### 5. 相邻件：herdr 窗格代理（**另立插件**，不在本设计范围）

用户 2026-10-15 指示「考虑通过 herdr 接口打开一个窗口并启动 agent」，同日裁定该能力**做成另外一个插件**。本设计只为将来协作留分工与两条关键事实（细节由那个插件自己的任务文档承载）：

- 起 dsh 的窗格不能走 `herdr agent start`（其 `--kind` 的 25 种取值**不含 `dsh`**），要走 `herdr pane split` + `herdr pane run <pane> dsh --profile <p>`；窗格里的 dsh 要被 `herdr agent prompt` 认到，依赖同窗格挂载本仓 `herdr-integration`（经 `pane.report_agent*` 上报身份）；整条路径需 `HERDR_ENV=1`（不在 herdr 内不可用）；
- 它起的是**新会话的新 agent**，与本守护「投给已有活跃 agent」不是同一件事（分工见「后续可选项」1）。

### 6. 仓内可复用件与既有惯例

- 落盘惯例（`metric-loop/src/persist.ts:2/95`）：JSON 状态文件、**原子写（tmp + rename）**、schema 版本；`memory-base` 走 `dbPath: !!js process.env.X || dshHomePath('…')`（`profiles/example/cordis.patch.yml:52-57`）；
- 可见性惯例：插件 `provide` 一个**只读查询面**，TUI 经 `ctx.get('<服务名>')` 取用（`TUI/src/app/adapter/types.ts:1717-1734` 的 `taskEngine` / `metricLoop` / `goalContract` / `sessionChannel` 四例，缺失时对应命令提示不可用）；插件侧 slash 命令经 `ctx.commands.register`（`command-template/src/main.ts:158` 先例，TUI 无需改动）；
- TUI 状态列是**固定四块** `Goal / Todo / Jobs / Agents`（`TUI/docs/SPEC.md:125/683`：内容在 `src/app/components/StatusColumn.ts` 构建 Box 树，带 L0-L3 折叠分级与 `tests/status-column-equivalence.test.ts` 等价性回归）→ 加第五块属 TUI 侧改造，不是插件单方面能落的事；
- 命令执行的安全复查分工（`metric-loop/README.md` 边界节）：命令来自**工具入参**时由 `security-guard` 的 `tools/pre-execute` 覆盖（`guardScope: "tool-args"`，引擎不重复判定）；命令来自**状态文件**时引擎内复查（`guardScope: "engine-side"`），复查不可用时 fail-open 但结果标 `guardSkipped: true` 且 summary 写明。守护的「执行命令」类任务属后者。

### 7. 证据边界（未复验项，如实记录）

- `dsh --profile fff --dump-config` 在沙箱下**未能产出**：命令退出 1，stderr `EROFS: read-only file system, open '/home/guochang/.dsh/profiles/fff/cordis.yml'`（该命令要写 profile 目录）。故本节挂载面结论以 `docs/host/HOST-PACKAGES.md`（2026-10-06 按 `--dump-config` 与 `disabled` 判定细则实测）+ 本机 profile patch 直读为据，**未**在本次用组合树二次复验；
- 宿主包结论均来自安装树源码 / README 直读，未实机挂载 `schedule` 试投（挂载会改本机 profile，超出本任务范围）。

### 8. 三件功能的既有覆盖矩阵（用户 2026-10-15 问：仓内已开发 / 宿主提供的插件已覆盖哪些）

把本守护拆成四件（用户列的三件 + 藏在后面的「投递」）逐个查现成件：

| 功能 | 仓内已开发 | 宿主**已挂载** | 宿主已装**未挂载** | 覆盖结论 |
| --- | --- | --- | --- | --- |
| **定时**（timer 原语） | 无公开面：TUI 的 1s `StatusTicker`、`session-channel` 的心跳 TTL 刷新都是内部实现, 未抽成可复用面 | **`cordis-plugin-timer`** → `ctx.timer` / `ctx.timeout()` / `ctx.interval()` / throttle / debounce（fiber 绑定、卸载自动释放） | — | **已覆盖, 直接用**（D16）；自建只剩「分段 / 重算 / 补算」 |
| **调度**（时间语义 + 触发决策） | `metric-loop`（模型驱动 `tick` + plateau 收敛, **无 timer、无日历**）；`task-engine`（帧状态机 + 执行后端, **非时间维度**）；`rule-engine`（事件触发, 非时间） | `goal-round-driver`（agent 空闲**事件**驱动续轮）；`tool-ralph`（前台循环, 且 `disabled`）；`jobs-local` + `tool-jobs`（进程内后台作业 + `job_output` / `job_list` / `job_kill` —— **作业面, 非时间面**） | **`schedule`**：六种选择器 + cron + 单宿主定时器 + 重算 + 分段 + 只补最近一次（时间调度覆盖度最高的现成件） | **时间调度无现成可用**：`schedule` 不可用（D3 / D14）, 其余件都不是时间维度 → 这块自建（选择器 / 单 timer / 补发） |
| **任务记录**（任务定义落盘 + 运行历史 / 回执） | `metric-loop` 的 JSON 状态文件（原子写 + schema 版本）；`session-channel` 的 Redis 任务表（委托任务 + 结果, TTL 7 天）；`task-engine` 的帧（会话内, 非进程级持久） | **`storage-domain` + `storage-json`**：schema 校验 + 可发事件的 KV 域 + JSON 文件后端（路由按域配置）；agent **inbox 持久化投影**（`next-turn` / `next-step` = 待投递消息的持久记录）；`session-query-sqlite`（会话日志查询 = 历史）；`jobs-local`（进程内作业记录, 不持久） | `schedule` 的 `lastDelivery` + `deliveryHistory`（回执 + 有界历史 30 天 / 200 条） | **底座已有, 记录模型没有**：持久化底座可复用（~~`storage-domain`~~ —— **2026-10-17 改判: 底座走本仓 `memory-base` 的注册 kind（D19）**, 原 `storage-domain` 方案见 D17 的撤销记录与调研 §10）, 但「任务定义 + 下次目标 + 回执 + 有界历史」这套模型没有现成件 |
| **投递**（用户未列, 但它是本守护的目的） | `session-channel`（跨进程投递, 离线不 spool）；`herdr-integration`（只上报状态, 不投递） | `agents.followup` / `steer` / `inject` + `sessions.flush`（L2 确认）；`commands.find` / `execute` | `schedule` 的投递链（`sessionController.resolveAgent` + 冷恢复） | **已覆盖**（进程内投递 + 确认 + 命令执行） |

**缺口清单（= 覆盖矩阵的补集：这些必须自己建）**

| 缺口 | 归属 | 为什么现成件顶不上 | 可复用的零件 |
| --- | --- | --- | --- |
| 1. 时间语义层：选择器校验 / 规范化 / 求下次触发 / DST 缺口跳过与重叠取早 | core | 宿主 `schedule` 的纯函数虽已导出, 但引它 = 本仓首个宿主运行时依赖 + 钉死 `0.2.0-rc.2` 内部导出（D4）；其余件完全没有时间语义 | `Intl.DateTimeFormat`（IANA 时区） |
| 2. 目标时刻表：`next` 推进 / 只补最近一次 / 一次性过期 → `missed` / 同批合并 | core | 这套「补发口径」只有 `schedule` 有, 而它拿不到（D3） | — |
| 3. 单 timer 驱动：分段（超平台上限约 24.8 天）/ 到期重读墙钟 / 回拨重算 / 变更后重算 / 启动补算 | core | `cordis-plugin-timer` 只给原语, 不管这五条 | `ctx.timer` / `ctx.timeout()`（已挂载, D16） |
| 4. 任务表模型 + schema：选择器记录 / payload / 目标会话 / 状态 / `lastDelivery` / `durable` 标记 | core | 底座已有（~~域 + JSON 后端~~ → **2026-10-17 改判: `memory-base` 的注册 kind + SQLite, D19**）, 但**记录模型**没有现成件（宿主 `schedule` 的模型拿不到） | `memory-base` 的 `registerKind`（kind + 扩展列 + `preWrite` 钩子） |
| 5. 渠道缝 + 记账状态机：`registerChannel` / 按返回码记账（**不重试**, 2026-10-17 裁定）/ `failed` 与 `missed` 区分 | core | 宿主无对应物（`schedule` 失败只记日志、不重试） | 退避口径可照 `metric-loop` 的既有写法 |
| 6. 两条投递渠道的编排：**文本**（消息构造 + `followup` + 推迟宏任务 + `flush` 确认 + 同批合并）与**命令**（`find` 未命中不降级 + `execute` + 引擎侧 guard 复查） | deliver | 宿主只给原语, 「编排 + 确认 + 失败码」要自己写 | `agents.get` / `followup` / `sessions.flush` / `commands.find` / `execute`；guard 复查照 `metric-loop` 的 `guardScope` / `guardSkipped` 口径 |
| 7. 可见性与日志：`/daemon` 六子命令 + 只读服务 `ctx.daemon` + JSONL Journal（有界轮转） | core | 宿主无对应物（`schedule` 只有 Web 页 + `schedule/changed`） | `ctx.commands.register`（先例 `command-template`）；TUI 侧读 `ctx.get('<服务>')` 的既有惯例 |

**划出去的不是缺口**（要分清, 免得当成待补）：冷会话恢复投递（D5）、进程外触发 / 常驻（形态 B, D2）、唤醒其他代理与开窗起 agent（herdr 另立插件, D12）、TUI 状态列第五块（D7 后续）、模型侧工具面（`schedule_create` 等价物 —— 2026-10-17 裁定**进首期**, 不再是后续可选项）、shell / 作业调度（§G 非目标）。

**一句话结论**：四件里**两件半已有底座**（定时原语、持久化底座、投递与确认）, 唯独\*\*「时间语义 + 目标时刻表 + 补发」这一层没有现成件\*\*（唯一有的 `schedule` 因投递语义与依赖面不可用）—— 这正是自建内核仍然必要的理由, 也是把内核做小的理由：只做那一层, 其余复用。

条目验收①要求的逐项对照（括号内为证据来源，节号指本文件「调研」节）：

| 维度 | A 进程内插件（推荐） | B 独立常驻进程 |
| --- | --- | --- |
| 生命周期与存活边界 | 随 dsh 进程；**dsh 退出即停**；重启后靠任务表恢复（④ 的字面要求即「dsh 重启后恢复」） | 自行常驻（systemd 用户单元 / nohup）；dsh 不在也能触发 —— 这是它唯一的独占价值 |
| 触发面 | 进程内定时器：受事件循环阻塞影响（`session-channel` 首连假超时即此机制所致），故须「单 timer + 分段 + 启动补算」 | 自带调度循环，不受 dsh 阻塞影响；但要自己处理休眠 / 挂起 / 时钟跳变 |
| 投递路径 | 原生：`ctx.agents.get(sessionId)` 命中**本进程活跃 agent** → `agent.followup` + `sessions.flush`（§2、设计 §B）；无活跃 agent 时不投（D5） | 二选一：`session-channel`（§4，要求目标会话在**某个** dsh 进程活着，离线直接报错、不做 spool）、`dsh headless --session-id`（§4，起子进程；会话被 TUI 持有时写者冲突即失败） |
| slash 命令能力 | `ctx.commands.execute` 真执行（§2） | 无对应面：headless 只能收提示文本（§4），而注入文本在 TUI 也不会被当命令执行（§3） |
| 可见性与日志 | `ctx.commands.register` 出 `/daemon` + provide 只读服务，**零 TUI 改动**（§6）；日志自持 JSONL + 有界轮转 | 日志自持；TUI 要看到它得读文件或经 Redis，多一层胶水；`/daemon` 这类命令面需另做 |
| 持久化与重启恢复 | 自持 JSON 任务表（原子写 + schema 版本），dsh 启动时恢复（§6 惯例） | 自持存储；任务恢复与 dsh 无关，但**投递**仍要等某个 dsh 起来（本质问题没解） |
| 失败恢复 | 自持记账（**不重试**, 2026-10-17 裁定）+ `missed` 可见；与投递同进程，`flush` 结果可直接判定成败 | 结果靠子进程退出码 / Redis 回执，判定链更长；且官方 schedule 的教训是「失败只记日志不重试」—— 任一形态都得自己写重试 |
| 依赖与挂载影响 | 新包 + profile 行；复用已挂载 `agents` / `sessions` / `commands` / `storageDomain`；**不需** Redis、**不需**解禁宿主 schedule（§1） | 新进程 + 投递侧依赖（Redis 服务，或 headless 侧 app 入口 —— `fff` 是 TUI 组合，跑 headless 需另建 profile 或 patch app 入口，**未验证**） |
| 运维面 | 无新增（随 dsh 启停，用户已有的启停习惯不变） | systemd 单元 / 日志轮转 / 崩溃拉起 / 端口或 socket 冲突排查 —— 本仓首个需要常驻治理的件 |
| 安全边界 | 投递即 user 消息，工具面照常过 `security-guard` + approval（D9）；命令类走 engine-side 复查 | 策略同样在 profile 内（headless 用「与其它表层相同的安全默认值」），但无人值守时审批无人应答的概率更高 |

**推荐 = A**，理由见 D1；B 的保留价值与触发条件见 D2 与「后续可选项」2。

### 9. 同类产品对照（2026-10-15 用户问: 类似产品有哪些, 它们都是怎么设计的）

查证口径: 只写读到官方文档原文的机制, 各条来源见本节末; 未读到原文的标「未复验」。目的不是罗列产品, 而是回答「本设计要的四件事, 别人已经定过哪些口径」。

**结论先行**: 同类产品分四派, 共性都是「到点**新建一个执行单元**」（起进程 / 建 Pod / 起工作流执行 / 起 runner）, 没有一派的语义是「投给**已存在的活跃会话**」。因此可直接借用的是「错过 / 迟到 / 重叠 / 暂停 / 历史有界 / 可见性」这六件事的既定口径, 而「无活跃目标怎么办」必须自定 —— 与 D5 的判断一致, 也说明这一块没有现成产品可抄。

**四派**

1. **系统级定时器**
   - **`systemd.timer`**: `OnCalendar=` 日历表达式; `Persistent=true` 把上次触发时间落盘, 停机期间错过的在激活时立即补一次; 睡眠期间连续错过多次仍只激活一次; `AccuracySec=` 缺省 1 min（合并唤醒省电）、`RandomizedDelaySec=` 打散削峰、`FixedRandomDelay=` 让抖动跨重启稳定; `DeferReactivation=` 处理「服务跑得比间隔久」时下一次的基准。
   - **`cron` / Vixie 方言**: 五字段 + 步长（`0-23/2`、`*/2`）+ `@daily` 等宏; cron 本身**不补做**。
2. **作业调度库**
   - **Quartz**: misfire 概念最完整 —— 持久 trigger 因**调度器停机**或**无空闲线程**而错过即 misfire, 启动时扫描全部 misfired trigger, 按每条各自的 misfire instruction 处理（缺省 smart policy）; 另有 `HolidayCalendar` 排除假期、trigger priority。
   - **APScheduler**: `misfire_grace_time`（迟到多久仍触发, 可连续触发多次）+ `coalesce`（多次错过合成一次）+ `max_instances`（缺省 1, 上一轮未结束则新一轮算 misfire）; `pause` 会清空 next; jobstore 持久化（官方推荐 SQLAlchemy + Postgres 以求强完整性）; `shutdown(wait=…)`。
   - **Celery beat**: 纯 tick 驱动; 必须在本地文件 `celerybeat-schedule` 里记 `last_run_at` / `total_run_count`; 官方要求同一 schedule 只跑**一个** beat, 否则重复投递; 只到点投递, 无回执与重试; 时区变更会自动重置 schedule。
3. **集群 / 云调度**
   - **K8s CronJob**: `startingDeadlineSeconds` = 迟到窗口, 超过则跳过该次（控制器每 10 秒检查一次, 该值小于 10 秒可能不调度）; `concurrencyPolicy` = Allow / Forbid / Replace; `suspend` 暂停, **暂停期间的执行算 missed, 解除且未设 deadline 时立即补**; 历史保留 successful 3 / failed 1; `timeZone` 字段（不支持 `CRON_TZ`）; 错过次数超 100 直接拒绝启动并记错误; 文档明确要求作业**幂等**, 因为调度是近似的、可能重复或漏跑。
   - **GitHub Actions `schedule`**: 只在默认分支跑; 公共仓库 60 天无活动自动禁用; 不支持 `@daily` 等宏; 高负载时定时事件会延迟、排队作业可能被丢弃; 通知发给最后改 cron 的人。
   - **GitHub Agentic Workflows**: markdown 正文 + YAML frontmatter（`on` / `permissions` / `safe-outputs` / `engine`）, 编译成 lock 文件由 Actions 触发, 示例即 `on: weekly on monday`; **无人值守的写权限用 `safe-outputs` 白名单声明**。
4. **持久执行 / 工作流引擎**
   - **Temporal Schedules**: Spec（interval + phase offset, 或 calendar JSON; IANA 时区; jitter; 排除日历）+ Action + Pause（暂停后仍可手动 trigger）+ Overlap Policy（Skip 缺省 / BufferOne / BufferAll / CancelOther / TerminateOther / AllowAll）+ Catchup Window（缺省一年, 最小 10 秒, 超窗不补）+ Backfill + Action 次数上限 + pause-on-failure + last completion result / last failure。
   - **Trigger.dev / Inngest 类**: cron 任务 + 重试 / 并发 / 面板可观测（Trigger.dev 文档页被导航截断, 细节**未复验**）。
   - **未复验**: Airflow 的 catchup / backfill 口径; ChatGPT Tasks 与 Manus 一类云端 agent 的定时任务（OpenAI 帮助页返回 403）—— 只作类别提及, 不进对照结论。

**对照本设计**（只列有决策含义的差异）

| # | 主题 | 同类口径 | 本设计 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | 投递目标 | 一律「到点新建执行单元」 | 只投已存在的活跃 agent（D5） | 无同类可抄; 最接近的其实是 IM 定时消息; 宿主 `schedule` 的「到期恢复冷会话」才是同类口径 |
| 2 | 迟到窗口 | `misfire_grace_time` / `startingDeadlineSeconds` = 迟到多久还算数 | `graceMs` = 等活跃 agent 出现 | **建议改名**（如 `awaitAgentMs`）: 把 misfire 语义留给「补发窗口」, 否则读者会按 APScheduler 的口径理解 |
| 3 | 暂停期间到点 | K8s: 算 missed, 解除后立即补; Temporal: 不补, 但可 Backfill / 手动 trigger | 未写 | **待裁定**: 建议记 `missed` 且不补（暂停期间投递目标可能已变） |
| 4 | 抖动 | systemd `RandomizedDelaySec` / Temporal jitter | 无 | 列后续可选项（任务量小, 首期不需要） |
| 5 | 重叠策略 | Temporal Overlap Policy / K8s `concurrencyPolicy` / APScheduler `max_instances` | 无（投递不长跑） | 显式写一条非目标; 「同会话同批合并」是本设计与宿主 `schedule` 独有的优化 |
| 6 | 失败重试 | Celery beat 与宿主 `schedule` 不重试; Temporal / Trigger.dev 有 | **不重试**（2026-10-17 裁定）: 失败只记流水 | ✓ 与前者同族（Celery beat / 宿主 `schedule`）, 无退避参数 |
| 7 | 无人值守写权限 | gh-aw 用 `safe-outputs` 声明式白名单 | 不降级策略 + 引擎侧 guard 复查（D9） | 可叠加: 命令渠道加「允许的命令名白名单」作前置声明, 复查只兜底 |
| 8 | 幂等 | K8s 明确要求作业幂等 | at-least-once（flush 失败不重投, D13） | 在任务正文与文档写明「可能重复投递」 |
| 9 | 历史有界 | K8s 3 / 1; 宿主 `schedule` 30 天 / 200 条 | Journal 条数上限 + 轮转 | 缺省值向宿主看齐（200 条）, 避免两套口径 |
| 10 | 存储 | celerybeat 的 shelve 文件（时区变更即重置）; APScheduler 推荐关系库; K8s 存 etcd; 宿主存 storage domain 且损坏拒启 | ~~D17 = 改用宿主 `storage-domain`~~ → **2026-10-17 改判 D19 = 用本仓 `memory-base`**（旁证: 主流做法是「库 + 校验」, 而它对权威数据要补 durable 豁免） | △ 换底座后此条不再是「与主流一致」的旁证, 改为需补的四项豁免 |
| 11 | 可见性 | `systemctl list-timers` / `crontab -l` / Temporal UI 至少给「下次触发 + 上次结果」 | `/daemon list` 的 next + lastDelivery | ✓ 字段口径一致, 无需改 |

**来源**（2026-10-15 直读原文）: [systemd.timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)、[Quartz Lesson 4](https://www.quartz-scheduler.org/documentation/quartz-2.3.0/tutorials/tutorial-lesson-04.html)、[APScheduler User guide](https://apscheduler.readthedocs.io/en/3.x/userguide.html)、[Celery Periodic Tasks](https://docs.celeryq.dev/en/stable/userguide/periodic-tasks.html)、[K8s CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)、[GitHub Actions schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[GitHub Agentic Workflows](https://docs.github.com/en/copilot/how-tos/github-agentic-workflows/creating-github-agentic-workflows)、[Temporal Schedule](https://docs.temporal.io/schedule)、[Trigger.dev Scheduled tasks](https://trigger.dev/docs/tasks/scheduled)。

### 10. 记录底座的两条候选对比（2026-10-17 用户问「storage-domain 的定位是什么 / memory-base 能不能做 schema 校验」后补）

**`storage-domain` 是什么**（`安装树/dsh-storage-domain/README.zh.md` 直读）：宿主给各插件准备的**小型权威状态标准存放处** —— 所属包用 `defineDomain` 声明一次（域名 + 版本 + zod 记录 schema）, 消费方 `open()` 后同步读内存状态、写入在 resolve 前落盘、每次写入发一条 `domain/changed`。打开时**逐条校验已存记录**, 不符报 `invalid-record`（指明表与键）= 损坏拒启。它不是数据库：无检索、无排序聚合、无 TTL 与淘汰, 且**宿主侧状态不进提示词与会话事件, 模型看不到**。介质由后端决定, 随包分发的只有 `storage-json`（`root` 是插件级唯一配置, 后端名硬编码 `json`, 重复注册报 `duplicate-backend` → 一个 root, 表达不了 memory-base 的三处作用域根）；`storage-sqlite` 官方源码有但**不随包分发**（`docs/host/HOST-PACKAGES.md:480`）。

**`memory-base` 已有的 schema 能力**（仓内代码直读, 读者常误以为它没有）：① 库级指纹与版本 —— `application_id`（按层 `SESS` / `PROJ` / `USER`）+ `user_version`, 指纹不符 / 非空非本应用库 / 版本无迁移 → 拒绝打开（`memory-base/src/schema.ts:310-352`）；② 表级 DDL 强制 —— 分类表与基表 `) STRICT`, 基类列 NOT NULL, `CHECK (importance BETWEEN 1 AND 5)`、`status` / `promotion_state` 的 CHECK 枚举（`schema.ts:93`、`:159`、`:229`、`:281`）；③ 注册制闸门 —— `kind` 未注册拒写, 写前钩子 `preWrite` 返回 `KindVerdict`（`router.ts:82-120`）, 另有隐私底线与 `content_hash` 去重；④ 建表即挂 FTS5（porter）+ trigram 两套虚表与三支同步触发器（`schema.ts:180-205`）。

**与 storage-domain 的真实差距只有三条**（都不涉及「能不能」，而是时机与真源）：① **存量行级校验** —— storage-domain 打开时遍历校验每条记录, memory-base 靠写入那一刻由 SQLite 强制, 存量被外部改坏不会在打开时查出；② **声明式单一真源** —— `defineDomain` 的 zod schema 同时是运行时校验器与 TS 类型, 而 memory-base 的 `KindColumn` 只有 `{name, type}`（`router.ts:82-85`）, 扩展列表达不了 NOT NULL / CHECK / 默认值, 也没有「这条记录合规吗」的运行时可调用对象（全仓现无 zod 依赖, 引它破零依赖, 或扩 `KindColumn` + 自写校验）；③ **坏行策略与可观测** —— storage-domain 是「打开即失败」, memory-base 需为权威 kind 定义策略（拒绝打开 / 隔离 + 计数告警）。另有两点已知缺席：变更事件（全仓无 `ctx.emit` 命中）与 durable 免淘汰。

| 维度 | storage-domain（宿主包, 不可改） | memory-base（本仓包, 可改） |
| --- | --- | --- |
| 定位 | 宿主侧小型权威状态（工作区记录、会话伴随元数据、宿主 schedule 的任务行） | 分层作用域记忆库（S 会话 / P 项目 / U 用户）, SQLite |
| 记录模型 | 几十条状态机记录 ✓；append 型流水 ✗（single 每次重写整份文件, per-record 则每条一文件） | 表 + FTS5 检索, append 型合适 ✓ |
| 分级 / 作用域 | 只有「域」, 无作用域与寿命语义 | S / P / U 现成: 路径、寿命、上限、可见范围齐备 |
| 权威性 | 打开时逐条校验 + `version-mismatch` 拒绝 | 库级指纹 + STRICT + CHECK + 注册闸门；缺存量行级校验 |
| 变更事件 | `domain/changed` ✓ | 无（需补） |
| 容量 / 寿命 | 无上限、无淘汰、无 TTL | S 降级压缩 + P 容量淘汰 + U 只告警；权威 kind 需 durable 豁免 |
| 检索 / 可见面 | 仅表级 get / keys / size / put / update / delete；模型不可见 | 跨层检索 + `/memory` + 模型可见 |
| 写入闸门副作用 | 只校验 schema | 隐私形态扫描会拦含密钥类正文；`content_hash` 去重会把同正文两条任务合并 |

**结论（2026-10-17 用户裁定）**：记录底座走 **memory-base**（D19）；上面第二条「真相源」与第三条「坏行策略」, 连同「取消严格提升策略」「durable 免淘汰」「变更事件」一起, 作为 memory-base 侧的配套改动列出。storage-domain 不再参与本设计。

## 决策

决策项 = 数字，选项 = 字母（选定项写明字母与理由）。

- **D1 形态：选定 (a) 进程内插件（逐项对照见上节表）。** 选项：(a) 进程内插件（复用宿主会话与命令服务）；(b) 独立常驻进程（自带调度循环）；(c) 进程内 + 进程外触发器混合（首期只做前者）。理由：① 四项能力里的三项半都直接落在已挂载服务上（§2），投递、命令执行、安全复查全有原生路径；② 不新增运维面（无 systemd 单元、无日志轮转、无「dsh 不在也被拉起」的进程治理）；③ 可见性可走仓内既有「插件只读服务 + `ctx.commands.register`」惯例，首期零 TUI 改动；④ 失败恢复与日志在本仓可控（宿主 schedule 不重试，形态 B 要自己再写一遍）。代价必须在文档里说清：**dsh 进程退出即停**，这正是形态 (b) 的独占价值（见 D2）。
- **D2 形态 (b) 的处置：选定 (b) 降为后续可选项，不在首期。** 选项：(a) 首期并列做两形态；(b) 降为后续可选项；(c) 首期直接选形态 (b)。理由：形态 (b) 的独占价值只有一条 —— 「dsh 不在运行时也能触发」。为这一条要付出：另建 headless 侧 profile 或给 fff 加 app 入口 patch（未验证）、每次投递起一个进程、会话写者冲突、slash 命令能力缺失（§3/§4）、以及进程治理运维面。条目首期范围里「唤醒其他代理」本就列在后续，形态 (b) 与之同族，一并缓做更合口径。
- **D3 与宿主 `schedule` 的关系：选定 (b) 自建调度内核 + 语义对齐（2026-10-15 用户明确「还是自己写吧」→ 复用路径关闭）。** 选项：(a) 解禁并复用宿主 schedule 行；(b) 自建内核，语义（选择器 / cron 方言 / 补发 / DST 规则）以宿主为基线；(c) 混合（用宿主 `ctx.schedule` 排期、自建投递）。理由：(a) 在 TUI 组合下投不出去（§1），拉 Web 控制器整套与「只用 TUI」口径冲突；(c) 看似折中，实则两头都要（既有宿主注入要求，又要自建投递），且宿主 `ScheduleService` 不暴露「只排期不投递」的缝；选 (b) 后若将来 profile 真解禁宿主 schedule，需按「同一目标不叠两条调度链」处理（对齐 `metric-loop` 对双循环的口径）。
- **D4 cron 与时间语义的实现来源：~~选定 (a) 自研最小五字段 Vixie 子集 + `Intl` 时区计算~~ —— 不适用（2026-10-17 裁定: cron 不进首期, 本条自动消失; cron 列后续可选项）。** 以下为历史记录: 选项：(a) 自研；(b) 直接 import 宿主 `dsh-schedule` 的纯函数导出（`createCronScheduleRecord` / `canonicalizeCronExpression` / `resolveCronOccurrence` 等确实已导出）；(c) 引第三方 cron 库。理由：(b) 会把本仓首个「运行时依赖宿主包」引进来（现状：全仓无任何包依赖 `@deepseek-ai/*`，仅 `profiles/example/package.json` 依赖 bundle），并钉死 `0.2.0-rc.2` 的内部导出；(c) 多一个依赖但省实现，留作备选；(a) 范围可控（宿主方言只有 `*` / 单值 / 范围 / 步长 / 逗号列表，且明确拒绝 `L` `W` `#` 名称与宏），配合 `Intl.DateTimeFormat` 即可覆盖 IANA 时区与 DST 缺口 / 重叠规则。**裁量点**：(a) 的实现量（约 200-300 行 + 测试）与 (c) 的依赖引入，二选一留给接取实现条目时按当时依赖策略定。
- **D5 投递目标模型：选定 (a) 只面向「已有活跃 agent」，无活跃 agent 时不投、不唤醒。** 选项：(a) 只管已有活跃 agent（用户 2026-10-15 指示「只关心已经有活动的 agent 后要怎么安排」）；(b) 冷会话用 `ctx.agents.resume` 恢复后投递；(c) 冷会话经 headless 子进程投递 / 或经会话通道跨进程等它上线。理由：投递原语 `agent.followup` 只对**本进程已注册**的 agent 有效（§2），(b) 要额外承担「恢复出的 agent 用哪套组合、由谁 `dispose`、与 TUI 稍后打开同一会话时的写者冲突（`session/writer-held`）」；(c) 起新进程 / 跨进程投递是**另一件事**（唤醒），已按用户裁定另立插件（D12）。无活跃 agent 时的行为（条目裁定项③）定：标 `skipped`（原因 `no-active-agent`）并记日志、`/daemon` 可见；可配宽限窗口 `graceMs`（缺省 0 = 不等待，>0 时在窗口内随下次 tick 重试）。行为口径见设计 §B。
- **D6 「发布命令」的两条通道：选定 (a) 文本投递 + (b) `ctx.commands.execute` 并列支持，语义分开。** 选项：(a) 只投文本；(b) 只执行命令；(c) 两者都支持。理由：§3 已证注入文本**不会**被 TUI 执行成命令，若只做 (a)，条目字面上的「slash 命令」实际落空；`ctx.commands.execute` 是「不发给模型、直接执行」的正路（`dsh-commands` 明确如此），代价是命令必须在目标 agent 的命令作用域内可见（`find(agent, name)` 未命中即失败）。
- **D7 可见性首期落点：选定 (a) 插件侧 `/daemon` 命令 + 只读服务，状态列块列后续。** 选项：(a) 仅 `/daemon` + 只读服务；(b) 同时加 TUI 状态列第五块；(c) 只落日志文件，不做命令面。理由：`ctx.commands.register` 零 TUI 改动（先例 `command-template`），而状态列是**固定四块**且带折叠分级与等价性回归（§6），属 TUI 侧独立条目；只做 (c) 则「可见性」不合格（用户看不到）。
- **D8 任务定义落盘：~~选定 (a) JSON 文件 + 原子写 + schema 版本~~ —— 已被 D17 取代（2026-10-15）**，改走宿主 `ctx.storageDomain` 的域（后端仍是 JSON 文件, 但 schema 校验 / 原子落盘 / 损坏拒启由底座保证）。原选项：(a) JSON（对齐 `metric-loop`）；(b) SQLite（对齐 `memory-base` / `output-compress`）。原理由：任务量级是「几十条」而非「可检索数据集」, 无需 FTS / 事务跨表；JSON 可直读排障, 原子写已有先例可抄 —— 该理由仍成立, 故 D17 的后端仍选 JSON 家族（`storage-json`）。
- **D9 无人值守的权限边界：选定 (a) 不降级任何策略 + 命令类任务走 engine-side 复查 + 审批挂起可见。** 选项：(a) 三者齐；(b) 只做「不降级策略」；(c) 守护自持白名单、绕过 guard。理由：条目裁定项④要求写清边界；(c) 直接违反 `security-guard` 的定位；`metric-loop` 的 `guardScope` / `guardSkipped` 口径可直接复用，避免第二套复查语义。
- **D10 文档落点：选定 (a) 追踪文档与设计文档合一。** 选项：(a) 合一（本文件）；(b) 追踪文档 + 独立设计文档两份。理由：条目「落点（预估）」写的是 `docs/implementation/<日期>-background-daemon-design.md`，与本流程的追踪文档目录一致；`llm-router` 先例（`docs/archived/2026-10-11-llm-router-decision.md`）同为一文件承载调研 + 决策。定稿后如需长期留存，待实现阶段落新包 `docs/DESIGN.md`。
- **D11 BACKLOG 条目状态标记：选定 (a) 原地标记，不重排不重编号。** 选项：(a) 原地（条目尾部 `〔待办: …〕` → `〔进行中: 2026-10-15〕`）；(b) 按「〔进行中〕置顶」重排 §2 并重编号。理由：`docs/WORKFLOW-STANDARD.md` §3 的置顶要求挂在「每次整理时」的排序口径下，而本次不是整理；`docs/BACKLOG.md` 是三个并行 worktree（另有 `md-table-guard` / `tui-focus-layout`）共写的文件，重排会放大冲突面。若用户认为应守置顶口径，改回 (b) 即可（成本 = 一次重排 diff）。
- **D12 herdr 窗格代理的归属：选定 (a) 另立插件，本设计不含。** 选项：(a) 做成另外一个插件（用户 2026-10-15 裁定）；(b) 作为本守护的一条投递通道；(c) 不采纳。理由：该路径的语义是**起一个新会话的新 agent**，与本守护「投给已有活跃 agent」（D5）不是同一件事；做成独立插件可各自验收、各自持有依赖（它要 `HERDR_ENV=1`，本守护不需要）。本设计只保留分工与两条关键事实（调研 §5），将来若该插件暴露服务面（如「起一个带提示的 agent」），本守护的「唤醒其他代理」（后续可选项 1）可调用它，但两者独立开发。
- **D13 投递确认与 flush 失败策略：选定 (a) 以 `flush()` 为成功判据；flush=false 记 `delivered` + `durable:false` + 告警，不自动重投。** 选项：(a) 如上；(b) flush=false 即重投（严格 at-least-once，配 `retryOnFlushFailure`）；(c) 以 `followup()` 返回为准（单向发送，不确认）。理由：(c) 拿到的是 L0，等于不确认；(b) 与「消息已在收件箱、多半会被执行」冲突，重投的重复代价高于丢一次告警；(a) 与宿主 schedule 的 L2 判据一致，但比它多一条显式告警（宿主此处只记日志）。**(b) 的开关已由用户 2026-10-15 否决**（「不用，有机制保证送达即可」）：只保留 L2 确认，不引入 `retryOnFlushFailure`。
- **D14 「挂载宿主 schedule」的处置：~~选定 (c) 立为实现阶段第 0 步的挂载试验（spike）~~ —— 已关闭（2026-10-15 用户裁定「还是自己写吧」，spike 不做）。** 下方记录的「Web 组合补课」与「`sessionController` 垫片」两条情报保留, 供将来别人重开评估时省一次调研。原选定： 选项：(a) 立即改为复用宿主 schedule（挂 `schedule` + `api-session-controller` + 缺失行）；(b) 维持全自建、不做试验；(c) 设计基线自建，但把「能否挂起来」的验证放进实现第 0 步，成功且用户愿意改口径时再切复用。理由：① 挂载可行性只有实测能定（上面三项服务存疑）；② **更要紧的是语义冲突** —— 宿主 schedule 的投递是「到期**恢复冷会话**并把提醒作为 follow-up 投进原会话」，与刚定的 D5「只面向已有活跃 agent、不冷恢复」**直接相反**，且它没有 slash 命令执行通道（D6 的第二条），所以「复用」不是省事而是**换口径**；③ 试验成本低（加几行 + 试投一次），失败即回退自建，不阻塞主线。**待用户确认：是否接受为复用而放松 D5（允许冷恢复投递）。**

**「直接挂宿主 schedule = 按 Web 组合补课」（2026-10-15 用户看出后确认）**：`schedule` 自身不是 Web 包, 它要的是 `sessionController`; 提供者是 `api-session-controller`（自述「Owns every operation that may create, resume, or configure a **Web Agent**」, 构造期还向 `ctx.typert.lookups/contexts` 注册远程查找面；其 `peerDependencies` 含 `client-connection` / `api-gateway` 等客户端面包）。要它起来, 得往 TUI 组合里补三类行：

| 缺的行 | 性质 | 与本仓既定口径的关系 |
| --- | --- | --- |
| `api-session-controller` | API 控制面（客户端 / 远程会话控制） | 2026-10-02 排除口径的「API 控制面 `api-*`」 |
| `client-file-upload`（`ctx.fileUploads`） | **浏览器专用**（浏览器文件上传 / 流式接收） | 排除口径的「客户端 UI `dsh-client*`」 |
| `attachment` / `fs` 两个缝（+ 各自本机后端 `attachment-local` / `fs-local` 的组合） | 通用缝包（非 Web 专用） | 排除口径的「缝包不挂」（会与已挂载的持有行重复注册同名服务） |

**第三条路：`sessionController` 垫片（spike 方案 B, 2026-10-15 查证后补记）**

`schedule` 的六个 inject 里, 本组合**只差 `sessionController` 一个**（`agents` / `sessions` / `tools` / `storageDomain` 已挂载；`sessionPersistence` 推断由已挂载的 `session-persistence-jsonl` 经继承持有 —— 该包 default 导出一个继承缝包服务基类的类, 与 `session-query-sqlite` 自持 `sessionQuery` 同款, spike 一并验证）。而它对 `sessionController` 的用法**全文只有一处**：

```js
// dsh-schedule/lib/index.js:1576（投递路径）
const resolved = await this.ctx.sessionController.resolveAgent(task.sessionId);
if ("error" in resolved) throw resolved.error;
… resolved.agent.followup(message) → ctx.sessions.flush(resolved.agent.session)
```

契约 = `resolveAgent(sessionId)` 返回 `{ agent }` 或 `{ error }`。因此可以**自己提供一个最小 `sessionController` 垫片**（几十行）：命中 `ctx.agents.get(sessionId)` 就返回 `{ agent }`；未命中**按 D5 返回 `{ error }`**（拒绝冷恢复, 于是宿主 schedule 的「到期恢复冷会话」在我们手里被关掉, 冷会话任务投递失败并按它的口径记日志）。这样 schedule 能在本组合启动并投递, **不必把 Web 组合搬进来**。

代价与风险：① 依赖**宿主内部实现契约**（它今天只调一个方法, 明天可能调两个）→ 必须在包 README 写明并立一条「宿主升级必查」条目；② 服务名 `sessionController` 被我们占用（TUI 组合里没有真控制器, 无冲突）；③ 即便走通, 命令执行通道（D6 第二条）仍没有落点, 可见性仍要自写。

**结论**：挂 `schedule` 不是加一行, 而是把 TUI 组合按 Web 组合补课 —— 与本仓 2026-10-02 的三条排除口径正面冲突；这正是自建内核（D1 / D3）在依赖面上的实质理由：自建只依赖**已挂载**的 `agents` / `sessions` / `commands` / `storageDomain` / `timer`, 新增挂载行数为 **0**。

**若选 (a) 复用, 本守护会缩成什么（2026-10-15 用户再问「能用宿主的吗」后补记）**：宿主的调度 / 时刻表 / 补发 / 任务表 / 回执 / 有界历史全归它（我们的缺口 1-5 省掉, 估时从 4-5 天降到约 2 天）, 我们只剩两件 —— ① 可见性薄层：`/daemon` 直接读 `ctx.schedule.catalog()`（全宿主任务 + 原会话 id）与 `history({sessionId,id,limit})`（投递记录）, 加 `schedule/changed` 刷新；② **命令执行通道没有落点** —— `schedule` 只投提示文本, 没有 `ctx.commands.execute` 的缝, 要保留「执行 slash 命令」就得另想路径（例如自建一条渠道, 但那就又变成两条调度链并存, 与 D3 的「不叠」口径冲突）。

- **D15 插件拆分：原选定 (A) 两包（`daemon-core` / `daemon-deliver`）—— 2026-10-17 裁定改为单包（见本条末尾）。** 原论证（2026-10-15 用户指示「将这些功能拆分成插件, 看看需要写几个」时给出）： 计数依据：缺口 7 项里, 1-5 与 7（时间语义 / 时刻表 / timer 驱动 / 任务表 / 渠道缝与记账 / 可见性与日志）共用一个状态中枢, 拆开只会互相引用 → 归 `daemon-core`；第 6 项（两条渠道）与内核**零共享**、依赖面也不同（`sessions` vs `commands` + guard）, 且要留出第三条渠道（herdr / headless）的插入点 → 单独一包 `daemon-deliver`。**不选 3 包**的理由：两条渠道各 150-250 行, 各背一套脚手架（`package.json` + `cordis.patch.yml` + tsconfig + tests + README + 根三处脚本接线 + `install.sh` 清单 + profile 两行）不划算, 包内按 `channels/text.ts` / `channels/command.ts` 分文件即可, 等第三条渠道落地再拆。**不选 4 包**：可见性与日志是内核的脸与账本, 拆出去只增胶水。**不选 1 包**：渠道缝事后抽取会动内核, 而第三条渠道迟早要来（herdr 窗格插件 D12 已存在）。原选定： 选项：(A) 两包；(B) 三包（两渠道再分）；(C) 四包（可见性 / 日志再拆）；(D) 单包内部分层。理由：见设计 §F —— 拆分主轴是「调度 vs 投递」（失败语义不同、可各自验收）, 渠道缝是第三条渠道（herdr / headless）的接入点, 内核借此不依赖 `commands`；C 属过度拆分（可见性与日志是内核的脸与账本）。代价 = 相对单包净增 1 个包（脚手架 + 三处接线 + install.sh 清单 + profile 两行）。**切法已裁定（2026-10-17）: 单包。** 过程: 用户先明确「没决定拆 2 个包」（更正本条旧记录）, 随后裁定**单包** —— 上面的「两包」方案作废, 仅作历史; 单包内部按 `selector` / `due` / `scheduler` / `records` / `deliver` 分模块。

- **D16 底层定时器复用宿主 `cordis-plugin-timer`（已挂载）：选定 (a) 用 `ctx.timer` 的 `timeout()` 作为唯一 timer, 自建部分只留「分段 / 重算 / 补算」。** 选项：(a) 复用 `ctx.timer`；(b) 自建 `setTimeout` 包装。理由：`cordis-plugin-timer` 的 `TimerService` 提供 `ctx.timeout(cb, delay)` / `ctx.interval(...)`, **fiber 绑定、插件卸载自动释放**（`lib/types/index.d.ts` 直读）, 正好覆盖我们「关闭时取消 timer / 不泄漏」的要求, 无需自己管 disposer；它只给原语, 平台定时器上限（约 24.8 天）与墙钟回拨仍须自建分段与重算 —— 这部分留在 Scheduler 里。

- **D18 「定时 / 记忆」两条复用边界的处置（2026-10-15 用户问「定时, 记忆这些可以拆分或者复用已有的吧?」）：~~选定 (a) 定时原语复用且不拆包、任务表持久化复用宿主 `storage-domain` 而**不复用 `memory-base`**~~ —— **记忆那半 2026-10-17 反转**（用户裁定「配合自己的 memory-base, 不走 storage-domain」, 见 D19）；「定时」那半不变。** 逐条：

  - **定时**：原语已复用宿主 `cordis-plugin-timer`（D16）；**不单独拆包** —— 剩下的「分段 / 回拨重算 / 启动补算」与任务表强耦合（要从表里算 next）, 约百行且只有本内核一个消费者。为将来留缝：选器与时刻表按**独立模块文件**（`src/selectors.ts` / `src/due.ts`）放, 若将来出现第二个消费者再从 core 抽出成包。
  - **记忆（持久化）**：~~走宿主 `ctx.storageDomain`（D17）；不用本仓 `memory-base`~~ —— **2026-10-17 用户裁定反转：记录底座改用本仓 `memory-base`**（D19）。原判断（权威数据 vs 可淘汰记忆的语义冲突：任务是「丢了就是没提醒」的权威数据, 而 `memory-base` 有降级压缩 / 容量淘汰 / 候选寿命）**不撤回, 降级为待解风险** —— 靠 memory-base 侧的配套改动消解（取消严格提升策略（用户 2026-10-17 明确）、durable 免淘汰、行级校验与坏行策略、变更事件）, 而不是靠换底座回避。
  - 一句话：**能复用的都复用掉了（timer / 记录底座 / 投递 / 命令 / 可见性通道 / 安全复查）, 剩下的两块（调度语义 + 渠道编排）才是自建** —— 包数待定（D15 更正）。

- **D17 任务表落盘底座：~~选定 (a) 改用宿主 `ctx.storageDomain`（域 + `storage-json` 后端），取代 D8 的「自写 JSON 文件 + 原子写」~~ —— 已撤销（2026-10-17 用户裁定「不走 storage-domain」, 由 D19 取代）。** 原理由（schema 校验 / 原子落盘 / 损坏拒启 / `domain/changed` 变更事件 / 与宿主 `schedule` 同款做法）随之作废, 仅作历史保留；两条候选的逐项对比见调研 §10。

- **D19 记录底座：选定 (a) 本仓 `memory-base` —— 任务与流水都以注册 kind 落它的库（2026-10-17 用户裁定「配合自己的 memory-base, 不走 storage-domain」）。** 选项：(a) `memory-base`；(b) 宿主 `storage-domain`（原 D17, 已撤销）；(c) 自写 JSON 状态文件（原 D8）。理由：直接获得分级作用域（S / P / U）、寿命、容量、跨层检索与 `/memory` 可见面, 且与「记忆」共用一套库。代价与前提 —— 权威数据进入一个「会降级压缩 / 会按容量硬淘汰 / 会做隐私形态扫描 / 按 `content_hash` 去重」的库, 必须由 memory-base 侧四项配套改动消解: ① **取消严格的提升（升级）策略** —— 注册方可声明不经候选与审阅直落目标层（用户 2026-10-17 明确）; ② durable 免淘汰; ③ 行级校验与坏行策略（拒绝打开 / 隔离告警）; ④ 变更事件（现状无 `ctx.emit`, `/daemon` 与将来 TUI 刷新只能轮询）。这四项**归 memory-base 模块的条目**, 本设计只写接口假设, 不直接改它。**已定（2026-10-17 同轮裁定）**: 任务按 **S / P / U 三档**; 运行流水**也入库且可搜索**; 创建入口两种（`/daemon` 命令 + 模型侧工具）。

- **D20 范围收窄：核心 = 定时执行 + 过程结果记录（2026-10-17 用户裁定）。** 「记忆」用 `memory-base` 现成面, 「编排（多代理建组 / 发言权 / 汇聚结论）与唤醒其他代理」移交 `peer-group` 插件 —— 本设计不再承载这两块, 只在触发侧留接口假设。逐项模块归属见设计 §H。

## 规划

任务拆分：

1. 调研（宿主 schedule 能力与可用性、本 profile 投递原语、进程外路径、仓内惯例）—— 已完成；
2. 决策（D1-D11）与设计正文 —— 本文件；
3. 用户裁定（形态 + D4/D5 两个裁量点）；
4. 裁定后：把实现条目登记进 `docs/BACKLOG.md`（草案见「待登记的实现条目」），本任务关闭并把本文件移入 `docs/archived/`。

计划改动文件清单（按顺序）：

1. `docs/BACKLOG.md` —— 所接取条目标「进行中」（关闭时标「完成」并按规范清理移除）；
2. `docs/implementation/2026-10-15-background-daemon-design.md` —— 本文件（追踪文档 + 设计正文）。

**明确不做**：① 不写任何实现代码、不新建包、不改 profile（含 `profiles/example/cordis.patch.yml`）；② 不动 `TUI/`（状态列块只在后续可选项里记名）；③ 不改 `docs/host/`（宿主面知识不参与本流程）；④ 不登记实现条目（待用户裁定形态后）；⑤ 不实机挂载宿主 `schedule` 试投。

## 设计：推荐形态（进程内插件）

### A. 组件与时序

```
/daemon 命令 + 模型侧工具（两者都进首期 —— 2026-10-17 裁定）
      │ 写入（任务表变更走单一 FIFO）
      ▼
  TaskStore（JSON 原子写 + schema 版本） ──▶ Journal（JSONL 追加 + 有界轮转）
      │ 变更 / 到期（单 timer + 分段 + 启动补算）
      ▼
  Scheduler ──▶ 解析目标 agent（ctx.agents.get）──▶ 渠道缝 registerChannel（D15）
                                                        │
  daemon-core      任务表 / 调度 / 渠道缝 / 记账 / 日志 / /daemon
                                                        │
                                                        ▼
  daemon-deliver   channel(text)    = agent.followup → sessions.flush（排队语义，§B）
                   channel(command) = commands.find / execute + guard 复查（立即语义）
      │
      ▼
  只读查询面 ctx.backgroundDaemon ──▶ /daemon 展示（后续：TUI 状态列块）
```

关键时序口径（逐条对齐宿主 schedule 的既定语义，便于将来行为一致）：

1. **单一 timer**：任何时刻至多一个待触发定时器；任务变更后重算（对齐宿主「重新计算后至多保留一个待触发定时器」）；
2. **补发**：周期任务只补发**最近一次**错过的发生时点（不是逐次补齐）；一次性任务过期且超过补发窗口 → `missed`（不静默丢弃）；
3. **时钟**：每次判定重读墙钟；检测到回拨则重算下一个目标；超过平台定时器上限的长延迟**分段**处理；
4. **同会话合并**：同一会话同一批到期的周期任务合并为一条消息投递（对齐宿主）；
5. **串行化**：所有任务表写入走单一 FIFO，避免「读-改-写」交错（对齐宿主的管理与投递共用一个 FIFO）。

### B. 投递目标模型与排布口径（只面向已有活跃 agent）

用户 2026-10-15 指示：本守护**只关心「已经有活动的 agent」时怎么安排**。本节即该口径。

**目标模型**

- 目标 = **本进程内已注册的活跃 agent**：`ctx.agents.get(sessionId)`（宿主 Web 控制器的 `liveAgent()` 即此调用，`dsh-api-session-controller/lib/index.js:372`）；
- 会话 id 是唯一寻址键；首期不支持别名 / `cwd:` 寻址（那是跨进程通道的能力，见「后续可选项」）；
- 未命中活跃 agent → **不投递**：标 `skipped`（原因 `no-active-agent`）、记日志、`/daemon` 可见；可配宽限窗口 `graceMs`（缺省 0 = 立即跳过；> 0 时在窗口内随下次 tick 重试）。**不做**冷会话恢复、不做跨进程唤醒（D5）。

**投递原语：三条路的权威语义**（`dsh-agent/lib/types/runtime-types.d.ts:184-210` 注释直读）

| 原语 | 语义要点（原文） | 首期 |
| --- | --- | --- |
| `agent.followup(msg)` | 「Queue an ordinary follow-up turn and wake the driver. The item becomes the **sole ordinary message of its own turn**」—— 独立回合 + 唤醒；目标正在跑时**排队到下一回合**，不打断当前回合 | **用** |
| `agent.steer(msg)` | 「Submit steering for the nearest step」—— 插到最近步边界（空闲则开回合）；取消 / 销毁可能丢弃 | 不用 |
| `agent.inject(msg)` | 「Queue model-facing context for the next pre-step **without waking** the driver」—— 不唤醒 | 不用 |

取 `followup` 的理由：定时任务的目的就是「到点让 agent 动起来」，故必须唤醒（排除 `inject`）；无人值守时往**正在跑的回合里插话**会让这一轮的语义无法归因（排除 `steer`）。

**排布口径（回答「已有活跃 agent 后怎么安排」）**

1. **目标忙碌（`agent.status === 'running'`）时不等待、不打断**：`followup` 天然排队，当前回合结束后它成为独立新回合。守护**不**调 `cancel`、**不**用 `whenIdle()` 阻塞等待；
2. **同会话同批到期 → 合并为一条消息**：因为每条 `followup`「独占一个回合」，逐条投会连开多个回合；合并后同批只开一个回合（与宿主 schedule 的合并口径一致）；
3. **跨会话并发**：会话之间互不影响，投递动作本身很轻（append + flush），不引入全局串行；任务表推进与 Journal 写入仍走单 FIFO 保一致；
4. **投递确认取 flush 而非 followup 返回**：成功判据见下节「投递确认」；确认只覆盖到「入队落盘」，**不表示模型执行**；要「执行完再动作」需另加 `whenIdle()` / 状态观察，**首期不做**；
5. **`command` 类任务语义不同**：`ctx.commands.execute(agent, line, [], signal)` 是「解析并执行已知命令、不发给模型」（§6），在目标 agent 上直接生效，**不排队** —— 这正是 D6 要求「文本投递」与「命令执行」两种任务类型语义分开的原因；
6. **审批 / 阻塞**：宿主 agent 状态只有 `idle | running`（`AgentStatus = 'idle' | 'running'`），「等审批」不是第三个状态；投递照常排队，审批解决后进入新回合（安全边界见 §E-3）；
7. **时序红线**：注入动作推迟到宏任务（`setTimeout(…, 0)`），避开 `session/event` 的同步派发窗口（§2）。

**投递确认：是不是单向发送？**（2026-10-15 用户问）

**不是单向发送：成功判据取 `sessions.flush()` 的确认，不取 `followup()` 的返回。** 依据：

- `agent.followup(msg): void`（`dsh-agent-loop/lib/types/agent.d.ts:41`）—— 调用本身**零回执**，单凭它返回什么都不算成功；
- `ctx.sessions.flush(session): Promise<boolean>` = 「持久化屏障（await 全部监听者）」（`docs/host/DSH-CTX-API.md:25`）；收件箱插入是**事件支撑的持久化投影**（`inbox = {next-turn, next-step}`，`agent/inbox/inserted`；`DSH-CTX-API.md:100`），因此 flush 能覆盖它；
- 宿主 schedule 同款口径（原文）：「插件来源的 `followup()` 同步将消息追加到会话收件箱；**会话 flush 成功后确认持久投递**」「该回执确认收件箱投递，**不表示模型执行**」；其服务注释亦写明「a delivery commits only when `ctx.sessions.flush()` reports that a `session/flush` listener participated」。

**确认的等级（本守护只到 L2）**

| 等级 | 含义 | 判据 | 首期 |
| --- | --- | --- | --- |
| L0 | 调用返回 | `followup()` 返回（void） | 不作判据 |
| L1 | 入队（本进程内存 + inbox 投影） | `agent.inbox` / 投影状态可读 | 不作判据 |
| **L2** | **入队已落盘（持久）** | **`flush()` 返回 true** | **判 `delivered`** |
| L3 | 回合真的开始 / 结束 | `agent/status`（`idle`/`running`）、`turn/start` / `turn/end` 会话事件、`whenIdle()` | 不做（首期） |
| L4 | 任务达成 | 内容正确性 / 用户验收 | 不可自动判定 |

**flush 返回 false 时怎么办（D13）**：这是「消息已进内存收件箱、但持久化面未确认」的分裂态。选 **(a) 记 `delivered` 并标 `durable: false`（原因码 `volatile`）+ 升格告警，不自动重投**。理由：消息**已经**在收件箱里、多半会被执行，重投会造成同一任务投两次（重复投递的代价高于丢一次告警）；而 flush=false 通常意味着持久化面本身出了更大的问题，值得一条显式告警而不是静默重试。备选 (b) 严格 at-least-once：flush=false 即重投（配 `retryOnFlushFailure`）—— 已由用户 2026-10-15 否决（「不用，有机制保证送达即可」）。宿主 schedule 在此处是「不发布新的已保存记录、只记日志」（既不重投也不告警）。

**投递语义 = at-least-once，不承诺 exactly-once**（对齐宿主）：先 flush 再落任务表（记录 `lastDelivery`），两者之间崩溃/写失败会留下「已投递但未记账」的消息，下次触发**可能重复投递同一条**。若要收紧，需先写 intent 再 flush 的写前标记（属实现阶段的复杂度权衡）。

**可验证验收**

- 单测（假 agent）：目标 `status === 'running'` 时仍走 `followup`（断言未调 `cancel`、未 await `whenIdle`）；
- 单测：同会话三条同批到期 → `followup` 只调用一次，且消息正文含三条内容；
- 单测：`agents.get(sessionId)` 未命中 → 记 `skipped: no-active-agent` 且不调用 `followup`；`graceMs > 0` 时窗口内重试、超窗后 `skipped`；
- 单测：`flush` 返回 false → 记 `delivered` 且 `durable: false`（原因码 `volatile`）+ 一条告警，且**不**自动重投（D13）；
- 真机（实现阶段）：目标正在跑长任务时投一条，确认消息在**下一回合**出现、当前回合未被打断。

### C. 首期两块能力：行为口径 + 可验证验收

**2026-10-17 收窄后的归并**：下面 ①-④ 是条目原来的四项, 按新范围归成**两块** —— **定时执行** = ① 定时任务 + ② 发布命令（到点做什么）；**过程结果记录** = ③ 可见性与日志 + ④ 持久化与重启恢复（做过什么、结果如何、重启后还在）。四小节的行为口径与验收不变, 只换分组口径；记录底座按 D19 落 `memory-base`。

#### ① 定时任务

口径：

- 选择器集合与宿主对齐：`after_seconds`（正安全整数秒）/ `at`（严格未来的绝对时点）/ `every_seconds`（≥ 60 s）/ `daily` / `weekly`（`weekdays` 为 ISO 1-7）/ `cron`（五字段 `minute hour day-of-month month day-of-week`，`0` 与 `7` 均为周日，IANA 时区必填）——**cron 不进首期**（2026-10-17 裁定，列后续可选项）；补齐/拒绝规则照宿主方言（拒绝 `L` `W` `#`、名称、宏、六字段、零步长、反向范围）；
- 规范化后存储（重复值合并、相邻值与范围合并、步长 1 移除、周日统一写 `0`），拒绝非规范化的已存记录；
- 首目标严格未来；DST 缺口**跳过**、重叠取**较早**时点；每月每日期一次；
- 时间不可表示（超出范围）→ `time_out_of_range`；频率过高 → `frequency_too_high`。

验收：单测覆盖**首期五种**选择器各一条正常路径 + 拒绝用例（非未来 `at` / `every_seconds: 59` / 缺时区；cron 用例随其进首期时补）；DST 用例在 `Asia/Shanghai` 与一个含 DST 的时区（如 `America/New_York`）各一条。

#### ② 发布命令

口径：

- 任务类型两种：`deliver`（投递提示文本）与 `command`（执行 slash 命令）；
- `deliver`：构造 user 消息（`content` 数组 + `source.kind = "background-daemon"`，硬要求见 `session-channel/docs/DESIGN.md` §4），经 `agent.followup` + `sessions.flush` 注入，且注入动作**推迟到宏任务**（避开 `session/event` 同步派发窗口）；`flush` 返回 false 视为投递失败（不记成功）；
- `command`：`ctx.commands.find(agent, name)` 命中才执行，经 `ctx.commands.execute(agent, line, [], signal)`；未命中 → 任务 `failed`（错误码 `command_not_found`），**不**静默降级成文本投递；
- 目标寻址首期只支持**精确 sessionId**（会话别名 / `cwd:` 寻址属 `session-channel` 的能力，跨进程才有意义，见后续可选项）；
- 目标会话不在本进程（或已结束）→ 记 `skipped`（`no-active-agent`）并写流水，**不重试**（2026-10-17 裁定；D5 的宽限窗口若启用，只在窗口内等，不构成重试链）；
- 注入文本**不**触发 TUI 的 slash 解析（§3），故 `deliver` 的提示文本里写 `/xxx` 只是文本 —— 需要命令语义时必须用 `command` 类型；
- **不属本条语义**：在**新窗格 / 新进程**里起一个 agent 干活（herdr 窗格代理、headless 子进程、`task-engine` 子代理）都归「唤醒其他代理」—— 能力②只管「投给**已有活跃 agent** 的会话」（§B）。herdr 窗格代理已按用户裁定**另立插件**（D12、调研 §5），本守护只在将来调用它的服务面。

验收：单测用假 agent / 假命令服务断言两条路径的调用形态（含 `source.kind`、延迟宏任务、`flush=false` 计失败、命令未命中不降级）；真机（实现阶段）投一条文本任务到当前会话，确认以用户块显示且不被当命令执行；投一条 `command` 任务，确认回执与 `command/run` 事件出现。

#### ③ 可见性与日志

口径：

- `/daemon`（`ctx.commands.register`）子命令：`list`（含 next / 状态 / 上次结果）/ `show <id>` / `pause|resume <id>` / `run <id>`（立即投递一次）/ `cancel <id>` / `log [<id>] [n]`；无任务时输出「暂无守护任务」；
- 只读查询面 `ctx.backgroundDaemon`（`list/status/journal`），供 `/daemon` 与**后续** TUI 状态列块消费；缺失时 TUI 侧按既有惯例提示不可用（`TUI/src/app/adapter/types.ts:1717-1734` 口径）；
- 运行日志：`Journal` 写 `memory-base` 的注册 kind（**可搜索**, 2026-10-17 裁定；同时进入 `/memory` 与模型检索面），字段含 `taskId / at / outcome(delivered|failed|missed|skipped) / error / durationMs`；有界由该档的容量与保留参数承担；
- 失败处理（2026-10-17 裁定：**不重试**）：投递失败只记账（`failed` + 原因码）并写流水，不做退避重试（原先的「1 min → 30 min、最多 N 次」取消）；一次性任务到此结束，周期任务等下一个触发点（不补做本次）；`missed` 只用于「一次性任务过期」与「暂停期间到点」；
- 状态符号只用仓内推荐符号（`✓` `✗` `△` `○` `●`），不用 emoji。

验收：`/daemon` 每个子命令一条单测（空表 / 单任务 / 未知 id）；日志有界性单测（写超上限后条数为上限、最旧被轮转）；**不重试**断言（投递失败后该任务不再被触发，且流水里只有一条记录）。

#### ④ 持久化与重启恢复

口径：

- 路径：`dshHomePath('background-daemon/tasks.json')`，支持 `process.env.BACKGROUND_DAEMON_STORE` 覆盖（对齐 `memory-base` 的 `dbPath` 写法）；
- 写入：原子写（tmp + rename），带 `schemaVersion`；版本不认识 / JSON 损坏 / 记录非法 → **拒绝启用该面**（不发布部分任务表，打一条 warn 并经 `/daemon` 可见），**不**静默清空（对齐宿主「任务 schema 未声明备份并跳过策略」的取向）；
- 启动恢复：加载 → 逐条重算 next → 已过期的周期任务按「补发最近一次」入队、一次性任务按补发窗口判 `missed`；
- 关闭：取消 timer、等在途投递结束再落盘（对齐宿主「关闭时取消它，等待已接受的工作结束」）。

验收：单测（原子写用「写中途 kill」模拟：残文件不产生半截 JSON 被读入；损坏文件 → 面不启用且报错文案含路径；版本升级路径：v1 读取后写成 v2）；重启恢复单测（注入固定时钟：过期周期任务只补发最近一次；过期一次性任务 → `missed`）。

### D. 与宿主 `schedule` 的关系（结论）

**自建，不复用、不并存（首期）**，理由见 D3/§1；语义以宿主为基线以便将来换用时行为一致。若将来 profile 解禁宿主 `schedule`，两条调度链不得作用于同一目标（照 `metric-loop` 对双循环的「不叠」口径处理）。

### E. 安全与无人值守边界（对应条目裁定项④）

1. 投递是 **user 消息**，模型随后调用工具时照常受 `security-guard`（`tools/pre-execute`）与 `approval` / `sandboxPolicy` 约束 —— 守护**不**降级任何策略、不改 `permissionPresets`；
2. `command` 类任务若执行命令，属「命令来自状态文件」一侧 → 走引擎侧复查（`guardScope: "engine-side"`）；复查不可用时 fail-open 但可辨（对齐 `metric-loop` 的 `guardSkipped` + summary 说明，不新增第二套语义）；
3. 无人应答的审批：`approval policy = ask` 时投递的任务可能停在审批点 → 记 `awaiting-approval` 状态并在 `/daemon` 可见；守护**不**自动批准、不自动取消会话、不绕过审批；
4. 首期不支持「无人值守执行写操作」这一诉求本身；需要时由用户改 approval / sandbox 策略，属用户显式动作。

### F. 插件拆分（用户 2026-10-15 提出「功能集中在一个插件里了，考虑拆分」）

**状态（2026-10-17）**：切法**已裁定为单包**（D15 末尾）—— 下面这套两包（A 方案）作废, 仅作历史备选; 四个方案的对比与拆分成本保留, 供将来重新评估。单包内部按 `selector` / `due` / `scheduler` / `records` / `deliver` 分模块。

现状：本节 A-E 的职责原本都落在一个新包里。按「一条可独立验收」与「渠道可插拔」两条标准重切为两包 —— 每项「负责什么 / 依赖什么 / 不负责什么」如下（用户 2026-10-15 要求逐项说清）：

**`daemon-core`（调度内核：只管「什么时候该做什么」与「做成了没有」）**

| 项 | 负责什么 | 依赖（宿主服务） | 不负责什么 |
| --- | --- | --- | --- |
| TaskStore（任务表） | 任务定义与状态的**权威存储**：选择器记录、`next` 目标时间、`lastDelivery`、状态（`active` / `paused` / `missed`）；落盘底座 ~~改用宿主 **`ctx.storageDomain`** 的域~~ → **2026-10-17 改判: 落本仓 `memory-base` 的注册 kind（D19）**, 校验 / 淘汰豁免 / 变更通知由它的配套改动保证 | `memory-base`（~~`storageDomain`~~） | 不决定何时触发（Scheduler 管）、不投递 |
| 选择器与 cron（放独立模块 `src/selectors.ts` / `src/due.ts`, 为将来抽包留缝 —— D18） | **纯函数**：校验 + 规范化 + 求下一次触发 —— `after_seconds` / `at` / `every_seconds`(≥60) / `daily` / `weekly` / `cron`（五字段 Vixie）；IANA 时区、DST 缺口跳过 / 重叠取早；拒绝非规范化的已存记录 | 无（`Intl` 足够） | 不读时钟做副作用、不落盘 |
| Scheduler | **单 timer**（底层用宿主 `ctx.timer` 的 `timeout()`：fiber 绑定, 插件卸载即自动释放, D16）+ 到点队列；变更后重算（至多一个待触发）；到期重读墙钟、回拨重算、**超平台上限分段**（timer 原语不管这条, 自建）；启动补算（周期任务只补**最近一次**、一次性过期 → `missed`）；同会话同批**合并**为一次投递请求 | `agents`（解析目标活跃 agent, D5）、`timer`（`cordis-plugin-timer`, 已挂载） | 不做投递动作（交渠道）、不记流水（Journal 管） |
| 渠道缝 + 记账 | `registerChannel` 注册表与调用：把 `{task, agent, signal}` 交给渠道；按返回码记账 `delivered` / `failed` / `skipped` + 原因（含 `durable:false`）；推进 `next` 或置 `inactive`；失败只记账、**不重试**（2026-10-17 裁定） | 无（渠道由外部包注册） | 不知道渠道内部怎么做（文本 / 命令 / 将来 herdr） |
| `/daemon` 命令 | `ctx.commands.register` 六个子命令：`list` / `show` / `pause｜resume` / `run` / `cancel` / `log`；空表文案；只用仓内推荐符号 | `commands` | 不自己投递（`run` 走同一条调度 + 渠道路径） |
| 只读查询面 | `ctx.daemon`：`list` / `status` / `journal`（供 `/daemon` 与后续 TUI 状态列块读取） | 无 | 不写（纯只读） |
| Journal（日志） | JSONL 追加写：`taskId` / `at` / `outcome` / `error` / `durationMs`；**有界**（条数上限 + 文件轮转） | 无 | 不做重试决策（决策在渠道缝那层） |

**`daemon-deliver`（投递渠道：只管「这一种投递怎么做」）**

| 项 | 负责什么 | 依赖（宿主服务） | 不负责什么 |
| --- | --- | --- | --- |
| `channel(text)` | 文本投递：构造 user 消息（`content` + `source.kind = "background-daemon"`）→ `agent.followup`（**排队, 不打断**）→ 动作**推迟宏任务** → `sessions.flush` 确认（L2）；`flush` 为 false → 返回 `flush_failed`（内核记 `durable:false` + 告警）；同批合并的正文在此拼装 | `sessions`（flush）；agent 由内核传入 | 不解析目标、不决定时点、不写任务表 |
| `channel(command)` | 命令投递：`commands.find(agent, name)` 命中才执行 → `commands.execute(agent, line, [], signal)`；未命中 → `command_not_found`（**不**降级成文本）；执行前**引擎侧 guard 复查** → `guard_denied`（复查器缺失则 fail-open 并标 `guardSkipped`） | `commands`；security-guard 复查器 | **不排队**（立即语义）、不发模型 |

**边界一句**：core 里没有任何「投递动作」；deliver 里没有任何「时间、状态、落盘」。验收也因此分开 —— core 用**假渠道**测（测时点、补发、记账、退避）, deliver 用**假 agent / 假命令服务**测（测调用形态、确认、失败码）。

**渠道缝契约（草案）**

```ts
// daemon-core 提供；渠道包与将来的 herdr / headless 渠道都实现它
interface DaemonChannel {
  kind: string;                       // 'text' | 'command' | 将来 'herdr' | 'headless'
  deliver(req: { task: DaemonTask; agent: Agent; signal: AbortSignal }):
    Promise<{ ok: true; detail?: string }
          | { ok: false; code: 'no-active-agent' | 'command_not_found' | 'guard_denied' | 'flush_failed' | 'error'; message?: string }>;
}
ctx.daemon.registerChannel(channel): () => void
```

分工：**内核**负责到期、解析目标 agent（未命中 → `skipped: no-active-agent`）、调渠道、按返回记账（**不重试**）、`missed`；**渠道**只负责「它那一种投递怎么做」与其语义（文本 = 排队 + `flush` 确认；命令 = 直接执行 + 引擎侧复查）。内核因此**不依赖** `commands`, 命令面缺失时整包照常工作, 只有命令渠道报不可用（符合仓内「服务缺失即提示不可用」惯例）。

**方案对比**

| 方案 | 切法 | 包数 | 优点 | 缺点 |
| --- | --- | --- | --- | --- |
| **A（推荐）** | 内核 + 渠道（两条渠道同包、按模块分文件） | 2 | 主轴清晰（调度 vs 投递失败语义不同、可各自验收）；渠道缝首期就位；命令面依赖隔离 | 两渠道同包, 打包粒度略粗 |
| B | 内核 + 文本渠道 + 命令渠道 | 3 | 依赖面最干净（命令渠道独占 `commands` 与 guard 复查语义） | 每渠道仅 150-250 行却各背一套脚手架 |
| C | 内核 / 投递 / 可见性 / 日志 | 4 | 单职责最纯 | 可见性与日志就是内核的脸与账本, 拆出去只增胶水（过度拆分） |
| D | 维持单包, 内部按接口分层 | 1 | 首期最快 | 渠道缝事后抽取, 第三条渠道（herdr / headless）来时要动内核 |

**推荐 A**，理由：① 拆分主轴是「调度 vs 投递」—— 两者失败语义不同（时点错 vs 没送到）, 验收可分开；② 渠道缝**将来必然要用** —— herdr 窗格代理（D12 已另立插件）若要接定时触发, 它就是一条渠道, 而不是再写一套调度；③ 命令渠道与文本渠道共享面很小, 但先按两个 channel 模块分开即可, 等第三条渠道落地再按需拆包；④ 内核不依赖 `commands`, 依赖隔离到位。

**拆分的真实成本（必须记账）**：每个新包一套脚手架（`package.json` 的 `dsh.bundle` + `cordis.patch.yml` + `README.md`）；根 `check` / `build` / `test` 三处接线各 +1；`scripts/install.sh` 插件清单与一致性校验 +1；profile `dependencies` 与 `bundles` 各 +1；真机验证的组合数 +1。按方案 A, 相对单包净增 1 个包。

### G. 定位与分界：它是「会话投递的调度面」，不是通用调度器（用户 2026-10-15：「更像是调度器了」）

用户点得准：内核（`daemon-core`）本质就是一个调度器 —— 时间计算 + 触发 + 任务表 + 重试记账。**要把这层身份写清, 否则范围会自然膨胀成通用作业调度器。**

**定位一句**：本守护 = **面向「agent 会话投递」的调度面**。调度是手段, **投递才是目的** —— 它调度的是「往某个活跃 agent 会话投一句话 / 执行一条 slash 命令」, 不是「跑一个作业」。

**三条非目标（写死在包 README 与条目里, 防止范围膨胀）**

1. **不跑 shell / 作业**：要「每天 9 点跑测试」「定时拉备份」这类**进程级作业** → 用 `systemd timer` / `cron` / 现成工具, 不要长在本包里（`channel(command)` 执行的是**会话里的 slash 命令**, 不是 shell 作业）；
2. **不做进程外触发**：dsh 不在运行就不触发（D1 已认下的代价）；要「dsh 不在也能跑」→ 形态 B（D2）或 herdr 窗格插件（D12）；
3. **不做通用调度器的高级面**：任务依赖编排（DAG）、并发池 / 资源配额、多机分布、复杂重试矩阵 —— 一律不做；本包只需「选择器 + 单 timer + 任务表 + 退避」这四件。

**与现成调度面的对照（为什么仍是自建内核）**

| 现成件 | 它是什么 | 为什么不能直接当我们的内核 |
| --- | --- | --- |
| `systemd timer` / `cron` | 进程级作业调度 | 只能起进程, 拿不到「活跃 agent 会话」这个投递目标, 也拿不到 `followup` / `flush` 的确认语义（非目标 1、2） |
| 宿主 `schedule` | 完整调度器 + 会话投递 | 语义相反（必冷恢复, D5）且依赖 Web 控制器（D14 spike 才知能否挂起来） |
| **`cordis-plugin-timer`（已挂载）** | **timer 原语**（`ctx.timer` / `ctx.timeout()` / `ctx.interval()`, fiber 绑定自动释放） | **该复用的正是它**（D16）—— 它只给原语, 不给日历 / 持久化 / 补发, 那三件仍自建 |
| herdr（`agent prompt` / `wait`） | 终端工作区控制面 | 它调度的是「往别的窗格里的 agent 送输入」, 目标是**新会话**, 属另立插件（D12） |

**结论**：身份上承认「我们是调度器」（面向会话投递的那一类）；能力上刻意只做四件（选择器 / 单 timer / 任务表 / 记账（不重试）），底层 timer 原语复用宿主 `cordis-plugin-timer`（D16）；进程级作业与进程外触发明确划给 systemd / cron / 形态 B / herdr 插件。

### H. 模块归属（2026-10-17 用户裁定「先只定每个功能用哪个模块」）

口径: 只定**谁承载**, 不定参数与实现细节；包数已裁定为**单包**（2026-10-17, 见 D15）, 与本表无关。

| 功能 | 承载模块 | 说明 |
| --- | --- | --- |
| 时间语义（选择器校验 / 规范化 / 求下次触发 / IANA 时区与 DST） | 本守护新包 | 无现成模块可复用, 自建纯函数模块 |
| 到期决策与补发（`next` 推进 / 只补最近一次 / 一次性过期转 `missed` / 同批合并） | 本守护新包 | 自建 |
| 调度循环（单 timer + 分段 + 回拨重算 + 启动补算） | 本守护新包 + 宿主 `ctx.timer` | 原语复用（D16）, 编排自建 |
| 文本投递（`followup` + `flush` 确认 + 推迟宏任务） | 宿主 `ctx.agents` / `ctx.sessions` | 由本守护编排 |
| 命令执行（slash 命令） | 宿主 `ctx.commands` | `find` / `execute` |
| 目标解析（会话 → 活跃 agent） | 宿主 `ctx.agents` | `get(sessionId)` |
| 记账（**不重试**, 失败只记流水） | 本守护新包 | 自建 |
| 命令面 `/daemon` 与只读服务 `ctx.daemon` | 本守护新包 + 宿主 `ctx.commands.register` | 插件侧自足, TUI 零改动 |
| 重启恢复（启动补算 + 关闭 drain） | 本守护新包 | 配合 memory-base 的库打开语义 |
| 审批边界（无人值守） | 宿主 `ctx.approval` | 不降级策略；挂起可见 |
| 命令安全复查 | 仓内 `security-guard` | 引擎侧复查口径照 `metric-loop` 的 `guardScope` / `guardSkipped` |
| 任务定义与状态 / 运行流水与结果 | 仓内 `memory-base`（注册 kind） | D19；kind 划分与分档待裁定 |
| 分级作用域 / 寿命 / 容量 / 检索 / `/memory` 可见面 | 仓内 `memory-base` 现成能力 | 用它现成的 S / P / U 与 FTS |
| 类型注册与约束 / durable 免淘汰 / 直写通道 / 变更事件 / 坏行策略 | 仓内 `memory-base` 配套改动 | 归它的模块条目, 本设计只写接口假设 |
| 多代理编排（建组 / 发言权 / 汇聚结论）与唤醒其他代理 | `peer-group` 新插件 | 外置；设计见它的追踪文档 |
| 知识沉淀与长期记忆 | 仓内 `memory-base` 现成面 | 外置 |
| 跨会话投递到别的 dsh 进程 | 仓内 `session-channel` | 后续可选项 |
| 子任务执行 / 委派 | 仓内 `task-engine` | 与唤醒其他代理一道外置 |
| 独立常驻进程（dsh 不在也触发） | 后续可选项, 形态未定 | D2 |
| TUI 状态列「守护」块 | TUI 侧条目 | 后续可选项（D7 的 (b)） |

一句话: 本守护自建的只有三块 —— **时间语义 / 时刻表决策 / 投递编排**；其余全部复用现成模块或外置。

**后续可选项**

1. **唤醒其他代理**（条目已定, 本设计**不实现**）: 2026-10-17 起**移交 `peer-group` 插件**（多代理建组 / 发言权 / 汇聚结论）；本守护只保留触发侧假设 —— 若它暴露服务面（例如「起一个带提示的 agent」）, 本守护可在任务类型里加一条调用它; 进程内子任务走 `task-engine` 叶子执行后端, 跨会话投递走 `session-channel` 的 `channel_delegate`；
2. **形态 (b) 独立常驻进程**（D2）：独占价值 = dsh 不在运行时也能触发；投递面可用 `dsh headless --session-id`（须先解决 headless 侧 app 入口与会话写者冲突），或（若 herdr 插件已就位）经它开窗起 agent；进程治理归它自己；
3. **冷会话投递**（D5 的 (b)）：`ctx.agents.resume` + 所有权与组合语义设计；
4. **TUI 状态列「守护」块**（D7 的 (b)）：TUI 侧条目（第五块 + 折叠分级 + 等价性回归 + `SPEC.md` 更新）；
5. **跨进程寻址**（别名 / `cwd:`）与经 `session-channel` 投递到其他 dsh 进程的会话；
6. **cron 选择器进首期**（2026-10-17 裁定不进, 列后续可选项；届时再定实现来源: 自研最小五字段 Vixie + `Intl` ／ 第三方库, 见 D4）。

## 待用户裁定与实现条目草案

**裁定 A：形态 —— 已裁定（2026-10-15，用户选「进程内插件」）**：首期形态 = (a) 进程内插件；若将来改选 (b)/(c)，设计正文相应节需按形态重写，估时另计。

已裁定：

- **形态 = 进程内插件**（2026-10-15 用户裁定）；
- **自建内核, 不复用宿主 `schedule`**（2026-10-15 用户「还是自己写吧」；D3 定案, D14 随之关闭）；
- **范围收窄为两块: 定时执行 + 过程结果记录**（2026-10-17 用户裁定；D20）—— 记忆用 `memory-base` 现成面, 编排与唤醒其他代理移交 `peer-group`；
- **记录底座 = 本仓 `memory-base`，不走 `storage-domain`**（2026-10-17 用户裁定；D19, 取代已撤销的 D17）；
- **取消严格的提升（升级）策略**（2026-10-17 用户明确；落为 memory-base 侧配套改动）；
- **herdr 窗格代理另立插件**（D12）；
- **冷会话投递不进首期**（D5）；
- **不引入 `retryOnFlushFailure`**（D13）；
- **单包**（2026-10-17 裁定; 原 D15 的两包方案作废）；
- **任务按 S / P / U 三档**（2026-10-17 裁定 —— 分级任务列表）；
- **运行流水入 `memory-base` 且可搜索**（2026-10-17 裁定）；
- **创建入口两种都要**：`/daemon` 命令 + 模型侧工具（2026-10-17 裁定）；
- **cron 不进首期**（2026-10-17 裁定; D4 随之消失, 列后续可选项）；
- **不重试**（2026-10-17 裁定 —— 投递失败只记账, 退避与重试上限一并取消）。

**撤回的旧记录**：「拆成 2 个新包: `daemon-core` + `daemon-deliver`」曾写在此处 —— 用户 2026-10-17 明确**没有**做过这个裁定, 该条已撤, 归入下面架构组第 1 条。

仍待裁定（按用户 2026-10-17 指示, **先只定模块与架构, 细节留到实现条目**）：

**甲 架构组 —— 已裁定（2026-10-17）**

1. **包数 = 单包**（内部按 `selector` / `due` / `scheduler` / `records` / `deliver` 分模块）;
2. **任务分档 = 三档 S / P / U**（会话级任务随会话消失、项目级、用户级 —— 分级任务列表）;
3. **运行流水也入 `memory-base`, 且可搜索**;
4. **可见性代价 = 认下**：任务与流水都进入 `/memory` 与模型检索面（不声明「不进检索」）;
5. **创建入口 = 两种都要**：`/daemon` 命令 + 模型侧工具（`schedule_create` 等价物）。

**乙 记忆底座契约组**（与 memory-base 的条目一起定, 也是它的验收点）：durable 豁免形态；直写通道形态（取消严格提升的落地方式）；坏行策略；变更通知（事件 / 轮询）；去重与幂等键（任务按任务 id、流水按 run id）；隐私闸门对含密钥类正文的处置；字段约束表达（扩 `KindColumn` 支持 notNull / check ／ 落 `preWrite` 钩子）；kind 与表命名；三档各自的作用域键与容量参数。

**丙 调度语义组**

- 已定: **cron 不进首期**（2026-10-17 裁定, D4 随之消失; 列后续可选项）；补发口径（周期只补最近一次 / 一次性过期转 `missed`）；
- 仍待拍板: **暂停期间到点的口径**（记 `missed` 不补 ／ 对齐 K8s 解除后补最近一次）；无活跃 agent 的窗口命名与缺省（`graceMs` 建议改名 `awaitAgentMs`、缺省 0 —— 「是否进重试链」随「不重试」裁定自动消失）。

**丁 执行与失败组**

- 已定: 执行动作 = 投文本 + 执行 slash 命令（进程级作业为非目标）；**不重试**（2026-10-17 裁定 —— 退避参数与「哪些失败码进重试链」一并取消, 失败只记账）;
- 仍待拍板: 命令渠道是否加声明式白名单（gh-aw 的 `safe-outputs` 式前置, 首期 / 后续）；目标指定方式（只认本进程会话 id ／ 连别名与 `cwd:`）。

**戊 参数缺省组**（实现时按缺省即可, 不单独裁定）：各档容量与流水保留条数 / 天数、单批合并上限、抖动是否启用（建议首期不启用）、平台 timer 分段阈值。

裁定后登记的实现条目草案（**本次不登记**，待裁定；2026-10-17 按收窄后的范围与模块归属重排）：

| 草案条目 | 内容 | 依赖 | 估时 |
| --- | --- | --- | --- |
| 1. 定时执行内核（本守护新包） | 脚手架（`dsh.bundle` + `cordis.patch.yml` + README）、选择器与时刻表纯函数（**首期五种, 不含 cron**）、`Scheduler`（单 timer + 分段 + 回拨重算 + 启动补算 + 同批合并）、目标解析、两条执行动作（文本 = `followup` + `flush`；命令 = `find` / `execute` + 引擎侧复查）、记账（**不重试**）、模型侧工具（`schedule_create` 等价物） | 甲组已裁定 | 1.5-2 天 |
| 2. 过程结果记录与可见性（本守护新包 + memory-base 契约） | 任务表与流水的 kind 读写封装（**S / P / U 三档, 流水可搜索**）、`/daemon` 六子命令、只读服务 `ctx.daemon`、重启恢复（启动补算 / 关闭 drain） | 1 + memory-base 配套改动 | 1 天 |
| 3. memory-base 配套改动（**归它的模块**, 可先行） | 取消严格提升（直写通道）、durable 免淘汰、行级校验与坏行策略、变更事件、去重与隐私闸门口径 | 无 | 0.5-1 天 |
| 4. 真机验证 | `dsh --profile fff` 四条端到端（文本投递、命令执行、重启恢复、无活跃 agent 的 `skipped`） | 1-3 | 0.5-1 天 |
| 5.（可选）TUI 状态列守护块 | TUI 侧第五块 + 折叠 + 等价性回归 + `SPEC.md` | 2 | 1-2 天 |

## 实现记录

- 2026-10-15：接取条目并按标准流程开工（用户批准「开工写设计文档」），建本追踪文档（含设计正文），条目标「进行中」。

- 2026-10-15：调研完成，来源与证据见「调研」节（宿主包源码直读为主，标注了未复验项）；决策 D1-D11 落定；设计正文与实现条目草案写完。

- 2026-10-15：自查补两处 —— ① 按条目验收①补「形态逐项对照」表（原先只散在决策行文里）；② 流程图首版带右边框，CJK 宽度下对不齐（实测行宽 83-100），改为无右边框流程并逐列校验。格式化（`format`）通过，`docs/BACKLOG.md` 的无关归一改动已还原。

- 2026-10-15：第二轮（用户裁定与指示）—— ① 裁定 A（形态 = 进程内插件）写入「待用户裁定」节；② 曾按用户指示「考虑通过 herdr 接口打开一个窗口并启动 agent」调研 herdr 控制面并写过一版 §E；

- 2026-10-15：第三轮（用户收窄范围）—— ① herdr 窗格代理改判**另立插件**（D12 改写、调研 §4 的 herdr 块压缩为 §5「相邻件」两条关键事实、设计 §E 整节删除）；② 按用户「只关心已经有活动的 agent 后要怎么安排」新增设计 §B（目标模型 / 三条投递原语的权威语义 / 七条排布口径 / 五条验收），D5 由「冷会话留队重试」改写为「只面向已有活跃 agent，未命中即 `skipped`」；③ 形态对照表、后续可选项 1/2、实现条目草案（撤掉 herdr 行）同步改写。

- 2026-10-17：第十五轮 —— 用户裁定六条: **单包**、**任务按 S / P / U 三档**、**运行流水入库且可搜索**、**创建入口两种都要**、**cron 不进首期**、**不重试**。据此: D15 定案单包（两包方案作废）、D4 标不适用、退避与重试口径全线改写（§C ②③、§F 表与分工、§H、§9 对照表第 6 行、缺口清单第 5 项）、待裁定节甲组转「已裁定」并把丙 / 丁 / 戊组按「已定 / 仍待拍板」重排、条目草案同步（条目 1 去掉 cron 与退避并纳入模型侧工具, 条目 2 注明三档与可搜索）。**按指示: 未登记 BACKLOG 条目、未提交、不做其他工作。**

- 2026-10-17：第十四轮 —— 用户先问「storage-domain 的定位」与「memory-base 做不到 schema 校验吗」, 再裁定「配合自己的 memory-base, 不走 storage-domain」, 并指示「先只定每个功能使用哪个模块, 先不做细节」→ 新增 **D19**（记录底座 = 本仓 `memory-base`, 取代已撤销的 D17; 四项配套改动归 memory-base 模块条目）与 **D20**（范围收窄）; 新增调研 §10（两条记录底座逐项对比, 含 memory-base 已有的四层 schema 能力与三条真实差距）与设计 §H（模块归属表）;「待用户裁定」节按甲-戊五组重排, 实现条目草案按收窄范围重列。**D18 的记忆那半反转**（原「不用 memory-base」降级为待解风险）。本轮未写代码、未改 memory-base。

- 2026-10-17：第十三轮 —— 用户收窄范围「记忆已有可利用的插件、编排交给新插件 `peer-group`、核心 = 定时执行 + 过程结果记录」→ 目标节新增「范围再收窄」口径; §C 由四项能力归并为两块; §F 标注插件拆分**未裁定**（用户明确「没决定拆 2 个包」, 更正第十轮与「已裁定」节的记录）; 后续可选项 1（唤醒其他代理）移交 `peer-group`。同时更正一处旧记录: 用户并非「已裁定 2 包」。

- 2026-10-15：第十二轮 —— 用户问「类似产品有哪些, 它们都是怎么设计的」→ 新增调研 §9（同类产品对照: 四派产品机制 + 11 条与本设计的差异 + 来源链接; 未读到原文的项标「未复验」）。§9 的「处置」列含四条待办（`graceMs` 改名 / 暂停期间到点的口径 / 命令名白名单 / 幂等提示）, 未改设计正文 —— 待用户裁定后再落。

- 2026-10-15：第十一轮 —— 用户问「定时, 记忆这些可以拆分或者复用已有的吧?」→ 新增 D18（定时原语复用且不拆包 + 任务表走 `storage-domain` 而不用 `memory-base`, 理由 = 权威数据 vs 可淘汰记忆的语义冲突）；§F 选择器行标注「独立模块文件, 为将来抽包留缝」。

- 2026-10-15：第十轮 —— 用户裁定「还是自己写吧」（D3 定案、D14 spike 关闭）并指示「将这些功能拆分成插件, 看看需要写几个」→ D15 定案为 **2 个新包**（`daemon-core` / `daemon-deliver`, 计数依据写入 D15）；实现条目草案撤掉 spike 行；决策节按编号重排（D12-D17）并把误置的 D14 附录移回 D14 之后；待裁定清单收敛为 5 条。

- 2026-10-15：第九轮 —— 用户报「不一致」；用 `@dsh-toolset/md-table-check` 自己的判定函数（`dist/src/checker.js` 的 `checkTables`）复核本文件, 报出**一处真实不一致**：第 324 行（`/daemon` 命令行）内联代码里的 `pause|resume` 用了 ASCII 竖线, 在表格里仍被当作单元格分隔 → 该行 5 格 vs 表头 4 格。已改为全角 `｜`, 复核后本文件 0 处不一致。**同时更正我先前第 2 轮那次自查**：当时的脚本把「列数变化」当成新表边界, 所以漏判了这处（错误方法已弃用, 改以插件判定为准）。

- 2026-10-15：第八轮 —— 用户问「三件功能（调度 / 定时 / 任务记录）里仓内与宿主已覆盖哪些」并指出「更像是调度器了」；新增调研 §8 既有覆盖矩阵（四件逐一对照仓内 / 已挂载 / 未挂载）与设计 §G 定位与分界（三条非目标 + 与现成调度面的对照）, 新增 D16（底层 timer 复用 `cordis-plugin-timer`）与 D17（任务表底座改用 `storage-domain`，D8 据此划掉并注明取代者）。

- 2026-10-15：第七轮 —— 用户提出「功能集中在一个插件里了，考虑拆分」；新增设计 §F（八项职责归属表 + 渠道缝契约草案 + 四方案对比 + 拆分成本）与决策 D15（选定 A：`daemon-core` + `daemon-deliver` 两包, 渠道缝首期就位）, 组件图与实现条目草案按两包重排。

- 2026-10-15：第六轮 —— 用户表示「需要的话可以挂载，这不是阻塞点」；据此核实挂载链（`api-session-controller` 的 11 项 inject 逐项对账，更正「`sessionQuery` 缺失」的误判、标出 `attachments` / `fileUploads` / `fs` 三项存疑），新增决策 D14（挂载试验列实现第 0 步、设计基线仍自建）与条目草案第 0 条。

- 2026-10-15：第五轮 —— 用户确认「不用（重投开关），有机制保证送达即可」，D13 收敛为「仅 L2 确认、不引入 `retryOnFlushFailure`」（待裁定项同步收敛）。

- 2026-10-15：第四轮（用户问「单向发送还是收到接收确认才算成功」）—— 定案 **L2 确认口径**（成功判据取 `sessions.flush()`，不取 `followup()` 的 void 返回），§B 新增「投递确认」小节（L0-L4 等级表 + flush=false 策略 + at-least-once 语义），新增决策 D13，验收补 flush=false 用例。

- 2026-10-18：收尾关闭 —— 实现落地为新包 `background-daemon`（单包, 轻量包口径：能力面在 `README.md`, 不另写 `docs/DESIGN.md`）并已合入 main; 期间修掉两处宿主面缺陷（`apply` 返回运行期对象被 cordis 当 effect → 拆 `bootDaemon` + `apply` 返回 void；插件未声明 `inject` 导致激活早于服务就绪 → 补 `["agents", "sessions", "timer", "commands", "tools"]`），定时器最终改为进程内实现、不再依赖宿主 `timer`（`80ca7ea`）。单包 `npm run check` 与 `npm test`（136 例）通过。

- 2026-10-18：**未挂载验证** —— 本机 profile 未挂载该插件, 设计 §C 的四条真机验收（文本投递 / 命令执行 / 重启恢复 / 无活跃 agent 的 `skipped`）与 `backend=memory`（memory-base 注册 kind 记录底座）路径都未在真实 dsh 进程里跑过; 该缺口已登记为 `docs/BACKLOG.md` 条目 14。

## 偏差

偏差：**无** —— 计划清单里的两个文件都已按计划改动，设计正文按「目标」四项产出。以下三处是与**条目预估**的差异（非与计划的差异），依据均在上文：

- 条目「落点（预估）」提到的「若复用宿主 schedule，改 `profiles/example/cordis.patch.yml` 与本机 profile 的解禁行」——本次**未做**：调研结论（§1/D3）是自建而非复用，该路径不成立；
- 条目「验收（设计阶段）」④「用户裁定形态后拆成实现条目」——本次只给**草案**（见上节表格），实际登记待用户裁定后执行（条目自身即要求「先裁定后拆」）；
- 条目裁定项②「是否解禁并复用宿主 `schedule` / `time-context`」：本设计给出**不解禁**的结论与依据；`time-context`（每步的持久上下文：当前时间与已耗时，`docs/host/HOST-PACKAGES.md:201`）与自建调度无交集，故未纳入方案 —— 若用户裁定要投递「未限定时区 / 日期的人类表述」类任务，它才相关，届时另议。

## 测试与证据

本阶段为设计，无代码与单测。执行过的检查：

```
$ git status --short            # 开工前：工作区干净（分支 feat/background-daemon @ 7aba7ae）
$ dsh --profile fff --dump-config
  exit=1，stderr: EROFS: read-only file system, open '/home/guochang/.dsh/profiles/fff/cordis.yml'
  → 挂载面未二次复验，改用 docs/host/HOST-PACKAGES.md + 本机 profile patch 直读为据（见「调研」§7）
$ grep -n "id: " ~/.dsh/profiles/fff/cordis.patch.yml
  → 无 schedule / session-controller 行（与 HOST-PACKAGES 一致）
$ grep -rn "handleSlash" TUI/src/app/*.ts
  → 仅 TUI/src/app/index.ts:3490 定义 + :3327（本地输入提交路径）调用
$ sed -n '2590,2597p' 安装树/dsh-schedule/lib/index.js
  → static inject 含 sessionController / sessionPersistence
$ sed -n '1576,1597p' 安装树/dsh-schedule/lib/index.js
  → 投递链路 sessionController.resolveAgent → agent.followup → sessions.flush
$ /home/guochang/fff/scripts/format docs/BACKLOG.md docs/implementation/2026-10-15-background-daemon-design.md
  → mdformat 通过；其把 docs/BACKLOG.md §3 既有列表编号归一为 2./3.（无关改动）已手工还原，
    最终 git diff --stat docs/BACKLOG.md = 1 file changed, 1 insertion(+), 1 deletion(-)
$ python3 -c "…"   # 按 East Asian Width 量正文显示列宽（宽字符 2 列，制表符号 1 列）
  → 重画后的流程图中 │/▼ 恒在第 7 列、┬/├/└ 恒在第 29 列（首版带右边框的框图行宽 83-100 不等，已换掉）
$ env | grep -i herdr        # 第二轮按用户指示调研 herdr 控制面（该能力已改判另立插件，事实存档供其使用）
  → HERDR_ENV=1 / HERDR_SOCKET_PATH=/home/guochang/.config/herdr/herdr.sock / HERDR_PANE_ID=wRP:p1
$ herdr --help; herdr agent --help; herdr pane --help; herdr tab --help; herdr notification --help
$ herdr agent prompt --help; herdr agent start --help; herdr agent wait --help; herdr pane run --help; herdr pane split --help
  → 只读 `--help` 取契约（**未**执行任何变更命令：pane split / pane run / agent prompt 均为变更语义，本轮只读）
  → 关键：`agent start --kind` 取值 25 种不含 `dsh`；`agent prompt` 在目标 blocked 时以 agent_blocked 拒绝
$ node -e "import('./dist/src/checker.js')…"   # 用 md-table-check 自己的判定核心复核
  → 修前：设计文档「问题表 1 / 不一致行 1」——表@第 318 行 期望 4 列, 第 324 行 实际 5 列
  → 修后：设计文档「问题表 0 / 不一致行 0」；同进程内复核我重打的覆盖矩阵文本亦为 0
$ python3 - <<'EOF'          # 第十二轮自写复核：按 splitCells 口径（\| 转义不切、首尾空单元剥除）逐表比对列数
  → tables=12 inconsistent=0；表格内联代码含 ASCII 竖线：none（新节 §9 的 5 列表在内）
$ /home/guochang/fff/scripts/format docs/implementation/2026-10-15-background-daemon-design.md
  → exit 0；格式化前后逐字节相同（本文件已合规，无改动）
$ web_fetch 9 篇官方文档   # 第十二轮 §9 来源（systemd / Quartz / APScheduler / Celery / K8s / Actions / gh-aw / Temporal / Trigger.dev）
  → 读到原文 6 篇；Trigger.dev 页被导航截断、OpenAI 帮助页 403、Inngest 路径 404、Airflow 未取
  → 未读到原文的项已在 §9 标「未复验」，不进对照结论
$ python3 - <<'EOF'          # 2026-10-17 复核：逐表列数 + 表格内联代码里的 ASCII 竖线（口径同上）
  → tables=14 inconsistent=0；ascii-pipe-in-code-in-table: none（含新增的调研 §10 与设计 §H 两张表）
$ /home/guochang/fff/scripts/format docs/implementation/2026-10-15-background-daemon-design.md
  → exit 0；格式化前后逐字节相同（无改动）；改动落地后文件 689 行（`wc -l`）
$ ls docs/implementation/ ../peer-group/docs/implementation/   # 跨 worktree 引用核对（只读）
  → 本 worktree: 2026-10-15-background-daemon-design.md；peer-group worktree: 2026-10-16-peer-group-protocol-design.md
$ grep -n "interface KindColumn" -A 4 memory-base/src/router.ts
  → 只有 name + type（调研 §10「声明式单一真源」一条的依据）
$ grep -n "拒绝打开" memory-base/src/schema.ts
  → 库级指纹 / 版本拒绝打开集中在 schema.ts:310-352 一带（调研 §10 依据）
```

残留检查（本任务结束时）：

- 工作区改动 = `docs/BACKLOG.md`（1 行：条目标「进行中」）+ 新增 `docs/implementation/2026-10-15-background-daemon-design.md`；
- 临时文件已清理：调研产物 `/tmp/fff-tree.txt`、`/tmp/fff-tree.err` 已 `rm -f`（本就不在仓库内，复核已不存在）；
- 未触碰：任何源码包、`TUI/`、`profiles/`、`docs/host/`、`docs/STATUS.md`。
- 2026-10-17 复核（第十三、十四轮）：本轮只改本文件（`docs/BACKLOG.md` 仍是那一行「进行中」标记）；格式化用的临时副本 `/tmp/bd-b*.md` 已删除；跨 worktree 只做只读查看（peer-group 的设计文档、memory-base 的源码与设计）。

## 收尾

- 条目：`docs/BACKLOG.md` 所接取条目标「进行中」（2026-10-15）；关闭时标「完成」并按规范清理移除。
- 回写：形态已裁定 (a)；实现落地为轻量包 `background-daemon`（能力面在 `README.md`，不另写 `docs/DESIGN.md`）；根 `README.md` / `README.zh.md` 的插件清单与包计数**尚未回写**（已登记在 `docs/BACKLOG.md`「五个新插件落地时的仓库清单与包计数统一」条目）；`memory-base` 的配套改动落**它自己的模块文档与条目**；本任务不改 `docs/STATUS.md`（用户择时更新）、不改 `docs/host/`。
- 跨模块：`peer-group` 插件的设计在它自己的追踪文档（工作树 `feat/peer-group` 的 `docs/implementation/2026-10-16-peer-group-protocol-design.md`），本文件只引用、不复制。
- 归档：本文件已于 2026-10-18 移入 `docs/archived/`（设计条目关闭；实现与真机验证的缺口见「实现记录」与 `docs/BACKLOG.md` 条目 14）。
- 遗留：实现条目草案（上节表格, 5 条）与后续可选项 1-6（其中第 1 条已移交 `peer-group`）。
