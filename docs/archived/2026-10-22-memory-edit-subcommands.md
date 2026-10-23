# `/memory` 的 `replace` 与 `remove` 子命令（接取条目：`docs/BACKLOG.md` §2「1. `/memory` 的 `replace` 与 `remove` 子命令」）

状态：已关闭（2026-10-23；决策 A + A1 + add 死路径并入）　　开启：2026-10-22　　关闭：2026-10-23
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

## 决策（2026-10-23 用户裁定）

- **写权归属：方案 A** —— `memory-base` 全局面新增管理面（删除 / 就地更新 / 用户直写），不经 kind 句柄。
- **`replace`：A1 就地更新** —— 单条 `UPDATE` + 内容闸门与 `preWrite`，失败不动原行。
- **`/memory add` 死路径：并入本条修复** —— add 改走管理面的写入入口。
- 沿建议 3 / 4：管理面对 `session` 层一律拒绝（S 层按会话隔离，跨会话语义不明）；TUI 用 `(tier, kind, id)` 寻址，`search` 行补 `#id`，新增 `/memory list [tier]`。
- 范围外（不做）：`replace` 重新分块（单行就地改，长内容不拆块，文档写明）；`review` 面板不恢复。

## 规划

### 计划改动文件清单（定稿）

- `memory-base/src/knowledge.ts`：`KnowledgeService.updateRow(ref, patch)` + `UpdateResult` / `UpdateSkip`（内容闸门、`preWrite`、同表 `content_hash` 冲突拒绝、单条 `UPDATE`）。
- `memory-base/src/index.ts`：`MemoryGlobalService` 增 `forget` / `update` / `remember`（管理面；`session` 拒绝、kind 必须已注册、id 为正整数）；`createGlobalService` 实现。
- `memory-base/README.md`（与 `docs/DESIGN.md` 如提及服务面口径）：八键只读 → 八读 + 三管理写。
- `TUI/src/app/adapter/types.ts`：`KnowledgeServiceLike` 增 `list` / `forget` / `update` / `remember`；`DshAdapter` 增 `memoryList` / `memoryForget` / `memoryReplace`，`memoryAdd` 改走管理面（tier 收窄为 project / user）。
- `TUI/src/app/adapter/dsh.ts`：上述四个方法实现。
- `TUI/src/app/index.ts`：`handleMemoryCommand` 增 `list` / `remove` / `replace`，`search` 行补 `#id`，`add` 走管理面并收窄 tier，usage 与 `review` 提示同步。
- `TUI/src/app/commands.ts`：`/memory` 描述去掉 `review`、补 `list` / `remove` / `replace`。
- 测试：`memory-base/tests/admin-surface.test.ts`（新增）、`TUI/tests/memory-edit.test.ts`（新增）。

### 验收（定稿）

- `remove`：删 U / P 条目后 `search` 不可见、计数正确；不存在的 ref 返回 0；`session` 层明确拒绝并给原因。
- `replace`：成功后就地更新且 FTS 命中新内容、旧内容不再命中；内容闸门 / `duplicate` / 行不存在时原行不动并如实回报。
- `/memory add`：project / user 层写入成功（过内容闸门与 `preWrite`）；U 层缺 `--kind` 拒绝；`session` 层明确拒绝。
- 全仓 `check` / `build` / `test` 绿。

## 实现记录（2026-10-23）

- `memory-base/src/knowledge.ts`：`KnowledgeService.updateRow(ref, patch)`。顺序：kind 已注册 → 表存在 / 行存在（`missing`）→ `checkContent`（`empty` / `short` / `pattern`）→ `preWrite`（`hook`）→ 同表 `content_hash` 撞别的行（`duplicate`）→ 单条 `UPDATE`（内容 / hash / 标题 / 重要度）；`_au` 触发器同步双 FTS。**不重新分块**（`DESIGN.md` §10 已记）。
- `memory-base/src/index.ts`：全局面新增三管理写并在 `createGlobalService` 实现 —— `forget(refs)`（逐条 `openExisting` + `evict`，返回删除数）、`update(ref, patch)`（`openExisting` → `updateRow`；库不存在 = `missing`）、`remember(input)`（`tiers.write`，不经句柄、不受 `writableTiers` 限制；内容闸门与 `preWrite` 仍生效）。参数级校验：`session` 层、未注册 kind、非正整数 id 一律抛错（与句柄的「参数级抛错」同口径）。
- `memory-base/README.md` / `docs/DESIGN.md`：服务面从「八键只读」改为「八读 + 三管理写」，补管理面参数 / 返回 / 边界；TUI `/memory` 一栏从「待适配」改为已收敛。
- `TUI/src/app/adapter/types.ts`：`MemoryRowRef`；`KnowledgeServiceLike` 增 `list` / `forget` / `update` / `remember`（tier 收窄为 project / user）；`DshAdapter` 增 `memoryList` / `memoryForget` / `memoryReplace`，`memoryAdd` 改为管理面直写（kind 必填）。
- `TUI/src/app/adapter/dsh.ts`：四个方法实现；`memoryForget` / `memoryReplace` / `memoryAdd` 把参数级抛错折算成 `reason` / `skipped` 文案，管理面缺失时如实提示。
- `TUI/src/app/index.ts`：`/memory` 增 `list [project|user] [--kind <k>]`、`remove <tier> <kind> <id>`、`replace <tier> <kind> <id> <content>`；`search` / `list` 行统一 `· #id [tier/kind] 摘要（project）`；`add` 改为 `<project|user> --kind <k> <content>`（S 层与缺 kind 前置拒绝）；`review` 提示与 usage 同步。
- `TUI/src/app/commands.ts`：命令描述去掉 `review`，补 `list` / `remove` / `replace`。

## 测试与证据（2026-10-23）

- 新增 `memory-base/tests/admin-surface.test.ts`（8 例）：就地更新 + FTS 新旧内容对照、内容闸门 / `preWrite` 拒绝后原行不动、行不存在 / 重复内容 / 未注册 kind、删除计数与幂等 + 摘要计数、S 层 / 非法 id / 未注册 kind 抛错、`remember` 直写（含绕过 `writableTiers` 的口径与 S 层拒绝）、冷启动 `list` 按需打开既有 U / P 库、冷启动 `forget` / `update` 经 `openExisting` 作用于既有库。
- 更新 `memory-base/tests/bundle-tiers.test.ts` / `exposure.test.ts` 的服务面断言（八键 → 八读 + 三管理写）。
- 新增 `TUI/tests/adapter.dsh.test.ts` 4 例（真实 adapter 的 `memoryList` / `memoryForget` / `memoryReplace` / `memoryAdd`：参数透传、异常折算成 reason / skipped、管理面缺失降级）。
- 新增 `TUI/tests/memory-edit.test.ts`（11 例）：`list`（#id 呈现 / tier + kind 过滤 / 管理面缺失）、`remove`（成功 / removed 0 / S 层与非法 id 前置拒绝）、`replace`（成功 / duplicate 文案）、`add`（成功 / S 层与缺 kind 拒绝）、`search` 行带 #id。
- 命令结果（worktree `.worktree/b-app`）：
  - 根 `npm run check` → 31 包全通过；`npm run build` → 31 包全通过；
  - 根 `sh scripts/test-parallel.sh` → 31 包全 OK（TUI 1745 / memory-base 82，其余 29 包全绿）；
  - 说明：本 worktree 原先只有 TUI 的 `node_modules`，为跑全仓检查从主仓按包建立 `node_modules` 符号链接（均在 `.gitignore` 内，收尾时移除）。
- 未做：真机验收（`/memory list` → `remove` / `replace` / `add` 的真实 dsh 会话）留待用户；`replace` 只传内容（不提供改 title / importance 的 TUI 入口）。

### 补充：`list` 冷启动可见性（实现中发现）

- 原先 `list` 只遍历**已打开**的库：新进程里若没有插件先写过，`/memory list` 恒空，`remove` / `replace` 无从拿到 id（`forget` / `update` 本身走 `openExisting`，冷启动可用）。
- 调整：全局 `list` 在列举 U / P 层前按需 `openExisting`（只开既有库、不建库；只列某一层时不开另一层）。**读面无写副作用**不变，`search` 维持原样（本条目不需要）。
- 用例：`memory-base/tests/admin-surface.test.ts`「list：冷启动按需打开既有 U / P 库」；`README` / `DESIGN.md §4` 已同步口径。

## 关闭（2026-10-23，主分支）

- **合并**：b-app 组提交 `02d79c0`（基于 `09956cb`），合并提交 `6ab5b43`；与 main 无文件重叠，合入后主树干净。
- **复核**：合并后主分支独立复跑 —— 根 `npm run check` 通过；`memory-base` 82/82、`TUI` 1745/1745 全绿（与交付报告一致）。
- **改动面**：`memory-base` 管理面 `forget` / `update` / `remember`（只 U / P，S 层拒绝）+ `TUI` 的 `/memory list|remove|replace`（`search` 行带 `#id`）+ `/memory add` 死路径修复（改走管理面，`kind` 必填）；`README` / `DESIGN.md` 同步。
- **未做**：真机验收（真实会话里跑 `/memory list` → `remove` / `replace` / `add`）——按用户指令本轮直接归档，真机留待后续按需补。
- **收尾**：条目从 `docs/BACKLOG.md` §2 移除并补关闭注记；并行分组表删去 B3 行；本文件移入 `docs/archived/`。
