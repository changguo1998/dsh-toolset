# `rule-engine` 与官方 `repeat-tool-reminder` 注入重复度（接取条目：`docs/BACKLOG.md`「`rule-engine` 与官方 `repeat-tool-reminder` 注入重复度未量化」）

状态：完成　　开启：2026-10-05　　关闭：2026-10-05
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

量化 `rule-engine` 与官方 `repeat-tool-reminder` 的注入重复度，据此决定「收窄触发面」还是「写明分工」。

## 调研

来源：本仓与官方包源码阅读 + 真会话日志实测（只读）。

### 头号发现：条目前提有误

条目写「两者都挂宿主 `agent/pre-step`」——**不成立**：

- `rule-engine` 源码里检索 `agent/pre-step` → **零命中**；
- 它的节点表在 `rule-engine/src/engine.ts:110-121`（`NODE_SCALES`）：`session-start` / `user-message` / `turn-start` / `assistant-text` / `turn-end` / `step-start` / `step-end` / `tool-call` / `tool-result`，另有 `compaction` 不入对齐表；
- 本仓唯一订阅 `agent/pre-step` 的是 TUI（`TUI/src/app/adapter/tool-bootstrap.ts:457`，兜底捕获用，与 rule-engine 无关）。

官方 `dsh-repeat-tool-reminder`：描述「Repeat-tool-call guard plugin: advisory reminders when an agent loops on identical tool calls」，注入点确为 `agent/pre-step`，默认分档阈值 `thresholds: [3, 5, 8]`（同一工具重复调用次数，逐档升级提醒）。

**结论：不是同点竞争。** 两者注入点不同，不存在监听顺序问题。

### 预算是否互相挤占

不挤占。`maxInjectionsPerTurn`（缺省 3，`engine.ts:206-209`）只统计 **rule-engine 自己**的注入段：`engine.ts:791-805` 用会话内 `state.injected` 账簿计数，超限时 `warn` 并跳过该段（`:797-800`），同正文另按 `usage.texts` 去重（`:803`）。官方 reminder 由宿主独立注入，不进入该账簿。

### 实测（真会话日志）

会话日志是**多帧 zstd**（`~/.dsh/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd`）。`zlib.zstdDecompressSync` 只解首帧（返回 1 条 `session` 记录），需逐帧解（每帧魔数 `28 B5 2F FD`）。

对最大的 dsh-toolset 会话（`tui-e966736c-…`，2.1 MB）逐帧解出 **1149 帧 / 2131 条记录**，统计 `agent/inbox/spliced` 记录（共 108 条）的注入正文前缀：

| 注入来源 | 条数 |
|---|---|
| 子代理通知（`Background subagent …` / `Agent …`） | 104 |
| **rule-engine 注入**（`[RULE] 用 skill 工具加载 i-have-adhd`，2 条同带符号规范、1 条带 ponytail） | 3 |
| 用户 steer | 1 |
| **官方 `repeat-tool-reminder`** | **0** |

该会话共 23 个回合、414 次工具调用，官方 reminder **一次都没触发**。

**误报排除**：先前用 `grep -rl repeat-tool-reminder` 得到的 17 处命中是**假阳性** —— 命中的是 `tool/result` 记录里我们自己的 `docs/BACKLOG.md` 正文（该文件写了这个词）。诊断此类问题不能直接对原始字节 grep。

### 局限（不可过度解读）

- 本方法只能看见「经 `agent/inbox/spliced` 落盘的注入」。若官方 reminder 走别的路径进入 prompt，则本方法看不见；
- 因此结论是「**未观测到双注入**」，不是「不可能双注入」。要精确量化需在宿主 pre-step 加探针或读 stderr。
- **（关闭时更正，见「决策」）** 官方 reminder 的通道已由源码确认**不经 inbox**（走 `tools/post-execute` 的 `additionalContexts`），故上表「官方 reminder 0 条」是**方法必然结果**，不能读作「官方未触发」的证据。本条结论不依赖该数字——依赖的是注入点与通道的**结构差异**。

### 对条目的影响

原条目的两个前提（同点竞争、预算互挤）都不成立。剩下唯一成立的部分是「同一回合可能出现两条提醒」——但那不是冲突，两条提醒的**触发条件互不相关**（一条是重复工具调用，一条是规则命中），且文案不同、无去重必要。

## 决策

2026-10-05，用户指示「关闭 #4」。采纳调研倾向：**不收窄引擎行为**，以「更正前提 + 写明分工」关闭条目。

理由：条目的两个前提（同点竞争、预算互挤）均不成立；唯一成立的部分（同一回合可能出现两条提醒）不构成冲突。

**关闭时补强取证**（官方 lib 源码复核，强于调研期的日志推断）：

- 官方 reminder 的注入通道是 `tools/post-execute` 返回值里的 `additionalContexts`（`dsh-repeat-tool-reminder/lib/index.js:1495-1507`）——**步骤级上下文，不产生消息记录**；
- 它的 `agent/pre-step` 监听（`:1509-1512`）只做一件事：收到真实用户消息（`source.kind === "user"`）时清零该 agent 的重复计数；`thresholds` 缺省 `[3, 5, 8]`（`:1360-1366`），base 已挂载并显式写死该阈值（`dsh-base/cordis.patch.yml:419-423`）。

## 规划

**计划改动文件清单（待决策后收敛；未列出的文件一律不改）**

- `docs/BACKLOG.md` —— 更正本条目的前提（删「两者都挂 `agent/pre-step`」）
- `rule-engine/README.md` —— 写明与官方 reminder 的分工（注入点不同、预算独立、触发条件无关）
- 可选：`scripts/` 或 `rule-engine/tests/` —— 留下可复跑的「逐帧 zstd 读取 + splice 前缀统计」小工具，便于后续复测
- 可选：`docs/ARCHITECTURE-REUSE.md:22` 与观察项措辞复核

**明确不做**

- 不改 `rule-engine` 的注入行为与预算缺省（无证据表明需要收窄）
- 不去动官方包

## 实现记录

- 2026-10-05：接取条目并标记「进行中」；完成现状调研 + 真会话日志实测（见上），**无代码改动**。发现条目前提有误。
- 2026-10-05：关闭条目（**文档类变更，无代码改动**）——`rule-engine/README.md` 新增「与官方 `repeat-tool-reminder` 的分工（不竞争，2026-10-05 定论）」小节（触发条件 / 注入通道 / 订阅节点三维对照 + 结论与依据指针）；`docs/ARCHITECTURE-REUSE.md` 观察项 ③ 标记已评估关闭；`docs/BACKLOG.md` 移除本条目；本文件归档。

## 测试与证据

文档类变更，验证 = `format` + 自查 diff（不涉及 `check` / `build` / `test`）。

- 结构取证（本仓）：`rule-engine/src/engine.ts:110-121` 节点表**无** `agent/pre-step`；`engine.ts:791-805` 预算账簿只计本引擎自己的注入段。
- 事实取证（官方包，关闭时复核）：`@deepseek-ai/dsh-repeat-tool-reminder/lib/index.js:1495-1512`（`tools/post-execute` 附 `additionalContexts`；`agent/pre-step` 仅用于清零重复计数）、`:1360-1366`（`thresholds` 缺省 `[3,5,8]`）；`@deepseek-ai/dsh-base/cordis.patch.yml:419-423`（已挂载、显式阈值）。
- 实测（调研期，见「调研 → 实测」）：最大 dsh-toolset 会话 2131 条记录中官方 reminder 0 条、本引擎 3 条；该数字已按「决策」收窄解释。

## 收尾

- 条目已从 `docs/BACKLOG.md` §2 移除（只留未完成项）；本文件移入 `docs/archived/`。
- 原「规划」中的两个「可选」项均**判定不必做**：逐帧 zstd 统计小工具（结论不依赖该统计，且官方通道不落 inbox，复用价值低）、`rule-engine` 行为改动（无证据表明需要收窄）。
