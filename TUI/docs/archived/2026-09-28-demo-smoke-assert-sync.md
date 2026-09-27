# demo 冒烟断言同步：`$` 本地执行与 compaction 摘要折行（接取条目：TUI/docs/BACKLOG.md「mock demo 冒烟（`npm run demo -- --smoke`）在 HEAD 上两项断言失败（`compaction-summary-toast` / `shell-submit`）」）

状态：关闭　　开启：2026-09-28　　关闭：2026-09-28
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

修复 `npm run demo -- --smoke` 的两项断言失败（`shell-submit` / `compaction-summary-toast`），使冒烟恢复全绿；只同步断言与注释，不动产品代码与 mock 事件序列。

## 调研

- 复现：改动树与 clean tree（HEAD `8671b82`）均 `SMOKE_FAIL n=2`，失败项与详情固定。
- `shell-submit`（`demo/main.ts:253`）：断言 `sent.includes("ls")`。TUI#37（2026-09-27）后 `$` 提交走**本地子进程**（`src/app/local-shell.ts`），不进 `adapter.sent`；实测渲染为活动区行 `$ ls` + stdout + `→ 退出码 0 · Nms`。
- `compaction-summary-toast`（`demo/main.ts:407-411`）：断言 `flatFrames().includes("压缩完成：已压缩182条历史消息")`。实测 toast 文本确已渲染（mock `compaction-summary.text = "已压缩 182 条历史消息"` → state 拼为 `压缩完成：<首行>`），但 pane 宽折行后「消息」落在下一行，且左右排列时两行之间夹另一 pane 的行文本 → `flatFrames()`（按整帧顺序去空白 / `│` 拼接）无法跨行还原。既有 `preset-notice`（`demo/main.ts:582-589`）已因同类折行按「可容纳片段」口径处理。

## 决策

- 按 #47 口径「断言与序列同步」：只改断言与注释，不改 mock 事件序列、不改渲染与业务代码。
- `compaction-summary-toast`：按 `preset-notice` 既有口径改为**两段可容纳片段**——`压缩完成：已压缩`（前缀，单行内）+ `182条历史`（首行尾段，去空白后连续）。
- `shell-submit`：改为断言本地执行语义——`!sent.includes("ls")`（不进模型）+ 回显 `$ ls` + 退出摘要 `→ 退出码 0`。
- 同步 `demo/main.ts:138` 的过时注释（原「不加 $ 前缀发送 `ls`」）。

## 规划

计划改动文件清单：

- `TUI/demo/main.ts`（两条断言 + 一条注释）
- `TUI/docs/BACKLOG.md`（条目状态「进行中」→「完成」）
- `TUI/docs/implementation/2026-09-28-demo-smoke-assert-sync.md`（本文件；关闭后移入 `TUI/docs/archived/`）

明确不做：不动 `src/`、`tests/`；不重构冒烟脚本结构；不把 demo 的本地执行器换成 fake（另议）。

## 实现记录

2026-09-28：

- `TUI/demo/main.ts`：
  - 步骤 3 注释同步为「本地执行 `ls`（TUI#37：不走模型、不进 sent）」；
  - `shell-submit` 断言改为 `!sent.includes("ls") && shellPlain.includes("$ ls") && shellPlain.includes("→ 退出码 0")`（新增 `shellPlain`）；
  - `compaction-summary-toast` 断言改为两段可容纳片段（`压缩完成：已压缩` + `182条历史`），注释注明同 `preset-notice` 口径。
- `TUI/docs/BACKLOG.md`：条目状态「待接取」→「进行中」。

## 测试与证据

- `npm run demo -- --smoke`：**SMOKE_OK**（exit 0），`sent=["!hello","x","rm tmp","等待审批的输入","中止示例"]`（不含 `ls`）；修复前同命令 `SMOKE_FAIL n=2`。
- `npm run check` exit 0；`npm run test:tui` **1194 pass / 0 fail**；`npm run build` + `npm run test`（全包并行）**15 包全部 pass / fail 0，exit 0**。
- `git diff -- TUI/demo/main.ts` 自查：仅两条断言 + 一条注释，无计划外改动；`format` 已执行。

## 收尾

- 回写：条目 #47 由本任务完成，按「BACKLOG 只留未完成项」口径从 `TUI/docs/BACKLOG.md` 移除（清理后该文件暂无未完成项）；本文件移入 `TUI/docs/archived/`。
- 遗留：无。
