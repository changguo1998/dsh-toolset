# TUI 工具结果行空 detail 占位（接取条目：`docs/BACKLOG.md`「TUI：工具调用成功后总是「对勾 +（无结果）」」）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

判定「成功 + 空 detail 仍显示（无结果）」是设计意图还是实现偏差；按结论修实现或走设计变更；补三态测试（成功+空 / 成功+有 / 失败）与反向验证。

## 调研

- 渲染点：`TUI/src/app/layout/tool-line.ts:23` `toolResultLine(ok, detail, meta)` = `(ok ? "✓ " : "✗ ") + (detail || "(无结果)")`——成功 / 失败两支共用同一占位；`meta` 命中 `{before, after}` 时追加 `(+N/-M)`。
- detail 来源（`TUI/src/app/adapter/dsh.ts`）：`toolResultDetail()`（`:433-450`）取工具 content 里**首个非空 text 块的首行**；`tool/result` 归一化（`:1889-1902`）`ok = !error`、失败时 detail = `name: detail|code`。⇒ **成功 + 空 detail 是静默工具（write / edit / hash_edit 等无 text 块）的常态**，不是异常态。
- 设计口径：`TUI/docs/DESIGN.md:210` 只写 `✓ <detail 首行截断>`；错误 `✗ <error.name>: <message>`（红）——**无空结果占位明文**；`TUI/docs/SPEC.md` / `COMMANDS-SPEC.md` 全文无「空结果 / 无输出 / 占位」类工具行约定（grep 命中的都是布局 spacer / 面板兜底等无关项）。
- 调用点只有一处（`state.ts:2139`，实时与恢复同路径）；`CommandListPanel.ts:43` 的「（无结果）」是搜索无匹配提示（另一语义，不动）；`dsh.ts:3311` 的「（无结果）」是评审子代理无产出的失败文案（另一语义，不动）。

## 决策（待审阅）

1. **结论 = 不一致（占位是实现自加，且成功支把正常静默渲染成「像失败」）→ 按设计修实现**：
   - 成功 + 空 detail → 只出 `✓`（设计口径 `✓ <detail>` 的自然退化；有 meta 时仍追加 `(+N/-M)`，如 `✓ (+1/-2)`）；
   - 失败 + 空 detail → `✗ （无错误信息）`（比「无结果」明确；失败支保留占位，避免 `✗` 后空悬）。
1. 文档：`TUI/docs/DESIGN.md:210` 的工具结果行口径补上述两态（成功空 detail → 只 `✓`；失败无信息 → `✗ （无错误信息）`）。
1. 测试：`TUI/tests/tool-meta.test.ts` 更新既有 pinned 断言（`✓ (无结果) (+1/-0)` → `✓ (+1/-0)`）+ 补三态用例（成功+空 / 成功+有 / 失败+空 / 失败+有）；反向验证：撤修复 → 必红。
1. 不做：不改 `dsh.ts:3311`（评审失败文案）与 `CommandListPanel`（搜索提示）——语义不同；不改 `✓` / `✗` 符号与红/绿着色口径。

## 规划

- 计划改动文件清单（**只改这些**）：`docs/BACKLOG.md`（状态）、本追踪文档、`TUI/src/app/layout/tool-line.ts`、`TUI/tests/tool-meta.test.ts`、`TUI/docs/DESIGN.md`。
- 验证：`TUI` 单包 `check` / `build` / `test`（`npm run test:tui` 自仓库根）+ 反向验证（撤修复必红）+ 根 `npm run check`；必要时 `npm run demo -- --smoke`。
- 明确不做：不动其它包；不顺手改相邻代码。

## 实现记录（2026-10-04）

- **审阅修订（采纳）**：① 结论表述收紧为「**设计缺口**（未规范空 detail）+ 实现自加占位」——依据 = `DESIGN.md:158` 的「无数据时整块省略，不留占位文字」+ 同文件 `toolCallLine` 省略空 summary（自相矛盾）+ git 侧成功/失败共用同一字符串（机械兜底）；② **R1（阻断）：成功行必须保留尾随空格**——`content-rules.ts` 的 `TOOL_STATUS_PREFIXES` / `isToolResult` / `renderToolText` 原按 `"✓ "`（带空格）匹配，裸 `✓` 会被判成**调用行**（染黄、新组、verbose step 误保留）且失去绿色；修法 = 成功态写 `"✓ "` **并把上述三处判定放宽为按符号**（`startsWith("✓")`），从根上解除尾随空格依赖；③ 失败空 detail 采用与 `dsh.ts:491` 对齐的兜底文案 `输出错误`（不再引入占位词汇；该分支实际近不可达 = 防御口径）；④ 测试补**前缀契约断言**（`(true,"")` 以 `"✓ "` 开头）+ 端到端（渲染行尾 `✓`、与有 detail 成功行同款 SGR）；⑤ `DESIGN.md` 两处（事件映射表 + 实现要点）补口径。
- 代码：`tool-line.ts`（`toolResultLine`：成功空 detail → `✓ `；失败空 detail → `✗ 输出错误`；meta 摘要拼接避免双空格）、`content-rules.ts`（前缀按符号判）、`tests/tool-meta.test.ts`（三态 + 前缀契约）、`tests/app.test.ts`（端到端）。
- 不做：`dsh.ts:3311`（评审子代理无产出）与 `CommandListPanel`（搜索空态）不动——语义不同；不为文案提常量（单调用点、内联符合既有风格）。

## 测试与证据

- `TUI` 单包 `check`：0 error；`npm run test:tui`：**1302 pass / 0 fail**（原 1301 + 新增端到端 1 条；tool-meta 的既有 pinned 断言同步改）。
- 反向验证（撤修复 = 恢复 `(detail || "(无结果)")` 占位）：`tool-meta.test.ts` 红 1 条（三态用例）、`app.test.ts` 红 1 条（端到端「不再出现空结果占位」）；还原后两文件复绿（1302 全绿）。
- 真机：未跑 `npm run demo`（沙箱无交互终端），改动为纯函数 + 单测/端到端渲染断言覆盖；`DESIGN.md` 口径已回写。

## 收尾

- 回写：`TUI/docs/DESIGN.md`（`:210` 事件映射表补 detail 空的两态 + 依据；实现要点补「行尾空格是前缀契约、分组/着色按符号判定」）。`SPEC.md` / `COMMANDS-SPEC.md` 无需改（无工具行文案口径）。
- 新发现问题：无。
- 本文件移入 `docs/archived/`；`docs/BACKLOG.md` 清理所接条目并重新编号、同步 §2 顺序依据。
- 临时产物：`tmp/tool-line.pristine` 已删；无残留。
