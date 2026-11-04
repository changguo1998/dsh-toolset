# `!` 打断并直发后用户块终态符号错位（接取条目：TUI/docs/BACKLOG.md「`!` 打断并直发后用户块终态符号错位」）

状态：关闭　　开启：2026-11-04　　关闭：2026-11-04
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

修复 `!` 模式「打断并发送」后用户块状态符号错位：被打断的输入显示 `■`（灰方块）、
正在处理的新输入保持运行中 `●`/`○` 黄闪烁；原 bug 中被打断输入显示 `?`、新输入显示
`■`。修复不退化正常回合终态与恢复会话回合号漂移的既有行为。

## 调研

（来源：本仓源码 / 既有测试 / 临时复现脚本）

- **符号渲染**：`layout/run-virt.ts` 的 `userBlockSymbolResolver`——`item.status`
  （`success` / `failure` / `aborted`）命中即渲 `✓` / `✗` / `■`；无终态但 `active`
  且 running 渲 `●`/`○`（黄, 闪烁）；否则渲 `?`。`active` = 会话区最后一条终态未定
  的用户输入（`layout/pipeline/split.ts` 打标）。
- **终态打标**：`layout/pipeline/sections.ts` `applyTurnEnd(delivery.turn, reason)`
  ——按**回合世代** `item.generation === state.turnEnds` 收集「上一次 `turn-end` 之后
  交付的用户块」（不按回合号匹配, 因为恢复会话后本地预测号与宿主号漂移, 见现有测试
  `pipeline-sections.test.ts:501`）, 从其中选**最后一条**（人工输入优先, 注入块让位）
  落 `userStatusOfReason(reason)`（completed→success / aborted→aborted / error→failure /
  其余 undefined 不落）。
- **打断直发的回合号**：`runtime/session.ts` `sendUserText`（:287-297）— `sameTurn = ctx.turnOpen && scope.turn === (ctx.pipelineLastTurn ?? 1)`；打断瞬间旧回合仍开
  （`turnOpen=true`、`pipelineLastTurn` 未推进）, 故直发块被归入**被打断回合**的号
  （`turn: sameTurn ? scope.turn : …`）。而打断路径（`submit` 的 interrupt 分支,
  :365-368）只调 `interrupt()` + `restoreQueued()`, **不关本地回合**。
- **复现（临时脚本 `tmp/repro-user-block-status.ts`, 直接驱动 `applyAll`）**：
  - A(turn1) + B(turn2, 直发) + `turn-end(turn1, aborted)` → A `userStatus=undefined`
    （渲 `?`）, B `userStatus=aborted`（渲 `■`）——与用户报告完全一致。
  - A(turn1) + B(turn1, 同号直发) + 同上 → 同样 A 留 `?`、B 得 `■`（当前真机行为,
    `sendUserText` 的 `sameTurn` 判定使 B 落 turn1）。
  - 单用户块 + `turn-end(aborted)` → 正常 `aborted`。
  - 正常跨回合（aborted 后 completed）→ A `aborted`、B `success`, 正常。
- **宿主 turn-end 的 reason**：`dsh-events.ts:540-576` 把 `turn/end.reason` 经
  `turnEndReason` 归一为 `TurnEndReason`, `turn/end` 经 adapter 双路投递（delivery
  `kind:"turn-end"` 进节模型 + 事件 `type:"turn-end"` 进 reducer）。
- **只修节模型**：`state/reducer-turn.ts` 已注明用户块终态符号由节模型打标, reducer
  只置 `inputStatus: "success"` 与虚拟速度下限, 无用户块维度状态。

## 决策

1. 直发块回合号归属（**修复根因一**）:
   - a. 打断提交时把本地回合提前关闭（`ctx.turnOpen = false`）, 使随后 `sendUserText`
     里的 `beginTurnIfNeeded(true)` 走开新回合路径, 预测新回合号（`pipelineLastTurn+1`）
   - b. 给 `sendUserText` 加 `newTurn` 显式参数
   - c. 修改 `sameTurn` 判定, 打断场景强制非同号
   - 选定 **a**：改动最小且语义正确（打断 = 放弃当前回合, 直发本就该开新回合、画新
     分隔线）; `turnOpen` 在 `turn-end` 事件处理里同样被置 false（幂等, `wiring.ts:360`）。
   - 附带收益：打断并发送后本地回到「新回合已开」事实, 与宿主随后 `turn/start` 回填
     一致; 分隔线照常画。
2. 终态归属加回合维度（**修复根因二**, 结构性兜底）:
   - a. `applyTurnEnd` 落终态时, 先按「世代 + `section.turn === turn`」精确匹配; 精确
     匹配落空（回合号漂移的恢复会话等）退回旧世代逻辑
   - b. 只按世代, 靠根因一的号区分
   - c. 世代内取「turn 号 ≤ turn-end 号」的最后一条
   - 选定 **a**：实时会话 turn 号最可靠, 精确匹配根治「aborted 落给新块」; 漂移场景
     退回旧行为（既有测试 `pipeline-sections.test.ts:501` 保持绿）, 不引入新的退化面。
     决策再斟酌：即使根因一已让 B 用新号, 若 host 通知乱序（B 的 turn-start 先到、或
     turn-end 迟到跨世代）仍需结构兜底, 故两层都做。
3. 不改 `run-virt.ts` 的符号表：`■`（aborted）语义本正确, 只是落错了块。
4. 测试: 在 `layout/pipeline` 的 sections 单测（`tests/pipeline-sections.test.ts`）
   与 `!` 模式集成用例（`tests/interrupt-mode.test.ts`）补充覆盖。

## 规划

任务拆分:

1. `src/app/runtime/session.ts` `submit()` 的 interrupt 分支: `interrupt()` 后置
   `ctx.turnOpen = false`, 使 `!` 直发开新回合（根因一）。同步检查 `restoreQueued` 后
   文本合并路径无副作用。
2. `src/app/layout/pipeline/sections.ts` `applyTurnEnd`: 落终态目标选择加「世代 +
   `section.turn === turn`」精确匹配优先, 无精确匹配退回世代逻辑（根因二）。
3. 测试: `tests/pipeline-sections.test.ts` 新增「打断直发: aborted 落被打断块、直发块
   保持未定」用例（含同号 / 异号两态）; `tests/interrupt-mode.test.ts` 新增「`!` 打断
   并直发后两用户块符号正确」集成用例; 守成: 既有世代/漂移/注入/steer 用例不动。
4. 文档: 本文档归档; BACKLOG 条目关闭注记。

计划改动文件清单:

- `TUI/docs/BACKLOG.md`（条目登记, 本次接取已标进行中）
- `TUI/docs/implementation/2026-11-04-interrupt-user-block-status.md`（本文件）
- `TUI/src/app/runtime/session.ts`
- `TUI/src/app/layout/pipeline/sections.ts`
- `TUI/tests/pipeline-sections.test.ts`
- `TUI/tests/interrupt-mode.test.ts`
- `TUI/docs/archived/2026-11-04-interrupt-user-block-status.md`（关闭后归档位）

明确不做:

- 不改 `run-virt.ts` 符号表与渲染（符号语义正确）。
- 不动 `!` 只打断（空输入）路径与 Esc 语义。
- 不重写 `applyTurnEnd` 的世代机制（漂移兜底保留）。
- 不改 `state/reducer-turn.ts`（节模型已是用户块终态唯一来源）。

## 实现记录

- 2026-11-04 `runtime/session.ts` `submit()` 的 interrupt 分支：`interrupt()` 后置
  `ctx.turnOpen = false`（打断 = 放弃当前回合；`turnOpen` 在 host `turn-end` 事件处理里
  也会置 false, 幂等），使 `!` 直发走 `sendUserText` 里 `beginTurnIfNeeded` 开**新回合**
  并预测新回合号（`pipelineLastTurn + 1`）——直发块不再与被打断块同号同世代。
- 2026-11-04 `layout/pipeline/sections.ts` `applyTurnEnd`：落终态目标选择改为两层——
  ① 按 `section.turn === turn` 精确匹配（不限世代, 本回合块不论世代都属本回合）; ② 精确
  落空（恢复会话回合号漂移）退回世代匹配（上一次 `turn-end` 之后交付的最后一条未定态块,
  原逻辑）。人工输入优先 / 注入块让位 / steer 续接不标 的规则两轮共用。
- 2026-11-04 测试：`tests/pipeline-sections.test.ts` +2（打断直发 aborted 只落被打断块;
  直发块在下一回合正常落 success）; `tests/interrupt-mode.test.ts` +1 端到端帧断言
  （`!` 打断并直发后被打断块显 `■`、正在处理块显 `●`/`○`）。
- 2026-11-04 临时复现脚本 `tmp/repro-user-block-status.ts` 已删（见偏差）。

## 偏差

- **无**实质偏差。修复路径与「决策」一致（两处根因都已修, 见决策 2 末句附带的结构兜底）。
- 复现脚本 `tmp/repro-user-block-status.ts` 属临时探针, 收尾时删除, 不入提交。

## 测试与证据

- 复现（临时脚本直接驱动 `applyAll`）：修复前 A 留 `?`、B 得 `■`; 修复后 A 落
  `aborted`、B 保持未定; 单用户块打断与正常跨回合对照不变。
- 新增用例：`tests/pipeline-sections.test.ts` 2 例（打断直发 aborted 只落被打断块; 直发块
  在下一回合正常落 success）; `tests/interrupt-mode.test.ts` 1 例端到端帧断言（`!` 打断并
  直发后, 帧中被打断块含 `■`、正在处理块含 `●`/`○`）。
- 守成：`tests/pipeline-sections.test.ts` 既有的世代漂移 / interrupted 保持未定 / steer
  续接 / 注入块让位用例全部保持绿（本批 sections 30 例 + interrupt-mode 8 例全过）。
- `TUI` `pnpm run check` / `pnpm run build`: 退出 0; `demo -- --smoke`: 42 PASS + 1
  SMOKE_OK。
- 全量 `pnpm -w run test:tui`: 1834/1834 通过。
- 根级 `pnpm run check`（全仓 tsc）: 退出 0; `pnpm run check:docs`: 错误 0 / 警告 0;
  根级 `pnpm run build`（全仓）: 退出 0。
- **未做真机确认**：需在本机（或另一台）profile 重建后人工实测打断流程（`fff-test` 为
  `link:` 协议, 改完 `pnpm run build` 即生效; 主 profile 需 `scripts/install.sh --profile fff --sync`）——实测点：`!` 打断并直发后, 旧输入显灰 `■`、新输入黄 `●/○` 闪烁。

## 收尾

- 回写文档：`TUI/docs/BACKLOG.md` 该条标注完成并从清单清理移除（关闭注记随本文件
  归档位记录）。
- 追踪文档移入 `TUI/docs/archived/2026-11-04-interrupt-user-block-status.md`。
- 临时复现脚本 `tmp/repro-user-block-status.ts` 已删除。
- 遗留：真机确认（见「测试与证据」末条）。
