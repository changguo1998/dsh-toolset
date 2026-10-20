# agent-group 设计

## 1. 定位

**跨会话协调层**：组、成员、主从连接（含等级）、指令与回报。不碰终端（不做 pane 后端）、不采样、不聚合、不建也不销毁会话。

设计依据：项目级追踪文档 `docs/archived/2026-10-16-peer-group-protocol-design.md` 的决策项 1-20；本文件记录**这些决策在代码里怎么落地**，以及实现阶段出现的偏差。

```
管理者会话 ──(agent_group 工具)──▶ 本包（组状态 + 规则）
                                    │  delegate / taskStatus
                                    ▼
                              session-channel（传输）
                                    │  [CHANNEL] 注入
                                    ▼
                          成员会话（各自可能也挂着本插件）
```

## 2. 模块划分

| 文件 | 职责 | 不做什么 |
| --- | --- | --- |
| `src/types.ts` | 配置 / 组状态（落盘形状）/ 端口（传输、存储、镜像）/ 结果信封 | 不含逻辑 |
| `src/model.ts` | **纯**状态迁移：建组、加成员、建连接、开 / 结算指令、移除、视图、不变量自检 | 不碰传输、不落盘、不读时钟（`now` / `id` 由调用方注入） |
| `src/core.ts` | 7 个动作的编排：读状态 → 纯迁移 → 落盘 → 镜像 → 结果；`verdictOf` 懒判定 | 不直接拼 SQL / 不直接调 Redis |
| `src/store.ts` | 文件存储（`<会话目录>/agent-group.json`，原子写 / 0600）与内存存储 | 不建会话目录（宿主负责） |
| `src/transport.ts` | session-channel 服务面适配：寻址（`peers` + `aliasList`）、投递（`delegate`）、读任务（`taskStatus`） | 不做重试 / 排队 |
| `src/mirror.ts` | 可选 memory-base 镜像（`registerKind` 拿写句柄 + `scope.put`） | 失败不重试 |
| `src/main.ts` | bundle 入口：依赖门禁（可选读取）、组装、注册工具、lossless JSON 归一 | 不含协调逻辑 |

`model.ts` 的纯函数性是本包可测性的基础：连接规则、等级、未结指令、移除下推、视图与不变量自检都能不起任何外部依赖地单测；`core.ts` 只负责把「外部世界」（传输 / 存储 / 镜像 / 时钟）接上。

## 3. 数据模型

```
AgentGroupBook（一个管理者会话的全量状态，落盘）
└─ groups: { <组名>: AgentGroupState }
   ├─ members: { <组内名>: GroupMember }   // 含固定 manager（等级 0、role=manager）
   ├─ links:    { <从方名>: GroupLink }     // 每 agent 至多一个主：以从方为主键
   ├─ peerLinks: { <对键>: GroupPeerLink }  // 平等连接：双向、无等级；对键 = `a.b`（a<b 字典序）
   └─ instructions: GroupInstruction[]     // 未结 + 已结算；按 sentAt 追加，超上限从最旧裁
```

- **组内名**（组名 / 成员名）统一口径 `[A-Za-z0-9_-]{1,32}`：窄、无空白、可直接进 JSON 与命令；`manager` 是保留名（对键分隔符 `.` 不会与组内名相撞）。
- **等级**：无主者 0；从方 = 主方 + 1。等级只赋一次、此后不变（因为从方必须是自由代理，不存在子树重排，决策项 9）。平等连接**不记等级**（决策项 6）。
- **平等连接**（决策项 4 / 6，二期落地）：`peerLinks` 以「对键」为主键（`a.b`，a\<b 字典序）—— 每对至多一条由键唯一性直接保证；与主从连接（`links`）相互独立、可并存；移除成员时其参与的全部平等连接一并删除（纯状态改动）。
- **指令**：`status ∈ {open, success, failure, blocked, timeout, removed}`。`open` 即未结；其余是收场。`removed` 是「成员被移除」这一失败成因的独立值，便于 `status` 与 `summary` 区分。`send_peer` / `broadcast`（消息式）**不落指令记录**、不产生未结。
- **可选字段一律按需拼装**：落盘与工具返回都不出现值为 `undefined` 的键（宿主 `INVALID_TOOL_OUTPUT` 的成因）。
- **向后兼容**：旧落盘文件没有 `peerLinks` 字段，`store.load` 按空对象补齐（不升 `version`）。

## 4. 状态机

### 4.1 指令

```
                 send（连接上无未结）
        ┌───────────────────────────────┐
        ▼                               │
      open ──check: done──────────▶ success
        │  ──check: failed─────────▶ failure ──（error 以 "blocked:" 开头）──▶ blocked
        │  ──check: canceled───────▶ failure（成因：指令被取消）
        │  ──check: timeout / 本地超时─▶ timeout
        │  ──delegate 失败──────────▶ failure（成因：投递失败原因）
        └──remove 成员──────────────▶ removed
```

- `send` 先落一条 `open` 记录（不先投递），投递成功补 `taskId`；投递失败**结算为 failure 并落盘**，返回失败信封（附带 `instructionId` 与结算后的记录）。这样「投递失败的尝试」在状态里留痕，且该连接立刻可以重发。
- `check` 只对 `open` 指令读取传输；仍是 `pending` / `running` 且未超时 → 保持未结（结果里进 `open` 数组）。
- 超时判定双轨：通道的 `taskStatus` 会在读取时懒判定超时（`timeout`）；本包再用 `now ≥ deadline` 兜底（时钟漂移 / 通道未及时判定），成因里注明「通道判定」或「本地判定」。

### 4.2 成员与连接

```
add_member ──▶ 成员（自由代理：无主、无从、等级 0）
                  │ link from=X（X 是任一成员 / 管理者）
                  ▼
              从方（等级 = X.level + 1）──link from=它──▶ 更深的从方
                  │ remove（仅当它是叶子）
                  ▼
              移除（主从连接随成员一并删除；未结指令结算为 removed；平等连接一并删除）
```

- 连接**不可解除**：没有 unlink 动作；改结构只能逐层 `remove` 后重建（决策项 10）。
- 移除**不级联**：非叶子被拒，`reason` 与 `next` 里列出剩余从代理与逐层移除的顺序（决策项 18）。
- 管理者不能被移除、也不能作为从方——两条路径都带原因与下一步。
- **平等连接**：`link_peer group from to` 建立（校验成员存在、不自连、该对尚无平等连接）；建立后**双向可发**（`send_peer` 由管理者经连接发一条消息，发完即走）；不影响主从等级与未结指令。

### 4.3 「主等级 ≥ 从等级」这条规则怎么落地

决策项 8 要求「不允许主等级 ≥ 从等级」，决策项 9 又要求从方必须是等级 0 的自由代理。两条合起来：正常路径上任何连接都会把从方从 0 提到「主 + 1」，严格递增由构造保证；**真正可触发这条规则的是「把管理者当从方」**（管理者等级固定 0，主方等级 ≥ 0 即 ≥ 从方等级 0）。因此实现里：

1. 管理者作为 `to` 时直接以 `level_violation` 拒绝（`reason` 写明「主等级 N ≥ 从等级 0」）；
2. 连接写入位置保留断言式守卫（`principal.level >= level` → 拒绝），用于防御被外部改动的状态；
3. `invariantViolations` 把「连接等级 ≠ 主 + 1」「从方等级 ≠ 连接等级」「自由代理等级 ≠ 0」「成环」都列为违规，`status` 命中违规时会带出 `violations`。

## 5. 时序与并发

- **串行化**：同一管理者的动作串在一条 promise 链上（`#locked`），避免同一会话内两次读到同一份旧状态（典型场景：并发两次 `send` 只应有一条成为未结）。
- **先落盘再更新缓存**：写动作成功落盘后才把新状态放进缓存；落盘失败返回 `state_unavailable`，缓存保持「最后一次成功写入」的版本。
- **只读不落盘**：`status` 不写文件、不写镜像；缓存命中时**完全不碰存储** —— 这就是「运行期 `sessionDirFor` 抛错时 `status` 仍可读」的落地方式。
- **镜像在动作之后**：`await mirror.put(...)` 失败只计数 + 首次一条日志，不影响动作结果（决策项：镜像不是协调的必要条件）。

## 6. 持久化

- 路径：`sessionPaths.sessionDirFor(managerSessionId)` + `stateFileName`（缺省 `agent-group.json`）。
- 写入：`mkdir -p`（0700，幂等；目录通常已由宿主建好）→ 写临时文件（0600）→ `rename` 覆盖 —— 崩溃时不会留下半个 JSON。
- 读取：缺失 → 空状态；JSON 损坏 / 形状不符 → `state_unavailable`（带「删掉该文件后重建」的下一步），**不静默重置**。
- 跨实例：组状态不随进程存活，重开进程后从文件读回；但**组不跨会话恢复**（另一会话看到的是它自己的「组」集合）。

## 7. 降级矩阵

注册与解析分开（`apply` 期用**静态 `inject: ["tools"]`** 保证注册时机；`sessionChannel` / `sessionPaths` / `sessions` / `memory` 走 `ctx.inject([...], cb)` **子分叉**绑定、每次 `execute` 再解析、成功才缓存 → 服务晚到可自愈；2026-10-19 真机修正，取代 2026-10-17「不写 inject」的裁定）的机制与各依赖缺失时的行为 / 错误码见 `README.md` 的「依赖与降级」；README 未列的补充：`add_member` 目标离线 / 歧义 → `target_offline` / `target_ambiguous`，`send` 投递失败结算为 `failure`，状态文件损坏 → `state_unavailable`（不静默重置，见 §6）。

## 8. 与设计文档的偏差（实现阶段记录）

| 设计口径 | 实现口径 | 原因 |
| --- | --- | --- |
| 镜像 API 写作 `registerKind({kind, writableTiers}).put({tier, sessionId, …})` | ~~用仓内现行 memory-base 服务面：`registerKind(KindSpec)` + `remember(RememberInput)`；`source` 用 `{kind: "manual", label: "agent_group", ref}`~~ | ~~memory-base 的 `SourceKind` 是闭合联合（`session/file/url/tool_result/manual`），没有 `agent_group`；`put` 方法在现行服务面上不存在（`memory-base/src/index.ts:824`、`:839`）~~ —— **2026-10-20 被下一行取代（上一版读错了服务面：`remember` 不在服务上，写权限本就在 `registerKind` 返回的句柄上）** |
| 镜像写入口（2026-10-20 真机修正） | `registerKind(KindSpec)` 拿 `MemoryScope` 写句柄，写入走 `scope.put({tier: "session", sessionId, project, content, title, source})` | 真机实测：上一版把 `remember` 当服务方法、`isMemoryFace` 判定失败 → `mirror.enabled=false`、库中从无 `agent_group` 记录。回归用例 `tests/main.test.ts` 的 `fakeMemory` 已改为 `registerKind` 返回 `{put}` 形状 |
| 指令「由主方发」 | 物理投递的 `delegate.from` = 主方成员的会话 id（未知时回落管理者会话 id） | 结果通知归主方语义；管理者仍可用 `taskStatus` 读到结果（任务表全局） |
| 回报三态「成功 / 失败 / 受阻」 | 通道只有 `failed: boolean`；本包约定 `failed: true` + `error: "blocked: …"` 表示受阻并剥掉前缀 | session-channel 的追踪文档已定「通道不规定语义，三态由 agent-group 自描述」 |
| `status` 只读 | 只读且不落盘、不镜像；命中缓存时不碰存储 | 让「目录解析运行期失败」时只读面仍可用（验收细化第 9 条） |
| 无 TUI 消费面（§9 曾列「TUI 命令或面板」为不做） | `apply` 额外 `ctx.provide("agentGroup", { status })` **只读服务面**（与动作 `status` 同源 `readGroupStatus`），TUI `/group` 命令经 `ctx.get("agentGroup")` 消费（BACKLOG #3 落地；未挂载时调用方降级提示） | 需求演进：TUI 需免问模型直读组状态；插件侧只提供只读查询面，命令在 TUI 侧实现（COMMANDS-SPEC 落点决策）；**状态列二期仍不做** |
| 缺依赖 → 不注册工具 + 一次警告（apply 期门禁） | ~~**工具照常注册**，缺依赖改为调用期错误（原因 + 下一步）~~ | ~~真机实测（2026-10-17）：`sessionChannel` / `sessionPaths` 晚于本包激活且无法经 `inject` 解析，注册被推到 agent 创建之后 → 工具表不收录（`/tools agent_group` 为 0）。工具定义改为不依赖服务，`execute` 时才组装 `GroupService`~~ —— **2026-10-19 被下一行取代** |
| 注册面一并去掉 `inject`（2026-10-17 裁定） | 静态 `inject: ["tools"]` 恢复声明；`sessionChannel` / `sessionPaths` / `sessions` / `memory` 改走 `ctx.inject([...], cb)` 子分叉绑定，工具仍在 `apply` 期注册 | 真机实测（2026-10-19）：不写 `inject` 时 `ctx.get("tools")` 读到 `undefined`（cordis 4.0.5），工具**从未注册**；兄弟 bundle 提供的服务未注入也读不到。回归用例见 `tests/main.test.ts`「真机形态：兄弟 bundle 的服务直读不到时，经 ctx.inject 分叉仍可用」 |

## 9. 明确不做（当前）

TUI 状态列（二期）；轮次建模与终止细节；结论聚合与投票；启动 / 销毁成员会话；跨机；`experimental-agent-team` 的挂载。均见 `docs/BACKLOG.md`。广播与平等连接（含「每对至多一条」校验）已随二期落地（见 §3 / §4.2，追踪文档 `docs/archived/2026-10-19-agent-group-broadcast.md`）；**只读 TUI 命令 `/group` 已落地**（BACKLOG #3，2026-10-20，追踪文档 `docs/implementation/2026-10-19-agent-group-tui.md`）。
