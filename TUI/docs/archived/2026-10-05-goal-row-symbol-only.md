# goal 状态行只显示相位符号（接取条目：`TUI/docs/BACKLOG.md`「goal 状态行只显示相位符号」）

状态：进行中　　开启：2026-10-05　　关闭：—

## 计划改动文件清单（只改这些）

- `TUI/src/app/layout.ts`（当前 goal 行去掉相位词）
- `TUI/tests/status-column.test.ts`（标题行断言 + 文件头覆盖说明）
- `TUI/tests/goal-activation.test.ts`（e2e 帧断言）
- `TUI/docs/SPEC.md`（§15.1 口径）
- `TUI/README.md`（ASCII 示意 + Goal 块说明）
- `TUI/demo/main.ts`（**审阅补入**：demo 冒烟断言 `Goal active` → `Goal ▷`；不在清单但必须改，否则 `npm run demo -- --smoke` 必红）
- `TUI/docs/DESIGN.md`（**审阅补入**：两处 Goal 行口径）
- `TUI/docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研与决策（已核）

- 现状：当前 goal 行 = `Goal ` + `▷ ` + `active` +（` ⟳`）；状态列默认宽 10 格，实际渲染 `Goal ▷ ac`（`status-column.test.ts` 里已有该截断断言）——相位词被列宽切掉，只剩一两个字母。
- 用户裁定（2026-10-05，`ask_user_question`）：**只留符号**（选项 A），不加缩写词。
- 决策：① 当前 goal 行改为 `Goal <符号>` + 可选 `⟳`；未知 phase 仍不出符号（保持「不产生多余空格」的既有行为）；② **历史旧 goal 行不动**——按既有约定历史行不带符号（SPEC §15.1），其 `Goal <phase>` 是唯一相位线索；③ 相位色不变（active/complete 绿、paused/blocked 黄）。

## 实现记录（2026-10-05）

- `layout.ts`：当前 goal 行的相位段由「符号 + 词」改为「仅符号」。
- 测试：`status-column.test.ts` 四处标题断言与文件头说明同步；`goal-activation.test.ts` 的 e2e 帧断言改 `Goal ▷ ⟳`（含 activation 开关）。
- 文档：`SPEC.md` §15.1 的 Goal 行口径改 `Goal <phase 符号> [⟳]`；`README.md` 的 ASCII 示意与 Goal 块说明同步。

## 测试与证据（2026-10-05）

- `npm run check`（TUI）✓；`npm run test:tui` **1320 例全绿**（新增 1 例「未知 phase → 标题行只剩 `Goal`」）。
- **demo 冒烟**：`npm run demo -- --smoke` → `SMOKE_OK`（审阅前该断言未同步，实测 `SMOKE_FAIL status-col-elements`；改 `Goal active` → `Goal ▷` 后通过）。
- 反向验证：临时把 `layout.ts` 改回「符号 + 相位词」→ `status-column.test.ts` 两例红（19 全跑中 2 红）；恢复后全绿。
- 渲染实测（审阅核对，与代码一致）：active `Goal ▷ ⟳` / paused `Goal ∥` / blocked `Goal △` / complete `Goal ✓`；10 格窄列下 active+armed 为 8 列不截断；历史行仍 `Goal complete`（灰、无符号）；未知 phase 标题行只剩 `Goal`。

## 子代理审阅（决策后 + 收尾前合并一轮，2026-10-05）

只读审阅结论「需修」——1 处阻断 + 1 处重要 + 3 处次要，均已处理：

1. **[阻断] `TUI/demo/main.ts` 的冒烟断言仍是 `Goal active`**（不在原清单内）→ 实测 `npm run demo -- --smoke` 报 `SMOKE_FAIL status-col-elements`（退出码 1）。→ 已改 `Goal ▷` 并复跑 `SMOKE_OK`；demo 冒烟是**独立于 `test:tui` 的验证路径**，本次教训记在清单里。
1. **[重要] `TUI/docs/DESIGN.md` 两处口径仍是 `Goal <符号> <phase>`** → 已同步为 `Goal <符号>`（并注明 2026-10-05 起不出相位词）。
1. **[次要] 过时注释**（`layout.ts` 的「未知 phase…只出词」「符号与词并存」、测试文件里的「输出：Goal active」）→ 已改。
1. **[次要] 未知 phase 无用例** → 已补（断言标题行去掉右边框与填充后恰为 `Goal`：无符号、无相位词、无多余空格）。
1. **[提示]** 已核无问题：四相位符号与段级颜色、符号段无尾随空格、`⟳` 段前导空格、窄列不截断、历史行不动、README ASCII 对齐未破坏、SPEC 与代码一致、diff 无越界。

## 收尾

- 条目从 `TUI/docs/BACKLOG.md` 移除（该表随后为空，按模块惯例置「（当前无未完成项）」）。
- 本追踪文档移入 `TUI/docs/archived/`；本次变更合并为一次提交（`src/app/layout.ts` + 两个测试文件 + `demo/main.ts` + `docs/SPEC.md` + `docs/DESIGN.md` + `README.md` + BACKLOG + 归档文档），提交见 git 历史。
- 复跑记录：根 `npm run check` / `npm run build` ✓、`npm run test:tui` 1320 例 ✓、`npm run demo -- --smoke` ✓。
