# TUI/docs/IMPLEMENTATION.md 按新规范拆分后删除（接取条目：docs/BACKLOG.md「`TUI/docs/IMPLEMENTATION.md` 按新规范拆分后删除」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把 `TUI/docs/IMPLEMENTATION.md`（387 行、30 节）按 `docs/WORKFLOW-STANDARD.md` 的文档分工拆分：命令路由与落点 / 机制类 → `TUI/docs/DESIGN.md`；渲染 / 排版类 → `TUI/docs/SPEC.md`；「验证方式」并入 `TUI/README.md`（用户 2026-09-29 裁定，替代条目原文的 `AGENTS.md` 落点）；拆分后删除原文件并重定向全部存活引用。

## 调研

来源：`TUI/docs/IMPLEMENTATION.md`（全文 387 行）、`TUI/docs/DESIGN.md`（260 行）、`TUI/docs/SPEC.md`（654 行）、`TUI/README.md`、全仓 `grep -rn "IMPLEMENTATION.md"`、`docs/BACKLOG.md` #40。

- 原文结构：30 个 `##`/`###` 节——命令面 6 节（路由 / 落点 / 面板 / 非显然要点 / /model / 补全 / 状态选项面板 / 问答审批 / /theme）、机制类 8 节（文本管线 / 事件→状态→渲染 / 会话状态恢复 / 滚动偏移收敛 / 排队消息 / 符号规范化 / 清理空会话 / 声音提醒）、渲染排版类 14 节（状态列与标题栏 / 历史区锚点 / FrameGeometry / gutter / 多行输入 / 活动区三节 / /help / markdown 列表 / markdown 表格 / 字符宽度 / 排版缓存 / 增量渲染 + 已评估未采用）、验证 1 节。
- 目标文档现状：`SPEC.md` 为编号规格（§2-§14，末尾追加新节、编号稳定）；`DESIGN.md` 为无编号主题式设计文档；两文档与原文主题有部分重叠（标题栏 / 活动区 / 排队 / 表格等），重叠处 `SPEC` 记规则、原文记实现口径与回归索引。
- 存活引用面（`grep` 实测）：`TUI/docs/DESIGN.md` 5、`TUI/README.md` 5、`TUI/docs/SPEC.md` 4、`TUI/docs/COMMANDS.md` 3、`TUI/docs/STATUS.md` 2、`TUI/docs/COMMANDS-SPEC.md` 2、`knowledge-base/README.md` 2（指向其**自身**不存在的 `IMPLEMENTATION.md`，与本条无关）、`TUI/src/app/layout/panel.ts` 1、`TUI/src/app/index.ts` 1、根 `README.md` 1、`docs/host/HOST-UPGRADE-0.1.7-rc.2.md` 1（历史记录）、`docs/BACKLOG.md` #40 自身 1；`TUI/docs/archived/` 与根 `archive/` 的历史引用不改（历史记录）。
- 条目原文的「58 处引用」含归档文档（历史引用不应改），存活可改约 20 处。

## 决策

1. **拆分落点**（条目裁定 + 本次实现微调）：渲染 / 排版 14 节 → `SPEC.md` **§15 排版与渲染实现要点 [impl]**（新增子节 15.1-15.9，含 `#### 15.9.1 已评估未采用`）；机制 / 命令 17 节 → `DESIGN.md` **「实现要点（机制与命令）」**（`###` 子节沿用原标题）；验证方式 → `TUI/README.md`「构建与测试」（用户裁定，替代 `AGENTS.md`）。
1. **编号与层级**：`SPEC.md` 按其自述「章节编号稳定、新章节追加在末尾」——`§15` 为一组实现要点（`### 15.x` 子节），不改动既有 §2-§14 编号；`DESIGN.md` 无编号体系，末尾追加一节。
1. **不重写内容**：迁移保持原文（逐行搬移），仅降一级标题以适配新层级；跨文档指针按新落点改（如「见 IMPLEMENTATION.md」→「见 §15.x」/「见 DESIGN.md「…」」）。
1. **「已评估未采用」留在渲染语境**（微调条目原文的「→ DESIGN」）：该节是渲染性能实测（列级重写 / 行缓存 / DECSTBM 三项不做的结论），与 `§15.9 增量渲染`同主题，拆开会破坏可读性——随主题落 `SPEC.md` §15.9.1，并在本文件记录该微调。
1. **历史引用不改**：`TUI/docs/archived/`、根 `archive/`、`docs/host/HOST-UPGRADE-0.1.7-rc.2.md` §0.1（历史记录，指向当时的文件名是正确的历史事实）。
1. **`STATUS.md` 仅改链接**（两处路径重定向，不动任何状态内容——遵守「STATUS 由用户择时更新」的口径）。

## 规划

任务拆分：

1. 迁移渲染 / 排版 14 节 → `SPEC.md` §15（含漏切的 `### 已评估未采用` 补迁）。
1. 迁移机制 / 命令 17 节 → `DESIGN.md` 末尾新节。
1. 「验证方式」并入 `TUI/README.md`「构建与测试」。
1. 删除 `TUI/docs/IMPLEMENTATION.md`；重定向全部存活引用（20 处，含源码注释 2 处）。
1. 验证：`npm run check` / `test:tui` / `build` + `mdformat`。
1. 收尾：回写 DESIGN / README 头部「配套」清单；条目清理 + 归档；途中发现登记。

计划改动文件清单（**只改这些**）：

- `docs/BACKLOG.md`（条目状态 / 清理；途中发现新条目）
- `docs/implementation/2026-09-29-tui-implementation-doc-split.md`（本追踪文档）
- `TUI/docs/SPEC.md`（+§15）
- `TUI/docs/DESIGN.md`（+实现要点节、头部配套清单、1 处引用）
- `TUI/README.md`（验证方式并入、2 处引用、文档表行删除）
- `TUI/docs/COMMANDS.md`、`TUI/docs/COMMANDS-SPEC.md`（引用重定向）
- `TUI/docs/STATUS.md`（仅链接重定向 ×2）
- `TUI/src/app/layout/panel.ts`、`TUI/src/app/index.ts`（注释里的路径引用）
- 根 `README.md`（文档索引行删除）
- 删除：`TUI/docs/IMPLEMENTATION.md`

明确不做：不改 `TUI/docs/archived/`、根 `archive/`、`docs/host/` 的历史引用；不修 `knowledge-base/README.md` 指向自身缺失文档的既有断链（另登记条目）；不改 `SPEC.md` §2-§14 既有编号与内容。

## 实现记录

2026-09-29：

- `TUI/docs/SPEC.md`：追加 `## 15. 排版与渲染实现要点 [impl]`（15.1 状态列与标题栏 / 15.2 历史区锚点与渐进窗口 / 15.3 FrameGeometry / 15.4 文本留白与多行输入 / 15.5 活动区渲染（生命周期 / 详略 / 排列）/ 15.6 表格与列表排版 / 15.7 字符宽度 / 15.8 排版缓存与合帧 / 15.9 增量渲染与防闪烁 + 15.9.1 已评估未采用），共 196 行（原文标题降级为 `###`/`####`）。
- `TUI/docs/DESIGN.md`：追加 `## 实现要点（机制与命令）`（17 个 `###` 子节：命令路由 / 命令实现落点 / 共享列表面板 / 非显然实现要点 / 文本管线 / 事件→状态→渲染 / 会话状态恢复 / 滚动偏移收敛 / 排队消息 / 符号规范化 / 清理空会话 / 声音提醒 / /model / 补全 / 状态选项面板 / 问答审批 / /theme），共 246 行；头部「不负责 / 配套」两行改为指向 `SPEC.md` §15。
- `TUI/README.md`：「构建与测试」补 `verify-p0.py` 与打包验证两行（原「验证方式」节）；两处机制指针改指 `docs/SPEC.md` §15.7/§15.8；文档表的 IMPLEMENTATION 行删除。
- 删除 `TUI/docs/IMPLEMENTATION.md`；存活引用重定向 20 处（DESIGN 4、README 2、SPEC 4、COMMANDS 3、COMMANDS-SPEC 2、STATUS 2、panel.ts 1、index.ts 1、根 README 1）。
- 途中发现（登记见收尾）：`knowledge-base/README.md` 两处指向 `IMPLEMENTATION.md`，但该包 `docs/` 下只有 `DESIGN.md`——既有断链（与本条无关）。

## 测试与证据

- 根 `npm run check`：通过（0 处 `error TS`）。
- `npm run test:tui`：1205 pass / 0 fail（文档 + 注释改动，无行为影响）。
- `TUI && npm run build`：通过（刷新 dist 中的注释文本）。
- `mdformat` 全量通过（DESIGN / SPEC / README / COMMANDS / COMMANDS-SPEC / STATUS / 根 README）。
- 迁移完整性：旧文件 33 个章节标题在新落点 `DESIGN.md` / `SPEC.md` / `README.md` 中 32 个可原样检索到（1 个为「验证方式」按裁定并入 README「构建与测试」；标题截断的 4 处已修复、3 处合并子节已补回原标题）。
- 引用残留检查：`grep -rn "TUI/docs/IMPLEMENTATION.md"` 在 `TUI/src`、`TUI/docs/*.md`、`TUI/README.md`、根 `README.md` 为 0；仅剩历史文档（archived / archive / docs/host）与两处「承接原 IMPLEMENTATION.md」的说明文字（有意保留）。

## 收尾

- 回写 `TUI/docs/DESIGN.md`（头部配套清单 + 引用）与 `TUI/README.md`（文档表 / 机制指针 / 验证方式）。
- 条目从 `docs/BACKLOG.md` 清理移除；途中发现另登记：`knowledge-base/README.md` 断链（指向自身不存在的 `IMPLEMENTATION.md`，含 §6 断言口径）。
- 本文件移入 `docs/archived/`。
- 遗留项：条目原文「重定向 58 处引用」含归档历史引用（按历史不改，实际重定向 20 处存活引用）。
- 临时文件：无。
