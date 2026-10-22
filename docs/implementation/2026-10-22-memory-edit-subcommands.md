# `/memory` 的 `replace` 与 `remove` 子命令（接取条目：`docs/BACKLOG.md` §2「1. `/memory` 的 `replace` 与 `remove` 子命令」）

状态：调研（只做调研与候选方案；写权归属待用户裁定，未进决策与实现）　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给 TUI 的 `/memory` 增加两个写子命令：`remove`（删除指定条目）与 `replace`（用新内容替换）。目标是让错误的 U / P 层条目有**唯一且受控的删除路径**——`memory-base` 的删除机制已就绪但全仓无调用方。

交付：命令可定位条目（按 id / 关键字命中后确认）、删除后 `search` 不再返回、计数正确；`replace` 的半途失败可回滚。

边界：不动 S 层（**会话层**，条目正文写的「系统层」是笔误）;不改检索排序与写入闸门；不恢复已移除的 `review` 审阅面板（只顺手修 `commands.ts` 过期描述）。

## 调研

**来源**：本仓 `memory-base/src`（`index.ts` / `scope.ts` / `tiers.ts` / `knowledge.ts` / `schema.ts` / `router.ts` / `tools.ts`）、`TUI/src/app`（`index.ts` / `commands.ts` / `adapter/types.ts` / `adapter/dsh.ts` / `main.ts`），行号为当前分支实测。

### 1. memory-base 的写面与删面现状

- **全局面 `ctx.get("memory")` 八键，无任何写与删**（`memory-base/src/index.ts:128-155` `MemoryGlobalService`：`registerKind` / `checkPrivacy` / `getSummary` / `whenReady` / `usage` / `migrate` / `list` / `search`；`provide("memory", …)` 在 `:346`）。
- **写与删只经 `registerKind(spec)` 返回的 `MemoryScope`**（`memory-base/src/scope.ts:42-47`：`put` / `forget`）：
  - `forget(refs)`（`scope.ts:115-138`）对每个 `{tier, ids}` 先校验 tier 合法且在该 kind 的 `writableTiers` 内（越权抛错），再用 `host.opened(tier, …)` 取**已打开**的库，把 `RowRef` 组装成 `{kind: entry.kind, id}` 后调 `kb.evict(...)`。
  - 两个硬约束：① **只能删自己的 kind**（`RowRef.kind` 写死为句柄的 kind）；② **只作用于已打开的库**（`scope.ts:128-132`，未打开直接跳过、计数为 0）。
  - 会话层（S）删除用的是句柄内部记录的 `lastSessionId`（`scope.ts:67-99`），即「该句柄最近一次 put 的会话」，没有跨会话删除入口。
- 更低一层其实已有可用能力：`TierSet.forget(refs)`（`memory-base/src/tiers.ts:273-283`）走 `openExisting`（`:176-190`，**不建库**，库文件存在即打开），按层真删并返回条数；`KnowledgeService.evict`（`knowledge.ts:490-...`）在一个事务里 `DELETE` 并把 `sources` / FTS 一起收敛。**这层没有暴露到全局面**。
- 层定义：`TIERS = ["session", "project", "user"]`（`router.ts:18`），`KindSpec.writableTiers` 缺省 `["session"]`（`router.ts:45-55`、归一在 `:131-147`）；S 层库按会话目录区分（`tiers.ts` `storeKey` + `sessionPaths`），P / U 各一份。
- 内容闸门在写入侧：`KnowledgeService.put` 先跑 `checkContent`（隐私 + 最小长度，`knowledge.ts:370` 附近）再过 kind 的 `preWrite` 钩子（`:385` 附近），命中拒写时返回 `PutResult.skipped`（不抛错）。FTS 由触发器维护，`schema.ts:144-151` **已有 `AFTER UPDATE` 触发器**——就地改一行内容不会破坏检索索引。

### 2. TUI 侧现状

- `handleMemoryCommand`（`TUI/src/app/index.ts:5210-5239`）：缺省概要；`search`（`:5259-5303`）；`add`（`:5306+`）；`review` 只剩一句「已移除」提示（`:5221-5227`）。
- `/memory` 的命令描述仍写「概要 / review 审阅 / search / add」（`TUI/src/app/commands.ts:326`，条目正文写的 `:319-320` 已随 `/config` 插入漂移）。
- 检索呈现只到 `[tier/kind] 摘要（project）`（`index.ts:5280-5303`），**没有 id**；`adapter.memorySearch` 原样返回宿主命中（`adapter/dsh.ts:4122-4129`），命中里其实带 `id`（`knowledge.ts:38-53` `StoreRow` / `SearchHit`），只是渲染层丢了。
- 服务接线是惰读 getter（`TUI/src/main.ts` 的 `get knowledge()`，注释即「TUI 侧改造条目 D57」），`KnowledgeServiceLike` 只声明 `getSummary` / `whenReady` / `search` / `remember`（`adapter/types.ts:1466-1484`）。

### 3. 顺带发现（不在本条范围，登记备查）

- **`/memory add` 是死路径**：adapter 走 `opts.knowledge?.remember(...)`（`adapter/dsh.ts:4131-4143`），但 `memory-base/src` 里**没有任何 `remember`**（`grep -rn "remember" memory-base/src` 零命中，2026-10-17 接口重设后写侧只剩 `registerKind` 句柄）→ `/memory add` 恒提示写入失败。修复它等于把「用户直写」也搬上管理面，与本条同一决策点，建议合并裁定。
- `commands.ts:326` 的 `review` 字样与 `handleMemoryCommand` 已移除的审阅面板不一致（条目已提到，顺手同步）。

## 候选方案（写权归属）

**方案 A：memory-base 在全局面新增管理面（不经 kind 句柄）**

- 形态：`memory.forget(refs: { tier, kind, id, sessionId? }[])`（删除）+ 视 `replace` 语义再定一个写入口；实现直接复用 `TierSet.forget`（`tiers.ts:273`）与 `KnowledgeService`，在服务层做「S 层拒绝、kind 必须已注册、id 正整数、跨层 ref 逐条结算」的校验。
- 优点：删除能力已经在库里（`TierSet.forget` + `evict` 带事务），只需把它「提升」到全局面并加权限守卫；TUI 拿到的是 `(tier, kind, id)` 三元组，正好是 `search` / `list` 已返回的字段；不动 `registerKind` 的写隔离开口径（句柄仍是各插件写自己 kind 的唯一入口）。
- 代价：全局面从「八键只读」变成「九键里有写」，需要在 `memory-base/README.md` 与 DESIGN 的口径里显式写清「管理面只做删除 / 编辑，不做新增写入」。
- `replace` 的两种落地：
  - A1 **就地更新**：在 `KnowledgeService` 增 `updateRow(ref, patch)`（单条 `UPDATE` + 跑一遍内容闸门与 kind `preWrite`，失败即拒、原行不动；`_au` 触发器已覆盖 FTS）。语义上是「改内容」，没有半途状态，天然原子，不需要回滚。
  - A2 **先删后写**：管理面 `replace = forget + put`。两次独立事务 → 写失败时行已删（需先读出原行再补写回滚，回滚本身也可能失败），比 A1 差。

**方案 B：TUI `registerKind` 一个自己的 kind，用句柄 `forget`**

- 形态：TUI 注册 `kind: "tui"`，拿句柄删条目。
- 致命问题：`MemoryScope.forget` 把 `RowRef` 的 kind 写死成句柄的 kind（`scope.ts:134`），**只能删 `kind = "tui"` 的行**，删不到 rule-engine / preference-analysis 等真正写错的条目——恰好是本条要解决的问题。
- 结论：不可行（除非把 `forget` 改成「按 ref 自带 kind」，那就等于绕开了按扩展隔离这个设计，比方案 A 更贵）。

**方案 C：由各写入方（各 kind 的所有者插件）自己暴露编辑能力**

- 形态：谁能写谁负责改，TUI 只做转发。
- 代价：要把 rule-engine / preference-analysis / output-compress 等每个消费者都改一遍，且「用户纠正一条错记忆」需要知道它当初是谁写的——与本条「唯一且受控的删除路径」的目标相反。
- 结论：不推荐。

## 建议

1. **写权归属选方案 A**：memory-base 在全局面新增一个**管理面**（删除 + 就地更新），不经 kind 句柄；理由见 A 的优点与 B 的致命问题。
2. **`replace` 选 A1（就地更新）**：单条 `UPDATE` 事务 + 复用现有内容闸门与 `preWrite`，失败不动原行；比 A2「先删后写 + 回滚」简单且真正原子。若用户坚持「replace = 先删后写」的字面语义，则 A2 需要在管理面里做「先读原行 → 删 → 写失败则回写」的补偿事务，并把补偿失败如实报给用户。
3. **S 层拒绝**：管理面对 `tier === "session"` 一律拒绝（会话库按会话目录区分，跨会话删除语义不明；条目正文的「S 层系统层」按笔误更正为「会话层」）。
4. **TUI 侧寻址**：`search` 结果行补 `#<id>`（host 命中已带 `id`），`remove` / `replace` 用 `(tier, kind, id)` 三元组寻址；再补一个 `/memory list [tier]` 便于按 id 定位（`list` 也已在全局面）。
5. **顺带修 `/memory add`**：若采纳管理面，add 也一并改走管理面的写入入口（或明确下线该子命令），避免继续留一条死路径。

## 待用户裁定

- 写权归属：方案 A / B / C（建议 A）。
- `replace` 语义：A1 就地更新（建议）/ A2 先删后写 + 补偿。
- 范围：是否把 `/memory add` 的死路径修复并入本条。

## 决策

（待用户裁定后填；当前未进入决策）

## 规划

### 计划改动文件清单

（待裁定后定稿；候选范围）

- `memory-base/src/index.ts`（全局面新增管理面）+ `memory-base/src/knowledge.ts`（`updateRow`）+ 可能的 `memory-base/src/tiers.ts` 导出调整
- `TUI/src/app/index.ts`（`handleMemoryCommand` 增 `remove` / `replace`）、`TUI/src/app/commands.ts`（描述去掉 `review`、补子命令）
- `TUI/src/app/adapter/types.ts` + `adapter/dsh.ts`（管理面结构面与调用）
- 两侧测试：`memory-base/tests`、`TUI/tests`

### 验收

（初判，待裁定后定稿）

- 删一条 U / P 条目后 `search` 不可见、计数正确；对不存在的 ref 返回 0；S 层越权明确拒绝并给原因。
- `replace` 中途失败时原条目仍在（或被明确回滚），FTS 检索同步更新。
