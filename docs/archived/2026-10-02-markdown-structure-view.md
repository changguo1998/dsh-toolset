# Markdown 结构视图（接取条目：`docs/BACKLOG.md`「Markdown 结构视图（只做 Markdown；纯文本与 PDF 均不做）」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

在 `fs_digest` 现有 Markdown 标题树（`outline`，Markdown = 最大标题级）之上补**块级结构**（列表 / 表格 / 代码块 / 引用）并给每节**行范围**，让模型按节读而不是整篇读。**不做**：纯文本启发式分节、PDF 与其它二进制文档。

边界（与条目 #3 `md-logic` 的分工，2026-10-02 用户裁定）：本条 = `fs-digest` 的**轻量通用入口**（只读、零新增依赖、与 `outline` / `signatures` / `pruned` 三模式统一）；`md-logic` = Markdown 专用深能力（精确解析 / 可查询 / 可选改写）。两者**并存不合并**。

## 现状（2026-10-02 读码）

- `fs-digest/src/outline.ts:75 parseMarkdownOutline(text, depth)`：单遍扫行，跳过围栏代码块，按 ATX 标题（`#{1,6}`）建树；节点只有 `{ kind: "heading", name, line, children }`——**没有行范围、没有块信息**。
- 渲染在 `fs-digest/src/main.ts:85-103`：`L{line} {kind} {name}`，缩进按层，全局上限 60 行，超出打「…（其余略）」。
- 结果类型在 `fs-digest/src/types.ts`：`OutlineNode` / `OutlineResult`（`nodes` + `source` + `depth`）。
- 现有测试 `fs-digest/tests/outline.test.ts` 断言 Markdown 树的层与行号（含「围栏内的 `#` 不是标题」用例）。
- 渲染上限、LSP 降级链（`buildOutline`：Markdown 走标题解析；其它语言优先 LSP）与错误分类（`binary` / `unsupported_language`）都已就位，本次复用而不改。

## 决策

- **D1（输出形态）**：**不引入新的 mode**，在 `outline` 内扩展（保持三模式统一与工具面不变）：
  - 标题节点加 `endLine?: number`（**该节的行范围结束行**，1 基；Markdown 才有）；
  - `OutlineResult` 加可选 `blocks?: MdBlock[]`（**仅 Markdown**），每项 `{ kind: "list" | "table" | "code" | "quote" | "frontmatter", line, endLine, section?: number, meta?: string }`；`section` = 所属标题的起始行（无标题归属时省略）。
  - 理由：树只负责「章节骨架」，块用**平铺清单 + 归属行**表达，避免在树里混入非标题子节点（那会污染 depth 语义与既有消费者）。
- **D2（行范围口径）**：节的范围 = 该标题行 → 下一个同级或更高级标题的前一行（末尾节到文件末），**去掉尾部空行**；块的范围同理（列表允许缩进续行；引用连续行合并；表格含表头与分隔行；代码块含围栏行本身）。frontmatter 只认**文件首行开始**的 `---` 配对块。
- **D3（渲染）**：标题行改为 `L{line}-{endLine} heading {name}`（Markdown 才有 `-endLine`；其它语言保持 `L{line}`）；块的呈现压在**标题树之后的一行紧凑清单**（`L3-4 list×2`、`L6-11 table×4行`、`L13-18 code·ts`、`L20-22 quote×3`），并受同一 60 行预算与「…（其余略）」截断约束。理由：单行清单不挤占树的层数语义，且模型一眼能看到「哪一节里有表 / 代码」。
- **D4（零新增依赖）**：纯手写单遍扫描（复用现有围栏状态机），不引入 remark / marked（`AGENTS.md`：不随意新增依赖；且本条定位是轻量入口）。
- **D5（不做）**：严格 CommonMark 兼容（引用嵌套、复杂表格对齐、列表松散/紧凑、HTML 块、setext 标题）不做；遇到不认识的结构退化为「不产出块」，绝不产出错误行号。纯文本 / PDF 不做（条目已收窄）。
- **D6（测试）**：`fs-digest/tests/outline.test.ts` 增 Markdown 用例——行范围（含末节到 EOF）、四类块 + frontmatter、围栏内不误判、缩进列表合并、表格含分隔行、无标题文档（只有块 / 空文档）不崩；并核对渲染输出格式。

## 计划改动文件清单

- `fs-digest/src/outline.ts`（`parseMarkdownOutline` 扩展 + 块扫描）
- `fs-digest/src/types.ts`（`OutlineNode.endLine`、`OutlineResult.blocks`、`MdBlock`）
- `fs-digest/src/main.ts`（`outline` 渲染：范围 + 块清单）
- `fs-digest/tests/outline.test.ts`（新用例）
- `fs-digest/README.md`（工具面描述同步：outline 现在给行范围与块清单）
- `docs/BACKLOG.md`（开工标「进行中」→ 关闭时清理）
- 本追踪文档（唯一过程记录）

## 实现记录

| 文件 | 改动 |
|---|---|
| `fs-digest/src/types.ts` | `OutlineNode.endLine?`；新增 `MdBlockKind` / `MdBlock`；`OutlineResult.blocks?` |
| `fs-digest/src/outline.ts` | 新增 `scanMarkdown(text, depth)`（导出，供 md-logic 复用）+ `MarkdownScan`；`parseMarkdownOutline` 退化为取其树；`OutlineData.blocks?`；`buildOutline` 对 Markdown 透传 blocks |
| `fs-digest/src/render.ts`（新） | 共享渲染器 `renderOutline`：标题树 ≤45 行 + 块清单 ≤15 行（**独立预算**），块行带 `§L{section}` 归属；工具面与 demo 同一来源 |
| `fs-digest/src/digest.ts` | outline 分支透传 `blocks` |
| `fs-digest/src/main.ts` | 改用 `renderOutline`；工具 description 与 `depth` 描述补「行范围 / 块清单 / 分辨率」 |
| `fs-digest/demo/main.ts` | 改用 `renderOutline`（消除第二套渲染实现的漂移风险） |
| `fs-digest/tests/outline.test.ts` | 新增「markdown 结构视图」12 例；`fs-digest/tests/digest.test.ts` 标题断言改为带行范围 |
| `fs-digest/README.md` | 能力表 / 渲染预算 / Markdown 输出示例 / 「Markdown 结构视图口径」边界段 / 用例数 42 → 61 |

## 验证

- `npm run check`（tsc --noEmit）：通过。
- `npm run build`：通过（`dist/` 重建，profile 走 `link:` 即生效）。
- `npm run test`：**61 例全绿**（原 48 例 + 新 13 例）。
- `npm run demo`：Markdown outline 实际输出（真跑核心路径）——
  ```
  (source: markdown)
  L1-20 heading 标题一
    L5-11 heading 小节 1.1
    L16-20 heading 小节 1.2
  L22 heading 标题二
  块结构（2 个）：
  §L5 L7 list·1项
  §L5 L11-14 code
  ```
  非 Markdown（`sample.ts`）保持 `L2 interface Payload` 旧形态（无 `endLine`）。
- 会话内 `fs_digest` 的生效确认需重启 TUI（插件模块在启动时载入），记入本条目残余。

## 审阅（子代理，2026-10-02，实现前设计评审）

**结论：有条件通过**，10 条问题全部落进实现：

| 审阅发现 | 处置 |
|---|---|
| 清单漏 `src/digest.ts`（blocks 到不了结果对象） | 已补，并透传 |
| 清单漏 `tests/digest.test.ts`（`L1 heading` 断言必失败） | 已改为 `/L1-\d+ heading 标题一/` |
| `demo/main.ts` 是第二套渲染实现（漂移风险） | 抽 `src/render.ts`，两处共用 |
| D1/D2 未定「标题集」口径 → `section` 可能指向未输出标题 | 明确「`endLine` / `section` 只指向输出中的标题行；depth 以下归入最近输出祖先节」，并加断言 |
| 块清单与树争预算（树满则块清单被丢） | 两个独立预算（树 45 / 块 15），各自省略标记 |
| 围栏判定不限缩进 → 4 空格 ``` 被当围栏（未闭合时吞掉全部标题） | 收紧为 `^ {0,3}` + 「闭合串不短于开启串」 |
| frontmatter 区间内标题未抑制（`# yaml 注释` 变标题） | frontmatter 只认**首行 + 有界配对 + 内部只含键/注释/空行**，且区间内不再识别标题 |
| 渲染口径未定义（计数语义 / `L1-1` 折叠） | 计数语义写进 README；`endLine === line` 折叠为 `L{n}` |
| 首行 BOM 使首个标题丢失、CRLF 的 `` 混入 | 扫描前剥 BOM、按 `/\r?\n/` 切行 |
| md-logic 必然二次解析 | 导出 `scanMarkdown`（纯函数，与建树解耦），md-logic 可直接复用同一套行范围口径 |

## 关闭记录

- 条目从 `docs/BACKLOG.md` §2 清理；其余条目重编（`ast-tools` 模型侧工具 → #1，`md-logic` → #2，`md-map` → #3，usage 口径 → #4，命令模板终态 → #5，executor 隔离 → #6，STATUS 对齐 → #7）；§2 顺序依据的「#3 复用 #2」编号笔误一并修正。
- **残余**：① 会话内 `fs_digest` 生效确认需用户重启 TUI（进程外已验：check / build / 61 例 / demo）；② 不做 setext / HTML 块 / 嵌套引用 / 复杂表格对齐（已写进 README 边界）；③ 纯文本与 PDF 不做（条目已收窄）。
- 本追踪文档移入 `docs/archived/`。
