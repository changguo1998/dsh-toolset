# Home / End 语义交换 + Home 分批加载更旧（接取条目：`TUI/docs/BACKLOG.md`「Home / End 语义交换 + Home 改为『分批加载更旧』」）

状态：进行中（2026-10-10 接取；条目原〔暂停〕，本轮按用户指令解暂停）

## 目标

用户 2026-10-06 裁定：

- **`End` = 翻到最新**（即原 `Home` 行为：跟随底部 + 渐进窗口复位默认组数）。
- **`Home` = 往回翻到最旧「已加载」内容**（**不是**一次性全量物化）。
- **已在最旧已加载处再按 `Home` → 继续加载更旧消息**，视口锚点停在原内容（内容从上方长出）。

## 调研

- 现状（`src/app/index.ts:2508-2515`）：`home` → `scroll-to-bottom`（回底 + `windowGroups` 复位 `DIALOGUE_KEEP_REPLIES`）；`end` → `scroll-to-oldest`（窗口一次扩到 `sectionGroupCount` + 锚点 `{key: TOP_OLDEST_KEY, row: 0}`）。
- 定位模型（六步流水线后）：视口位置 = **段键 + 段内行**（`state.dialogueTop: DialogueTop`）；帧内段键表由 `buildTopRegion` 回填 `FrameScrollReport`（`dialogueKeys` / `dialogueCounts` / `dialogueTopIdx` / `dialogueMaxScroll` / `dialogueViewportH`），App 用 `positionAt(createLineTable(counts), keys, idx)` 造出新的 `dialogue-scroll`。
- 「已加载」= 当前 `windowGroups` 物化的尾部 N 组；更早的组被折叠成**占位行**（`MARKER_KEY = "@marker"`，`layout.ts:1361` 把它放在段键表首位）。
- 扩窗 = `window-grow`（`state.ts:2092`，只改 `windowGroups`，**不动视口**）；因为锚点是「段键 + 行」，扩窗后同一段键仍指向同一内容 → 内容自然从上方长出、视口不跳。
- `PgUp` / `PgDn` 已有「目标不在已物化窗口内 → 先扩窗再跳」的实现（`index.ts:2457-2485`，2026-10-10 真机验收缺陷修复），本次的 Home 是本条的**对称补全**。

## 决策

- **D1 键位**：`End` → `scroll-to-bottom`（原 `home` 的行为，含窗口复位）；`Home` → 新增语义「翻到最旧已加载 / 再按加载更旧」，**不新增 state action**（用既有 `dialogue-scroll` + `window-grow` 组合，App 侧拿帧报告算目标）。
- **D2 每次加载条数（裁定 ①）**：`WINDOW_GROW_STEP`（3 组）——与 `PgUp` / `↑` 的扩窗步长同源，不新设常量。
- **D3「最旧已加载」判定（裁定 ②）**：视口顶行号 ≤ 窗口首行号即为「已在最旧已加载」；窗口首行是占位行（`dialogueKeys[0] === MARKER_KEY`）时首行取 **1**（占位行本身不算已加载内容）。「还能加载」= `state.windowGroups < sectionGroupCount(sectionsOf(state))`。
- **D4 无更旧内容时不动作（裁定 ③）**：已全量物化 + 已在最旧 → 静默 no-op，不发 notice（避免按键噪声；条目「无更旧内容时不动作（或出提示）」允许）。
- **D5 PgUp/PgDn 不动（裁定 ④）**：语义与扩窗行为保持（`PgUp` = 上一条用户消息），不与 Home 合并。
- **D6 随之死掉的旧件一并删**：`scroll-to-oldest` action 与哨兵 `TOP_OLDEST_KEY`（含 `rows.ts` 的哨兵解析分支）在本次改动后全仓无活读者 → 删；`tests/layout4.test.ts:3165` 与 `tests/scroll-position.test.ts:88` 对应用例改为按新语义断言（删哨兵分支断言）。判据沿用上一条目沉淀的三条：`--noUnusedLocals` 归零 + export 面零引用 + 本文件内零活读者。
- **D7 文档**：`TUI/README.md:308` 键位表、`TUI/docs/DESIGN.md:175`（滚动条语义）、`TUI/docs/SPEC.md:695`（§15.2 滚动粒度，现写「Home / End 语义见 BACKLOG 条目 6」）同步为新语义。

## 规划

计划改动文件清单：

- src：`TUI/src/app/index.ts`（home/end 分支）、`TUI/src/app/state.ts`（删 `scroll-to-oldest`）、`TUI/src/app/layout/pipeline/rows.ts`（删 `TOP_OLDEST_KEY` 与哨兵解析）。
- tests：`TUI/tests/layout4.test.ts`、`TUI/tests/scroll-position.test.ts`（改断言），新增 Home/End 语义用例（放 `tests/app.test.ts` 或 `tests/layout4.test.ts`，按现有惯例就近）。
- 文档：`TUI/README.md`、`TUI/docs/SPEC.md`、`TUI/docs/DESIGN.md`、`TUI/docs/BACKLOG.md`（进行中 → 完成）。

## 实现记录

- 2026-10-10：
  - `src/app/index.ts`：`case "end"` → `scroll-to-bottom`（原 `home` 行为）；新增 `case "home"` 两分支（翻到最旧「已加载」/ 再物化一批），判定 `firstContent = r.dialogueKeys[0] === MARKER_KEY ? 1 : 0`，扩窗分支不动 `dialogueTop`。
  - `src/app/state.ts`：删 `scroll-to-oldest` action 与其 import（`TOP_OLDEST_KEY`、以及随之闲置的 `sectionGroupCount` / `sectionsOf` import）。
  - `src/app/layout/pipeline/rows.ts`：删哨兵 `TOP_OLDEST_KEY` 常量与 `indexOfTop` 的哨兵分支（JSDoc 同步）。
  - 测试：`tests/app.test.ts` 新增「Home / End 语义…」用例；同文件「上滚越顶 / End 之后 ↓ 立即响应」用例里 `End` → `Home`（那处表达的正是「跳到最旧」，语义随裁定转移到 `Home`）；`tests/layout4.test.ts` 的扩窗断言改用 `window-grow`；`tests/scroll-position.test.ts` 删哨兵断言与 import。
  - 文档：`README.md` 键位表、`docs/DESIGN.md:175`（滚动条语义）、`docs/SPEC.md:695`（§15.2 滚动粒度）。
  - **未新增 state action**（D1）：Home 用既有 `dialogue-scroll` + `window-grow` 组合在 App 侧算目标；`state.ts` 因此净减一个 action。

## 测试与证据

- `npm run check`：干净；`npx tsc --noEmit --noUnusedLocals`：**0 条**；`npm run build`：通过；`npm test`（TUI）：**1420 / 1420 通过**（改动前 1419 + 新增用例 1）。
- 新增用例断言（`tests/app.test.ts`）：Home 不扩窗 + 停止跟随底部 + 落段键锚点；再按 Home 扩窗一批且 `dialogueTop` **deepEqual 不变**（锚点不动）；End 回最新 + 清锚点 + 渐进窗口复位默认值；连按 40 次后 `windowGroups` 不再增长（更早回合已全部物化 → 静默不动作），且未被拉回底部。
- **反向可验证性**：改动前 `Home` = `scroll-to-bottom`（跟随底部 + 窗口复位）→ 新用例「Home 后停止跟随底部」「Home 不扩窗」两条必失败；改动前 `End` = `scroll-to-oldest`（不跟随底部）→ 「End 回最新（跟随底部）」必失败。故这组断言能真正锁住新语义（非改前也通过的同义反复）。
- 未做：真机目视（条目验收含键位手感；本机沙箱禁写 `~/.dsh`，起不了真机——建议用户真机各按一次 Home / End 复核）。

## 收尾

（待填）
