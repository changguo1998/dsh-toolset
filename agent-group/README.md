# @dsh-toolset/agent-group

DSH 进程内插件：**同事模型群组的编排**（跨会话协调层）—— 组、成员、主从连接（含等级）、平等连接、指令与回报、广播。不采样、不聚合，也不建也不销毁会话。

设计决策见项目级追踪文档 `docs/archived/2026-10-16-peer-group-protocol-design.md`（决策项 1-20）；本包的机制说明见 `docs/DESIGN.md`。

## 能力

注册单个工具 `agent_group`，按 `action` 分派 10 个动作：

| 动作 | 参数 | 语义 |
| --- | --- | --- |
| `create_group` | `name?` | 建组（只带组级参数；**管理者 = 调用方所在会话**，组内固定名 `manager`、等级 0） |
| `add_member` | `group` · `name` · `target` | 加成员，一次一个；`target` = 会话 id 或别名（须**在线且唯一命中**）；组内名本包自管 |
| `link` | `group` · `from` · `to` | 建立主从连接（主 → 从）：从方须是**自由代理**（无主、无从、等级 0），从方等级 = 主方等级 + 1 |
| `link_peer` | `group` · `from` · `to` | 建立**平等连接**（双向、无等级、发完即走；任意两个 agent 之间**每种**连接各至多一条，决策项 4 / 6） |
| `send` | `group` · `to` · `text` · `timeoutMs?` | 发指令（每条主从连接**同时只允许一条未结**；`timeoutMs` 缺省 30 分钟） |
| `send_peer` | `group` · `to` · `text` | 经平等连接发一条消息（**发完即走**：不等回复、不重试、不留未结指令） |
| `broadcast` | `group` · `text` · `to?` | 广播：按当前成员集合逐条发送并**汇总送达 / 失败**（`to` 缺省 = 全部非管理者成员；逗号或空格分隔子集） |
| `check` | `group` · `to?` | 懒判定结算：成功 / 失败 / 受阻 / 超时（缺 `to` 则检查全组已建立连接的成员） |
| `remove` | `group` · `name` | 移除成员（**逐层下推**：非叶子被拒并列出剩余从代理；其平等连接一并删除） |
| `close_group` | `group` | 关闭组（#4 裁定 3）：**仅组长可关**；未结指令终止、连接关系关闭、不连带关成员；关闭后写动作拒、`status` 仍读 |
| `status` | `group` | 只读查看：成员、等级与主从关系、平等连接、未结指令、最近回报、镜像计数；**成员状态**（`memberStates`，BACKLOG #1） |

所有拒绝都带 **原因 + 下一步**（`{ok:false, error, reason, next}`，`error` 是稳定错误码）。

**成员状态视图（跨进程忙闲，BACKLOG #1）**：`status` 动作与只读服务面在返回里附 `memberStates` —— 每个成员的 `state ∈ {offline, idle, working, stuck}`，判定基于 session-channel 的**跨进程状态牌**（`state:<sessionId>` = `{status, at}`，发布端见 session-channel README「agent 状态牌」）：

- 不在在线集（`alive:*` 过期 / pid 死）= `offline`；`idle` = 待机；`running` 且 `at`（最近转换时刻）距今未超 `stuckAfterMs` = `working`；`running` 且超阈值 = `stuck`（疑似卡死）；
- 判定不依赖目标 agent 工作循环、不产生模型推理 —— **目标卡死时依然可判**；只读现算、不落盘不镜像；session-channel 未挂 / 读失败时 `memberStates` 缺省（不阻塞 `status` 只读返回）。

## 只读服务面（TUI `/group` 等）

除工具外，`apply` 还 `ctx.provide("agentGroup", { status })` 注册**只读**服务面：`status(managerSessionId, groupName?)` 按管理者会话读组状态——成功 `{ok:true, groups:[{name, view}]}`（`view` 为只读视图）；失败 `{ok:false, error, reason?, next?}`（`group_not_found` 的 `reason` 带现有组清单；`session_paths_unavailable` / `state_unavailable` 见「依赖与降级」）。它**不写盘、不镜像**，与动作 `status` 同源（`readGroupStatus`）。消费方（如 TUI `/group` 命令）经 `ctx.get("agentGroup")` 读取；未挂载时由调用方降级提示，不阻塞插件自身。

## 规则（由代码保证，不靠提示词约定）

- **每 agent 至多一个主**（`links` 以从方为主键）；主方可有多个从。
- **等级严格递增**：无主者 0，从方 = 主方 + 1；主→从沿链只增，**环构造不出来**。管理者等级固定 0，故**不能作为从方**（违反「主等级 < 从等级」）。
- **自由代理**才能当从方：无主、无从、等级 0（决策项 9）。
- **连接不可解除**（决策项 10）：要改结构只能逐层 `remove` 后重建。
- **每连接一条未结指令**（决策项 14）：第二条 `send` 被拒，提示先 `check`。
- **懒判定结算**：`check` 才向通道读任务，收场五种 —— 成功 / 失败 / 受阻（`blocked:` 前缀）/ 超时 / 成员被移除（`removed`）。超时同时接受通道判定与本地判定（`now ≥ deadline`）。
- **回报信封**（决策项 16）：`成功 / 失败 / 受阻 + 正文 + 成因`，本包**不解析正文**、不做聚合。成员要表达「受阻」时用 `failed: true` + `error: "blocked: <原因>"`（本包识别该前缀并把前缀剥掉后作为成因）。
- **拒绝不级联**：非叶子移除被拒，提示里列出它名下的从代理与逐层移除的顺序。
- **平等连接**（决策项 4 / 6）：双向、无等级、发完即走（不等回复、不重试、不留未结指令）；每对这种连接各至多一条；与主从连接相互独立（同一对「主从 + 平等」可并存）；移除成员时其平等连接一并删除。

## 传输接入

`inject` 面挂 `session-channel` 的服务面（`ctx.get("sessionChannel")`）：

- 投递指令 = `delegate({from, to, text, timeoutSec})`，指令 id 用其 `task.id`；`from` = 主方成员的会话 id（未知时回落管理者会话 id），`to` = 从方成员解析出的会话 id。
- 收取回报 = `taskStatus(taskId)`（**读取时懒判定超时**）。
- 发完即走消息（平等连接 `send_peer` / 广播 `broadcast`）= `send({to, text, waitMs})`，回执 `delivered` 表示已注入目标下一回合；**不产生任务记录、不留未结指令**。
- 成员寻址 = `peers()`（会话 id 精确）+ `aliasList()`（别名）——离线或歧义直接拒绝，**不排队**。

三条硬约束照 `session-channel` 的 README：从方也要挂本插件（注入由目标进程的 reader 完成）· 目标必须在线 · 离线不排队。

## 状态落点与镜像

- 组状态落**管理者自己的会话目录**：`<管理者会话目录>/agent-group.json`（`stateFileName` 可改，经 `sessionPaths.sessionDirFor(managerSessionId)` 推导）；原子写与 0600、串行与先落盘再更新缓存、只读 `status` 不碰存储的机制见 `docs/DESIGN.md` 第 5、6 节。
- **可选镜像**（`mirror`，缺省开）：每次组状态变更后把只读视图写进 memory-base（`kind: "agent_group"`，写目标层 `session`，`source: {kind: "manual", label: "agent_group", ref: <组 id>}`，`project` 取管理者会话的 `cwd`）；memory-base 未挂载 → 跳过，写入被 `MemoryScope.put` 拒收（`skipped`）或抛错 → 只计数 + 首次一条日志、**不重试**，计数见 `status` 的 `mirror` 字段。

## 依赖与降级

**注册与解析分开**（2026-10-19 真机修正，取代 2026-10-17 裁定）：工具在 `apply` 期**同步注册**（工具表在 agent 创建时定稿，晚注册进不了表）。注册面 `tools` 写进**静态 `inject`** —— 宿主 base 在 agent 创建前就提供它，声明后 cordis 会把本插件的激活排到它之后，`apply` 里才拿得到工具表；其余服务**不**写进 `inject`（它们由兄弟 bundle 在各自 fiber 提供，声明会让整包推迟到它们就绪，工具反而进不了表）。可选服务在**每次 `execute` 时惰性解析**，解析路径：`ctx.inject([...], cb)` **子分叉**绑定优先（服务由兄弟 bundle 提供时，未注入的 `ctx.get` 直读拿不到），其次 `ctx.get` 直读兜底。

| 依赖 | 用途 | 不可用时 |
| --- | --- | --- |
| `tools`（宿主） | 注册工具 | `apply` 期一次警告（连注册面都没有，无从提供工具） |
| `sessionChannel`（session-channel） | 传输 | 工具**仍已注册**；调用返回 `session_channel_unavailable`（原因 + 下一步） |
| `sessionPaths`（session-paths） | 组状态落点 | 调用返回 `session_paths_unavailable`（原因 + 下一步） |
| `memory`（memory-base） | 可选镜像 | 跳过并计数，不影响动作 |
| `sessions`（宿主） | 镜像的 `project`（管理者会话 `cwd`） | 回落 `agent-group:<组名>` |

解析结果**只缓存成功**：服务晚到（宿主稍后 `provide`）时下一次调用会重新解析并自愈；失败不缓存，故不会把「当时没挂」固化成永久不可用。`memory` / `sessions` 在服务实例创建时取一次（镜像属可选增强）。

运行期 `sessionDirFor(managerSessionId)` 抛错（会话不在宿主 `sessions` 里等）→ **写状态的动作报错**（`state_unavailable`，带原因与下一步）；**只读 `status` 命中缓存仍可用**。

## 配置

```yaml
- insert:
    - id: agent-group
      name: '@dsh-toolset/agent-group'
      config:
        enabled: true            # 缺省 true；false = 不注册工具
        defaultTimeoutMs: 1800000 # send 缺省等待上限（毫秒）
        maxInstructionRecords: 50 # 每组保留的指令记录条数上限（从最旧裁）
        mirror: true              # 是否镜像进 memory-base
        stateFileName: agent-group.json # 只允许 [A-Za-z0-9._-]
        stuckAfterMs: 300000      # 疑似卡死阈值（毫秒，缺省 5 分钟）
        statusPollMs: 20000       # 状态巡查间隔（毫秒，缺省 20 秒；判定面为调用时现算）
```

## 示例（工具调用序列）

```jsonc
{ "action": "create_group", "name": "review" }
{ "action": "add_member", "group": "review", "name": "alice", "target": "alice-alias" }
{ "action": "add_member", "group": "review", "name": "bob", "target": "bob-session-id" }
{ "action": "link", "group": "review", "from": "manager", "to": "alice" }
{ "action": "send", "group": "review", "to": "alice", "text": "评审 design.md 的并发一节", "timeoutMs": 600000 }
{ "action": "check", "group": "review", "to": "alice" }
{ "action": "link_peer", "group": "review", "from": "manager", "to": "bob" }
{ "action": "send_peer", "group": "review", "to": "bob", "text": "下午同步一下进度" }
{ "action": "broadcast", "group": "review", "text": "全员：周五 18:00 前给结论" }
```

## 边界与不做

- 不做结论聚合、不建模「轮次」（管理者自己合成结论）。
- 不启动 / 不销毁成员会话（成员是「已存在且可被寻址的会话」）。
- 仅本机（经 session-channel），无跨机；无 TUI 命令或面板（二期）。
- 广播与平等连接**不产生未结指令**：需要带回报的任务仍走主从 `send` / `check`。
- 不占用全机别名空间：组内名字由本包自管。
- 与相邻能力的边界：链路归 `session-channel`；任务骨架与验收归 `task-engine`；单会话 prompt 级采样裁决归 `command-template` 的 `bestOf + judge`；人面并行评审归 TUI `/council`；**成员与连接**归本包。

## 测试

```sh
npm run check   # tsc --noEmit（src + tests 类型检查）
npm run build   # tsc → dist/
npm run test    # node --test（3 个文件：model / core / main；不依赖 Redis）
```

## 文件

- `src/types.ts`：配置、组状态（落盘形状）、端口与结果信封
- `src/model.ts`：纯状态迁移与不变量（组 / 成员 / 连接 / 指令 / 视图 / 自检）
- `src/core.ts`：10 个动作的编排（读状态 → 纯迁移 → 落盘 → 镜像）
- `src/store.ts`：文件存储（原子写 / 0600）与内存存储
- `src/transport.ts`：session-channel 服务面适配（`delegate` / `taskStatus` / `send` / 寻址）
- `src/mirror.ts`：可选 memory-base 镜像
- `src/main.ts`：bundle 入口（依赖门禁 + 工具注册）
- `docs/DESIGN.md`：机制与决策落地；`docs/BACKLOG.md`：未完成项
