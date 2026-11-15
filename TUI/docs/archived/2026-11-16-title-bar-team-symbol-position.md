# 标题行 team 符号移到 • 左侧（接取条目：`TUI/docs/BACKLOG.md`「标题行 team 符号移到 `•` 左侧」）

状态：关闭　　开启：2026-11-16　　关闭：2026-11-16
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

标题行状态符号里, Agent Teams 的 `fa-group` 符号（U+F0C0）从工作流组最右（`•` 右侧）移到 `•` 左侧, 成为环境 / 行为组的最后一项; 字形与颜色语义（生效绿 / 未生效灰）、其余符号顺序、窄宽让位行为均不变。

## 调研

来源：`TUI/src/app/layout/title-bar.ts`、`TUI/tests/title-bar.test.ts`、`TUI/tests/fixtures/focus-frame-legacy.json` 与提交 `4ef137a4`。

- 现状拼接（`title-bar.ts:163-167`）: `符号段 = mainSegs + (" • " 若两组都非空) + flowSegs`; `mainSegs` = 沙箱 / 策略 / verbose / 符号统一 / 声音 / daemon; `flowSegs` = plan / flow-track / team。故 team 现居 `•` 右侧最末。
- 染色与显示条件: team 恒显, `state.teamEnabled === true` 绿 / 否则灰（`:159-161`）; 与位置无关, 移动不需要改状态链。
- 组说明注释与文件头注释（`:83-84`、`:103-105`）写明两组构成, 移动后须同步, 否则文档口径与实现不一致。
- 测试: `title-bar.test.ts:244-249` 断言 `teamAt > planAt > dotAt`（工作流组内、plan 之后）; `:234-243` 断言两态着色, 与位置无关。
- 冻结基线: `focus-frame-legacy.json` 的 w60 场景第 0 行含标题行, 符号顺序变化会使这些行文本与 ANSI 都变, 需重冻（`TUI/scripts/freeze-focus-frame.mts`）。
- 宽度: team 符号仍在同一行、总宽不变, 窄宽让位阈值（mid 48）不需要改。

## 决策

| 决策项 | 说明 | 备选方案 | 推荐 | 选定 |
| --- | --- | --- | --- | --- |
| 1 team 符号落位 | 目标位置是 `•` 左侧的具体位置 | a. 环境 / 行为组最末, 紧邻 `•` 左侧; b. 环境组最前（沙箱之前）; c. 留在工作流组与 plan 交换 | **a**（用户原话「放在白点的左侧」, 紧邻最贴合; 其余符号顺序不动） | a |
| 2 窄宽让位阈值是否调整 | 符号总宽不变, 但顺序变化可能影响让位时的截断位置 | a. 保持 mid 48 不动; b. 重新按实测取值 | **a**（总宽与符号个数不变, 让位判据基于总宽） | a |

## 规划

任务拆分:

1. `title-bar.ts`: team 的 `pushTo` 目标由 `flowSegs` 改 `mainSegs`（放在 daemon 之后, 保证紧邻 `•` 左侧）; 文件头与分组注释同步（`mainSegs` 加 team, `flowSegs` 去掉 team）。
2. `title-bar.test.ts`: 顺序断言改为 team 在 `•` 之前、daemon 之后; 保留两态着色用例。
3. 重冻 `focus-frame-legacy.json`（`TUI/scripts/freeze-focus-frame.mts`）, 记录差异只落在标题行符号区。
4. 验证: `pnpm run check` / `test:tui` / `TUI` build / `pnpm run check:docs`。

计划改动文件清单:

- `TUI/src/app/layout/title-bar.ts`
- `TUI/tests/title-bar.test.ts`
- `TUI/tests/fixtures/focus-frame-legacy.json`（重冻）
- `TUI/scripts/freeze-focus-frame.mts`（重冻记录）
- `TUI/docs/BACKLOG.md`（本条目状态与关闭清理）
- 本追踪文档 `TUI/docs/implementation/2026-11-16-title-bar-team-symbol-position.md`

明确不做:

- 不改符号字形、颜色语义、状态链（`teamEnabled` / 服务读取 / ticker 保鲜）。
- 不改其它符号的先后顺序, 不改 `•` 圆点本身与组间空格规则。
- 不改 `SPEC.md` 宽度表口径（总宽不变）。

## 实现记录

- 2026-11-16（实现）:

  - `title-bar.ts`: team 的 `pushTo` 由 `flowSegs` 改为 `mainSegs`, 位于 daemon 之后, 即恒紧邻 `•` 左侧; 文件头段数组注释改为「环境/行为组（含 team）」+「工作流组（plan / flow-track）」; 分组注释标注 team 居 `•` 左侧最末（2026-11-16 用户裁定）。
  - `title-bar.test.ts`: 顺序断言由 `teamAt > planAt`（工作流组内）改为 `teamAt > daemonAt && teamAt < dotAt`（环境组最末, `•` 之前）; 两态着色断言不变。
  - `freeze-focus-frame.mts`: 追加本次重冻记录。
  - `focus-frame-legacy.json`: 重冻（`node --experimental-transform-types scripts/freeze-focus-frame.mts`, frozen 15 scenes）。

## 偏差

无。原计划的「`SPEC.md` 若写了具体顺序再回写」经查未涉及符号顺序, 未改。

## 测试与证据

- 重冻差异: `focus-frame-legacy.json` 共 44 行变化（22 删 / 22 增）, 全部为 11 个 w60 场景第 0 行（标题栏）的 `text` + `ansi`; 4 个 w20 场景无差异（符号组整组让位）。
- `pnpm run check`: 41 包全 OK。
- `pnpm -C TUI run build`: 通过（tsc 无输出）。
- `pnpm run test:tui`: 1893 项全过（含改写后的顺序断言与两态着色）。
- `pnpm run check:docs`: 通过（归档后复跑）。

## 收尾

- 归档: 本文件移入 `TUI/docs/archived/2026-11-16-title-bar-team-symbol-position.md`。
- BACKLOG: `TUI/docs/BACKLOG.md` 条目「标题行 team 符号移到 `•` 左侧」标完成并于关闭时清理移除。
- 提交: 按用户 2026-11-16 指示「不提交, 一直做完再提交」, 收尾提交一次含全部改动。
