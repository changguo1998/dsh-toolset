# `rule-engine` 与官方 `repeat-tool-reminder` 注入重复度（接取条目：`docs/BACKLOG.md`「`rule-engine` 与官方 `repeat-tool-reminder` 注入重复度未量化」）

状态：调研　　开启：2026-10-05　　关闭：—
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

### 对条目的影响

原条目的两个前提（同点竞争、预算互挤）都不成立。剩下唯一成立的部分是「同一回合可能出现两条提醒」——但那不是冲突，两条提醒的**触发条件互不相关**（一条是重复工具调用，一条是规则命中），且文案不同、无去重必要。

## 决策

（待定；调研倾向：**不收窄引擎行为**，改为更正条目前提 + 在 README 写明分工）

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

## 测试与证据

（待实现后补；调研阶段的实测数据见「调研 → 实测」一节）

## 收尾

（待关闭时补）
