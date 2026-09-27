# steer 排队显示（独立成行、黄色右缘竖线、steer 优先）（接取条目：`TUI/docs/BACKLOG.md`「steer 排队显示：独立成行、右缘竖线黄色、steer 排在 followup 之上」）

状态：关闭（真机确认通过）　　开启：2026-09-27　　关闭：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
审阅：用户 2026-09-27 真机反馈（steer 功能已正常，显示待改）：① steer 消息被追加在上一条输入行尾 → 改为独立成行；② 排队等待时右缘竖线改黄；③ steer 与 followup 同时排队时 steer 在上方。已用 `ask_user_question` 澄清黄色范围：**只 steer 排队项黄，followup 保持灰**。

## 目标

`<` 提交的 steer 消息在「已投递、尚未被下一次 step 认领」这段等待期内，显示形态与普通排队消息一致（独立成行、独立右缘竖线），并以**黄色右缘竖线**标明「steer 等待中」；同一时刻存在多种排队项时，steer 整体排在 followup 之上。

## 调研

- 排队块现状（`layout.ts` `queuedBlockRows`）：`AppState.queued` 每条一个 `kind="user"` + `queued` 标记的合成行，右对齐 + 右缘 `┃`，**排队中灰色**（`build-box.ts`），钉在对话区底部右下角、始终可见。
- 上轮改动（#36 修复）把 steer 改成「与直发同路径」——立即回显用户块 → 视觉上贴在上一回合的用户块之后（真机反馈的来因）；且 steer 在**下一个 step** 就被认领，若照搬 followup 的「回合开始认领」清除机制会滞留。
- 认领信号：宿主 `agent/inbox/spliced` 事件的 `removedCount > 0` 即「摘除已认领项」（会话日志实证：`target=next-step` 的摘除发生在同回合的 step 边界），adapter 目前只看 `inserted`、忽略该字段。

## 决策

1. **排队项带类型**：`AppState.queued` 由 `string[]` 改为 `{ text; kind: "followup" | "steer" }[]`；`queued-push` 增 `kind`（缺省 `followup`，既有调用不变）。
1. **steer 走排队显示**（恢复 #36 之前的口径）+ **空闲时例外**：agent 忙（本回合内）→ 排队块 + 黄线；agent 空闲 → 直接回显（无等待可言，steer 会立即起一轮）。
1. **认领分流**：`queued-claim` 只认领**最早的 followup**（回合开始路径，不变）；新增 `queued-claim-steer` 认领**最早的 steer**，由 adapter 新事件 `inbox-claim{target}` 驱动（`target === "next-step"`）——两条路径各自精确，不会互相多吃一条。
1. **颜色**：`BufferLine.queued` 由 `boolean` 改为 `"followup" | "steer"`（字符串真值），渲染 `steer → yellow / followup → gray / 已发出 → brightRed`。
1. **排序**：排队块渲染时 **steer 在前、followup 在后**（组内保持提交顺序）；数组本身仍按提交顺序存（认领按类型找最早一条）。

## 规划（改动文件清单）

- `TUI/src/app/state.ts`：`QueuedItem` 类型、`queued` 字段、`BufferLine.queued` 变体、`queued-push/queued-claim/queued-claim-steer` reducer。
- `TUI/src/app/index.ts`：steer 提交分支（忙 → 排队 + `next-step`；空闲 → 回显 + `next-step`；宿主无 steer → 降级 followup 并提示）、`inbox-claim` 事件分支。
- `TUI/src/app/adapter/types.ts` + `dsh.ts`：`DshEvent` 增 `inbox-claim`，`agent/inbox/spliced` 处理时按 `removedCount` 发事件。
- `TUI/src/app/layout.ts`：`queuedBlockRows` 排序 + 类型映射。
- `TUI/src/app/layout/build-box.ts`：右缘竖线三色（steer 黄 / followup 灰 / 已发出亮红）。
- 测试：`tests/steer-mode.test.ts`（排队显示 + 空闲直发 + 宿主无 steer 降级）、`tests/state-queued.test.ts`（新建：push 类型、认领分流、排序）、`tests/app.test.ts`（既有 `queued` 断言改新形态）。
- 文档：`TUI/docs/DESIGN.md`（排队块口径）、本追踪文档。

## 实现记录

**实现（2026-09-27）**

1. `src/app/state.ts`：
   - 新增 `QueuedItem { text; kind: "followup" | "steer" }`；`queued: QueuedItem[]`。
   - `BufferLine.queued` 由 `boolean` 改为 `"followup" | "steer"`（字符串真值，同时表达「排队中」与类型）。
   - `queued-push` 增 `kind`（缺省 `followup`，既有调用不变）；`queued-claim` 改为认领**最早 followup**；
     新增 `queued-claim-steer` 认领**最早 steer**——两条路径各自精确，不会互相多吃一条。
   - **`appendStream` 增 `newLine` 参数**并在 `user-line` / 两条认领路径上传 `true`：末行同为 `user` 时
     **不再续写**（真机现象「贴在上一行行尾」的根因；followup 连续认领同理会粘行，属同源缺陷）。
1. `src/app/layout.ts`：`queuedBlockRows` 渲染前排序（steer 在前、followup 在后，组内保持提交顺序），
   排队行类型透传给渲染层。
1. `src/app/layout/build-box.ts`：右缘竖线三色 `steer → yellow` / `followup → gray` / 已发出 `brightRed`；
   顺手把重复声明的 `RowMeta` 收编为 `fill.ts` 单一来源（两处定义漂移曾导致类型不兼容）。
1. `src/app/adapter/types.ts` + `dsh.ts`：`agent/inbox/spliced` 的 `removedCount > 0` → 新事件
   `inbox-claim { target }`（宿主摘除已认领项）。
1. `src/app/index.ts`：steer 提交分支改为「忙 → 进排队块（`kind:"steer"`，不写 buffer）+ `next-step` 投递；
   空闲 → 直达回显」；宿主无 steer 时按 `followup` 类型排队 + 排后提示；新增 `case "inbox-claim"`
   （只处理 `next-step` → `queued-claim-steer`，`next-turn` 仍走回合开始路径）；`restoreQueued()`
   改取 `q.text` 拼接（Esc / Alt+Enter 把排队内容退回输入框）。
1. 测试：新增 `tests/steer-queued-display.test.ts`（5 例）；`tests/app.test.ts` 既有 `queued` 断言
   同步为新形态（3 处）。

**旁路发现（已记入 BACKLOG，不在本条目内改）**：并发跑的 DESIGN 对照审计报出 6 处文档与实现不一致 → 记为新条目 `#44`。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `npm run check`（tsc --noEmit） | 通过 |
| `npm test`（TUI 全量） | **1188 例全通过**（1188 pass / 0 fail，含本轮新增 5 例 + 同步 3 处既有断言） |

新增用例（`tests/steer-queued-display.test.ts`）：

1. reducer：排队项带类型、按类型各取最早一条（followup 认领不误吃 steer、反之亦然、无该类条目 no-op）；
1. 忙时 `<` 提交进排队块（不写 buffer）、**steer 排在 followup 之上**、右缘竖线 steer 黄 / followup 灰；
1. `inbox-claim(next-step)` → 只认领 steer、转入历史流，followup 仍排队且未被误认领；
1. 空闲时 `<` 提交直达回显（无排队闪影）、右缘竖线为「已发出」亮红；
1. 宿主无 steer + 忙：降级为 followup 排队（灰线）+ 提示落 buffer、消息不丢。

真机待确认：运行中 `<` 提交 → 独立一行、黄竖线、位于 followup 之上；被认领后该行转为历史用户块（亮红竖线）。

## 收尾

- 已回写 `TUI/docs/DESIGN.md`（输入区「提交语义」段：追加排队块口径 TUI#43）；
- 计划外文件：`src/app/layout/fill.ts`（`RowMeta` 单一来源收编，2 行，已在本清单说明）、
  `tests/app.test.ts`（既有断言同步）；
- 真机确认（2026-09-27）：用户实测「steer 正常」——忙态 `<` 提交后排队项独立成行、右缘竖线黄、排在 followup 之上，认领后转入历史区；连续两条用户消息不再粘成一行（`appendStream` 用户行强制另起一行）同批通过；
- 原待办：用户人工确认（真机观察排队块三要点）（已完成，本文档归档于 `TUI/docs/archived/`）。
