# agent-group 广播与平等连接（接取条目：agent-group/docs/BACKLOG.md「广播与平等连接」）

状态：规划　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按设计决策项 4 / 6 / 20（`docs/archived/2026-10-16-peer-group-protocol-design.md`）落地二期连接能力：平等连接（双向、发完即走、不留未结指令、不记等级）；广播（一条指令按当前成员集合展开、逐条送达 / 失败可区分并汇总）；「任意两个 agent 之间每种连接至多一条」的校验。验收按条目：每对 agent 两种连接各至多一条；广播逐条送达 / 失败可区分；平等连接不产生未结指令。

## 调研

来源：`docs/archived/2026-10-16-peer-group-protocol-design.md`（决策项 4 / 6 / 7 / 13 / 20 与本文件「规划」的接口冻结） + `agent-group/src/{types,model,core,transport,main}.ts` 现状通读 + 既有测试面。

### 1. 现状（首期已落地）

- 主从连接：`AgentGroupState.links: Record<从方名, GroupLink>`（从方为主键 → 每 agent 至多一主，决策项 7）；`GroupLink{from,to,level,createdAt}`；等级严格递增、从方须自由代理（决策项 8/9）；连接不可解除（决策项 10）。
- 指令：`instructions[]`，每条主从连接同时至多一条 `open`（决策项 14）；`send` 走 `delegate`（task 语义），`check` 懒判定结算。
- 传输 `GroupTransport`：`resolve` / `delegate` / `taskStatus` —— **没有**「发完即走」的消息口。
- 动作 7 个：`create_group / add_member / link / send / check / remove / status`；工具 def 的 `action` enum 在 `src/main.ts`。
- 只读视图 `groupView` 与不变量自检 `invariantViolations` 只认 `links`（主从）。

### 2. 二期决策依据（本任务范围）

- 决策项 4：两种连接（主从 + 平等），任意两个 agent 之间**每种**连接至多一条；成员彼此也可有平等连接。
- 决策项 6：平等连接双向可发、**发完即走**、不等回复、不重试、**不留状态**（= 不产生未结指令、不记等级）。
- 决策项 13：无显式开始，指令随时可按**当前**成员集合展开。
- 决策项 20：二期「广播（连带平等连接的记录与『每对至多一条』校验）」。
- 验收口径（BACKLOG #2）：每对 agent 两种连接各至多一条；广播的逐条送达 / 失败可区分；平等连接不产生未结指令。

### 3. 传输面探测（session-channel 服务面）

`session_channel` 的 `send({to, text, waitMs})` 返回 `{ok, delivered?, error?}`：注入目标下一回合并在 `waitMs` 内回执 —— 天然是「发完即走 + 是否送达」的语义，适合平等连接发消息与广播（不产生任务记录、不留未结）。`delegate` 仍是主从指令专用（产生 task，需 `check` 结算）。

## 决策

决策项 1　平等连接的存储形态：a 并入 `links`（加类型字段）　b **新增独立 `peerLinks: Record<对键, GroupPeerLink>`**　c 内存态不落盘
→ 选定 **b**。理由：`links` 的「从方为主键 + 等级」语义与平等连接「双向、无等级、每对一条」正交，混存会污染既有不变量与 `groupView`；落盘形状新增 `peerLinks` 字段（`version` 仍为 1 —— 加载时对缺失字段按空处理，不升协议版本，符合「不动协议版本号」）。
对键约定：`a.b`，`a < b` 按字典序（组内名只含 `[A-Za-z0-9_-]`，故 `.` 不会撞名）。

决策项 2　平等连接的动作面：a 只建连接（发消息复用 `send_peer`）　b **`link_peer`（建）+ `send_peer`（经平等连接发一条消息，发完即走）**　c 建连即发
→ 选定 **b**。`link_peer {group, from, to}` 建立双向连接（校验：成员存在、不自连、该对尚无平等连接）；`send_peer {group, to, text}` 由管理者经与 `to` 的平等连接发消息，走 `transport.sendMessage`（`session_channel send`），返回 `delivered` 或失败；**不落未结指令、不落任何指令记录**（决策项 6）。

决策项 3　广播的语义与目标：a 走主从指令（每条产生未结、逐个 check）　b **消息式：按当前成员集合逐条 `send`，汇总逐条送达 / 失败，不产生未结指令**　c 只发给有平等连接的成员
→ 选定 **b**。`broadcast {group, to?, text}`：`to` 缺省 = 除管理者外的全部成员；逐个目标走 `session_channel send`，返回 `results: [{to, delivered, error?}]` + `delivered/failed` 计数。读作「一条通知发多人、发完即走」；要带回报的任务仍用主从 `send`/`check`。与决策项 6 一致（消息不留状态），避免 N 条未结需要逐个 check 的复杂面与副作用。

决策项 4　平等连接与主从的关系：a 互斥（一对只能有一种）　b **独立并存（每对各至多一条主从 + 各至多一条平等）**　c 平等需先有主从
→ 选定 **b**，忠实于决策项 4「每种连接至多一条」。「每对两种连接各至多一条」由校验保证：主从侧靠「以从方为主键 + 自由代理」天然成立（同向重复被自由代理挡住，反向会形成环/非自由被拒），平等侧靠 `peerLinks` 对键唯一。

决策项 5　移除成员时平等连接的处置：a 保留　b **一并删除（该成员参与的所有平等连接）**　c 报错
→ 选定 **b**。移除成员 = 该成员退出组，牵连连接都应清掉（与主从连接随成员移除同口径，决策项 10 的纯状态改动思想）；`status` 与 `invariantViolations` 同步。

决策项 6　不变量自检扩展：平等连接两端须存在、对键形态合法（`a.b` 且 a\<b）、无重复对 —— 并入 `invariantViolations`。
→ 选定该项。

## 规划

任务拆分（按决策项 1 至 6）：

1. `src/types.ts`：新增 `GroupPeerLink`、`AgentGroupState.peerLinks`、`GroupView.peerLinks`（+ `summary.peerLinks` 计数）；运输口新增 `sendMessage`；动作参数 / 结果形态（link_peer / send_peer / broadcast）。
2. `src/model.ts`：`peerPairKey` / `peerLinksOf`；`linkPeer`（纯迁移：校验 + 落 `peerLinks`）；`removePeerLinksOf`（移除成员时清连接）；`groupView` 补平等连接视图与计数；`invariantViolations` 补平等连接检查；`removeMember` 联动清平等连接。
3. `src/transport.ts`：`createSessionChannelTransport` 增加 `sendMessage`（走服务面 `send`，`waitMs` 取小值拿回执）。
4. `src/core.ts`：动作 `link_peer` / `send_peer` / `broadcast` 编排（读状态 → 纯迁移 / 校验 → 投递 → 落盘 → 镜像 → 结果），`run` 分派扩展，`next` 提示。
5. `src/main.ts`：工具 def 的 `action` enum 与参数、description 扩展（8 个动作）。
6. 测试：`model.test.ts`（linkPeer 校验 / 每对至多一条 / 移除联动 / 不变量）、`core.test.ts`（三个动作编排 / 送达与失败可区分 / 不产生未结）、`main.test.ts`（enum 与参数）；`transport` 假面补 `send`。
7. 文档：`README.md` 能力表与动作表、`docs/DESIGN.md` §3 数据模型 / §4 状态机 / §8 偏差（如需）。

计划改动文件清单：

- `agent-group/src/types.ts`
- `agent-group/src/model.ts`
- `agent-group/src/transport.ts`
- `agent-group/src/core.ts`
- `agent-group/src/main.ts`
- `agent-group/tests/model.test.ts`
- `agent-group/tests/core.test.ts`
- `agent-group/tests/main.test.ts`
- `agent-group/README.md`（按需）
- `agent-group/docs/DESIGN.md`（按需）
- 本追踪文档

明确不做：不做轮次建模（属 `#4`）；不改协议版本号（`peerLinks` 缺省按空处理）；不动 TUI 侧入口（属 `#3`）；不改主从指令与 `check` 语义；不动 7 个既有动作的行为。

## 实现记录

- 2026-10-20（实现）：按决策项 1 至 6 落地：
  - `src/types.ts`：新增 `GroupPeerLink`、`AgentGroupState.peerLinks`（对键 `a.b`）、`GroupView.peerLinks` + `summary.peerLinks`；传输口新增 `sendMessage`（= session-channel `send`，回执 `delivered`）。
  - `src/model.ts`：`peerPairKey` / `peerLinksOf` / `removePeerLinksOf` / `linkPeer`（纯迁移：成员存在 / 不自连 / 每对至多一条）；`removeMember` 联动删除参与的全部平等连接；`groupView` 补平等连接视图与计数；`invariantViolations` 补对键形态 / 两端存在 / 键与两端一致。
  - `src/transport.ts`：`SessionChannelFace` 加 `send`；`sendMessage` 实现（`waitMs` 1200 拿回执）。
  - `src/core.ts`：动作 `link_peer`（建连 + 落盘 + 镜像）、`send_peer`（需先有与管理者的平等连接；发完即走，失败带原因）、`broadcast`（缺省全体非管理者 / `to` 子集按逗号 / 空格分隔；逐条 `sendMessage`，`results[]` 逐条 `delivered` / `error`，`delivery` 汇总）；`run` 分派扩至 10 个动作。
  - `src/main.ts`：工具 def 的 `action` enum（10 项）与参数描述扩展。
  - 测试：model +11（对键 / linkPeer 校验与每对至多一条 / 自连与成员缺失拒绝 / 移除联动 / 不变量 / 视图计数），core +4（link_peer / send_peer 含未建连接拒绝与投递失败 / broadcast 正常与部分失败可区分 / 子集校验与空正文），main +1（端到端：link_peer → send_peer → broadcast，断言 delivered 与无未结）与 enum 断言更新、fakeChannel 补 `send`。
  - `FakeTransport` 补 `sendMessage`；`GroupTransport` 匿名实现补 `sendMessage`。
- 验证：`npm run check` / `npm run test` 全绿（54 例，0 fail）；`npm run build` 通过。
- 真机复验：待合主 + 重建 dist 后按决策口径跑 `link_peer → send_peer → broadcast` 并核对 `status` 的平等连接与无未结（届时回填「测试与证据」）。

## 偏差

- 广播语义按决策项 3 采用「消息式、不产生未结」—— 与部分人直觉里「广播 = 多条指令」不同，缘由与取舍见决策项 3 理由。
- 平等连接只支持「管理者 ⇄ 成员」之间的 `send_peer`（发送方恒为管理者会话）；成员间平等连接可建（`link_peer` 不限），但经平等连接发消息仅管理者入口 —— 因为调用方身份即管理者（决策项 11；成员会话不直接调本工具）。**用户 2026-10-20 裁定维持该口径**：成员间发消息留二期（届时在 `send_peer` 增加 `from` 参数或另开门径）。
- 旧落盘文件缺 `peerLinks`：`store.load` 补齐空对象（不升 `version`），见实现记录。

## 测试与证据

代码侧（`agent-group/`，2026-10-20）：

- `npm run check` → 通过（src + tests 双 tsc --noEmit）。
- `npm run test` → 54 / 54 通过（model 26 / core 16 / main 12；0 fail），覆盖：
  - 平等连接：对键字典序、每对至多一条、不自连、成员缺失拒绝、移除成员联动删除、不变量自检、视图计数；
  - `link_peer` / `send_peer`：建连、未建连接发消息被拒（`no_peer_link`）、经连接发送回执 `delivered:true`、投递失败带 `target_offline`、全程无未结指令；
  - `broadcast`：缺省全体非管理者、`to` 子集、逐条 `results`（送达 / 失败可区分）、`delivery` 汇总计数、成员缺失与空正文拒绝、无未结；
  - 工具面：`action` enum 10 项 + 端到端（假服务面）。
- `npm run build` → 通过（dist 产出，仅存 worktree，未部署）。
- 真机侧：待合主 + 重建 dist 后复验 `link_peer → send_peer → broadcast`（成员在线投递与离线失败、`status` 的 `peerLinks` 与 `open=0`）。

## 收尾

- BACKLOG「广播与平等连接」条目保持〔进行中〕；真机复验通过后标记完成并移除，本文件归档 `docs/archived/`。
- 文档回写：`README.md`（能力表 10 动作 / 规则 / 传输 / 示例 / 边界 / 文件）、`docs/DESIGN.md`（§3 数据模型 / §4.2 状态机 / §9 明确不做）已同步。
- 提交：2026-10-20 用户裁定本实现提交到 worktree 分支 `dsh/agent-group`（附追踪文档）；真机复验依赖合主 + 重建 dist。
- 遗留：真机复验（合主后）；成员间发消息属二期（用户已裁定，见偏差）。
