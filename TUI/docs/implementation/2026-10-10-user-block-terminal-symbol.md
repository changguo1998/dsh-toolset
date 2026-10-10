# 用户块终态符号始终是 `?`（接取条目：`TUI/docs/BACKLOG.md`「自己发的用户块终态符号始终是 `?`（不变 `✓`）」）

状态：关闭　　开启：2026-10-10　　关闭：2026-10-10
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

回合结束后，用户自己发的消息块的终态符号在同一帧内变为 `✓` / `✗` / `■`，不再停在 `?`（不依赖下一次输入）。

## 调研

**已复现（端到端探针 `tmp/probe-item6b.ts`：App + 真实 adapter + 真实键输入，未入库）**：

| 场景 | 用户块符号 |
| --- | --- |
| 正常两回合（App 本地预测回合号 == 宿主 `turn/start` 号） | `●` → 同帧 `✓`（正常） |
| **宿主回合号与 App 本地预测漂移**（App 预测 3，宿主说 9） | 永远 `?`（复现症状） |
| `reason: interrupted` / `max-tokens` / `blocked` | 保持 `?`（**既有设计**） |

- 漂移可复现路径：用户块由 App 在**发送时**本地交付（`index.ts` 的 `sendUserText` → `deliverLocal({kind:"user", turn: predictedTurn, …})`，`predictedTurn = pipelineLastTurn + 1`）；而 `turn-end` 交付的回合号来自**宿主**（`adapter/dsh.ts` 的 `explicit.turn ?? liveScope.turn`）。两者不一致时，`applyTurnEnd`（`sections.ts:443-477`）按 `section.turn === turn` 精确匹配找不到用户条目 → `userStatus` 永不落 → 渲染回落到 `?`（`layout.ts:2150-2156` 的无终态分支）。
- 漂移的真实来源：恢复会话重放时 `sectionsFromBuffer` 用**本地序数**回合号（分隔线行没带宿主回合号时），随后宿主继续用它自己的编号 → 预测恒偏；而宿主 `turn/start` 不会回填已交付分隔线的回合号（`pipeline-app.test.ts` 注释：「宿主 turn/start：回填回合号（分隔线 ⇆N）。无交付」）。
- `interrupted` / `max-tokens` / `blocked` 保持未定是**两处一致的设计**（`adapter/dsh.ts` 的 `turnEndReason` 注释、`state.ts:1189-1211` 的 `markUserBlockStatus` 都只映射 completed / aborted / error）→ 本条目**不改**（改它属「终态口径」的独立裁定）。

## 决策

- **D1 按「回合世代」落终态（实现前审阅修正）**：初版方案是「严格匹配失败 → 退到最后一个尚无终态的 user 条目」，审阅指出这是**真误标**——`interrupted` / `max-tokens` / `blocked` 收尾的回合按设计**不落终态**，其用户块会被下一回合的 `completed` 回溯标成 `✓`（且 steer 块、幂等也受影响）。改为**世代门**：`SectionsState` 增 `turnEnds`（每次 `turn-end` +1），用户条目交付时记 `Item.generation = turnEnds`；`turn-end` 只标记**本世代**（`generation === turnEnds`）且未定态、非 steer 续接的用户条目，随后世代 +1（本回合的块就此消费）。既不依赖回合号匹配，也不回溯更早的块。
- **D2 不改 reason 映射**：completed → `✓`、aborted → `■`、error → `✗`，其余保持未定（既有设计，与状态层同口径）；本条目只解决「该落而没落」。
- **D3 不动 App 的回合号预测**：漂移的根因（本地预测 vs 宿主编号 + 分隔线回合号不回填）另立条目，本条目只保证「即使漂移也能落终态」。
- **D4 不覆盖已有终态**：兜底同样遵守「已有终态不覆盖」，且只认 `userStatus === undefined` 的条目。

## 规划

计划改动文件清单：

- src：`TUI/src/app/layout/pipeline/sections.ts`（`applyTurnEnd` 的用户块终态分支加兜底）。
- tests：`TUI/tests/pipeline-panes.test.ts` 或 `TUI/tests/pipeline-sections.test.ts`（节层契约：漂移时仍落终态、正常回合仍落、不误标更早的用户块）；必要时 `TUI/tests/pipeline-app.test.ts`（帧级：`turn/end` 交付后**同帧**见 `✓`）。
- 文档：`TUI/docs/BACKLOG.md`（进行中 → 完成并移除）；漂移根因另立条目。

明确不做：不改 `reason` 映射与终态符号表；不改 App 的回合号预测与分隔线回合号回填（另立条目）；不改渲染层的无终态回落。

## 实现记录

- 2026-10-10：
  - `types.ts`：`Item` 增 `generation?: number`（交付时的回合世代，附口径注释）。
  - `sections.ts`：`SectionsState` 增 `turnEnds: number`（`createSections` 初值 0）；用户/notice/shell 的自成节分支里给 **user** 条目打 `generation: state.turnEnds`；`applyText` 路径的 `appendText` 增世代参数（同一条目内流式续写不刷新世代）；`applyTurnEnd` 的用户块终态改为世代门，并在结尾 `turnEnds + 1`。
  - 探针（临时 `tmp/`，不入库）：`probe-item6c.ts`（节层四场景：漂移 / 正常 / interrupted 不回溯 / steer 块不改写）、`probe-item6b.ts`（端到端：App + 真实 adapter + 真实键输入，含 delivery/event 轨迹）。

## 测试与证据

- 新增用例：`tests/pipeline-sections.test.ts` 三条——① 宿主回合号漂移（用户块 turn=3、`turn-end` turn=9）仍落 `success`；② interrupted 回合的块保持未定义、终态只落本回合的块；③ steer 续接块不被改写、终态落在非 steer 块上。`tests/pipeline-frame.test.ts` 一条帧断言——漂移序列**同一帧**用户行含 `✓`，interrupted 序列保持 `?`。
- **反向验证**（`git stash push` 两个源文件）：漂移用例与 steer 用例、以及帧断言在**修复前失败**（`?` / 未定态）→ 修复后通过。
- 端到端探针（修复后）：正常两回合 `●` → 同帧 `✓`；宿主号漂移（App 预测 3、宿主 9，且宿主回合有正文）→ 同帧 `✓`；`interrupted` → 保持 `?`（既有设计）。附带发现探针自身的坑：`turn/end` 的 `seq` 若小于前一条事件会被适配器按序丢弃（我的探针曾用乱序 seq 导致「turn-end 交付缺失」的假象），已修正后确认交付正常。
- 全量：`npm test`（TUI）**1430 / 1430 通过**（改动前 1426 + 本条目 4）；`npm run check` 干净；`tsc --noEmit` 干净。
- 未做：真机复核（会话内无法起真机）——请用户真机确认「回合结束后用户块变 ✓」；`interrupted` / `max-tokens` / `blocked` 仍为 `?` 属既有设计（两处一致），不在本条目范围。

## 审阅记录

- **实现前审阅**（子代理，只读 + 落盘快照）：结论「可落地，但『退到最后一个未定态条目』不安全」。给出**真误标反例**：中断类 reason 的块会被下一回合 `completed` 回溯标记；steer 块（符号恒 `←`）不该被改写；幂等的无 `seq` 路径下第二次 `turn-end` 也可能改标更早块；并指认漂移根因在 `index.ts` 的 `pipelineLastTurn + 1` 预测 vs 适配器的宿主 turn。**全部采纳**：改为世代门（D1），候选额外排除 `steerContinued`，并把根因另立条目 20。
- **收尾前审阅**（子代理，只读）**未返回**：该审阅跑了约 4 分钟并在催促后仍未产出结论，已按用户「一次等待不超过 30 秒」的要求中断（未留结论）。**替代性自检**（本任务自行完成）：① 复核 `SectionsState` 的每个构造出口都 spread 旧状态（`pendingOpen:` 共 5 处返回点，`grep` 逐一确认；`createSections` 显式给 `turnEnds: 0`）→ `turnEnds` 不会在 `close` / `write` / `sealedOf` / `applyTurnEnd` / 冻结路径上丢失；② `pendingOpen` 在 `sections.ts` 之外无构造点（`replay.ts` / `frame.ts` 不手搓该状态）；③ 反向验证与全量回归见「测试与证据」。**未覆盖**：审阅没跑到，故「恢复重放历史块是否会被误标」只有推理（重放的 `turn-end` 不带 reason → 恒 undefined，不会落终态）而无独立复核。

## 测试与证据

（待补）

## 审阅记录

（待补）

## 收尾

- **关闭**：条目「自己发的用户块终态符号始终是 `?`（不变 `✓`）」2026-10-10 完成——接取时标〔进行中〕，本次提交内按流程从 `TUI/docs/BACKLOG.md` 移除。
- **回写文档**：`TUI/docs/SPEC.md` / `DESIGN.md` 无需改（无新增用户可见形制；世代门是接收层内部口径，已落在代码注释与追踪文档）；`TUI/README.md` 无需改。
- **另立条目（途中发现的根因）**：BACKLOG 新增「本地预测回合号与宿主编号不同步（分隔线 / 用户块落在错误的 ⇆N 上）」——本条目只保证「漂移也能落终态」，编号本身的对齐（宿主 `turn/start` 回填 / 重放采用宿主真值）留在新条目。
- **遗留 / 已知**：`interrupted` / `max-tokens` / `blocked` 仍保持 `?`（既有设计，`state.ts` 与 `sections.ts` 同口径）；真机目视未做。
- **归档**：本文件自 `TUI/docs/implementation/` 移入 `TUI/docs/archived/`。
- **提交链**：`096818c`（实现 + 测试 + 新条目 20）→ 收尾提交（归档 + BACKLOG 移除条目）。
