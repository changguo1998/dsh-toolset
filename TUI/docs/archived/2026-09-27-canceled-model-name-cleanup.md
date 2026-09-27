# 已取消模型名硬编码引用清理（BACKLOG: TUI#21）

状态：关闭　　开启：2026-09-27　　关闭：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

用户 2026-09-27 指令：**两款已取消的旧代模型名**（本任务清理对象，按用户要求正文不列字面量，可在本次改动 diff 中看到）不应再硬编码出现——「代码，注释，文档中不必出现这种硬编码的内容」。清理**活文件**：源码注释、测试夹具、活文档改中性表述或合成假名；归档文档保留历史原样。

## 调研

- **运行期无使用**：源码中仅注释出现（`tui/src/app/adapter/tool-bootstrap.ts:18,157`、`tui/src/app/state.ts:569`）；`~/.dsh/settings.yaml` 与 `fff` profile 无引用；门控判定为包含匹配 `/deepseek/i`，不枚举具体 id。
- **测试夹具**（替换目标）：`tests/tool-bootstrap.test.ts`（门控命中表 2 项 + 切模型用例 1 处 + 注释）、`tests/adapter.dsh.test.ts`（约 15 处 model id）、`tests/app.test.ts`（约 35 处：模型目录夹具、`/model` 用例、期望文案、显示名）、`tests/session-ui-state.test.ts`（快照夹具 1 处）、`tests/modelpicker.test.ts`（11 处：picker 夹具 / 子串断言 / 注释）、`tests/layout4.test.ts`（3 处 picker 夹具）。
- **活文档**：仅 `TUI/docs/BACKLOG.md` #16 表述（已改）；`README.md` / `DESIGN.md` / `IMPLEMENTATION.md` / `SPEC.md` / `COMMANDS.md` 均无引用。
- **归档文档**：`TUI/docs/archived/**` 多处（历史记录，保留不改）。

## 决策

| # | 维度 | 选项 → 选定 | 理由 |
|---|------|------------|------|
| D1 | 清理范围 | 含归档 / **只清活文件**（用户裁定） | 归档是历史记录，改写会失真 |
| D2 | 测试夹具命名 | 中性占位 id / **合成假名 `deepseek-test-a` / `deepseek-test-b`**（显示名 `Test A` / `Test B`）（用户裁定） | 不绑定任何真实/曾用产品名，避免再次陈旧 |
| D3 | 注释与文档表述 | — → 中性表述（「模型 id 含 `deepseek`」「实际可用的 `deepseek-*` 模型」） | 判据本就是包含匹配，不枚举具体名字 |
| D4 | 门控行为 | — → **不变**（`/deepseek/i`） | 本任务只清引用，不改行为 |

## 规划

计划改动文件清单（= 落点；计划外文件不改）：

- `TUI/src/app/adapter/tool-bootstrap.ts`（注释 L18、L157-158）
- `TUI/src/app/state.ts`（注释 L569）
- `TUI/tests/tool-bootstrap.test.ts`、`TUI/tests/adapter.dsh.test.ts`、`TUI/tests/app.test.ts`、`TUI/tests/session-ui-state.test.ts`
- `TUI/docs/BACKLOG.md`（#21 条目与 #16 表述）
- 本追踪文档（关闭时移入 `TUI/docs/archived/`）

明确不做：不改门控判定与任何行为；不动归档文档；不重命名其它模型名（v4 系等仍在用）；不做顺手优化。

## 实现记录

1. **源码注释**：`tool-bootstrap.ts` 顶部取舍段与 `isDeepseekModel` 文档注释改中性表述（不再枚举具体模型名与示例 id）；`state.ts` 的 `PickerOption.label` 注释示例改 `<provider>/<model>`。
1. **测试夹具**：六处测试文件的旧代模型名统一替换为合成假名 `deepseek-test-a` / `deepseek-test-b`（显示名 `Test A` / `Test B`）；裸 id 夹具（picker 的 `chat` / `reasoner`）同步替换；子串断言（`* test-b` / `> test-b` 等）与相关注释一并更新。
1. **活文档**：`TUI/docs/BACKLOG.md` #16 表述改「实际可用的 `deepseek-*` 模型」；新增 #21 条目（正文不写字面量）。
1. **未改**：归档文档（历史记录，用户裁定）；与模型名无关的会话 id 夹具（如 `chat-2`）；门控判定与任何行为。

## 测试与证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run check` | 干净（0 error） |
| 全量单测 | `npm test` | **1172 pass / 0 fail** |
| 残留检索 | `grep -rn` 活文件（`src/`、`tests/`、活 `docs/`） | 0 处字面量；本条目与追踪文档以「两款已取消旧代模型名」表述 |
| 行为影响 | 门控判定 `isDeepseekModel` 与替换前逐字一致（仅注释 / 夹具变化） | 无行为变更；不涉及渲染与命令面，未重跑冒烟与冻结基线 |

## 收尾

- `TUI/docs/BACKLOG.md` #21 标「完成」；本追踪文档移入 `TUI/docs/archived/`。
- `STATUS.md` 不改（用户择时更新）。
- 提交：待询问用户（工作区含 2026-09-27 批次 + #19 修复 + 本清理，均未提交）。
