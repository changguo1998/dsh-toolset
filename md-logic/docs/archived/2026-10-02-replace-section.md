# 改写面：按节替换 + 锚点安全（接取条目：`md-logic/docs/BACKLOG.md` #1）

状态：进行中　　开启：2026-10-02　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`md_logic` 目前只读（structure / blocks / links）；本条目补**改写面**：按节替换，且**替换前校验目标节的标题行与行范围仍与解析时一致**（漂移即拒）、**整批原子写**、失败不落盘；工具面与 `hash_edit`（行级 LINE:HASH 锚点）/ 官方 `edit`（文件级版本守卫）划清分工；README 补改写段。

## 调研（2026-10-02）

- 现有结构面：`parseMarkdownDocument(text)` 产出 `sections`（含 `title` / `level` / `line` / `endLine`，1 基、尾空行不计）、`lines`；工具面 `structure` 已把这些字段渲染给模型 ✓ —— 模型手里天然有「标题原文 + 行范围」，正好当**漂移检测的锚点**（与 `hash_edit` 的 `LINE:HASH` 同思路，但粒度是节、语义是标题+范围）。
- 写文件先例：`hash-edit/src/fs.ts` 的 `applyAnchoredEditsFile`（临时文件 + rename 原子写、失败不落盘）；md-logic 目前只读，无写路径。
- 归一化坑（md-logic 建包时已踩）：解析前会剥 BOM + `\r\n?`→`\n`；写回时必须**保留原文的换行风格与 BOM**，否则整文件 diff 爆炸。
- 分工现状：`hash_edit` 行级锚点（LINE:HASH、整批原子拒绝）适合「改若干行」；官方 `edit` 是文件级字符串替换 + 版本守卫；`md_logic` 的新面按**节**（标题 + 行范围漂移检测）——三者粒度/语义不同，描述里互相指路。

## 决策

- **D1（API）**：新增 `src/edit.ts`：
  - `replaceSections(text: string, edits: SectionEdit[]): { ok: true; text: string; applied: number } | { ok: false; code: ...; error: string; details?: ... }`（**纯函数**，不碰磁盘；全部校验通过才返回新文本）；
  - `SectionEdit = { heading: string; startLine: number; endLine: number; content: string }`——`heading` 为标题**原行文本**（如 `## 模型侧工具`，与 `structure` 输出一致）、`startLine` / `endLine` 为该节行范围（1 基，含端点）、`content` 为**整节新文本**（含标题行；空串 = 删除该节）。
- **D2（漂移检测）**：在原文上按同样规则解析 → 找 `heading` 完全相同的节（多个则取范围内/唯一一个；不唯一 → 拒绝并列出候选行号）→ 校验其 `[line, endLine]` 与传入一致；不一致 → `code: "section_drift"` + 当前范围（模型据此重新 structure 再改）。标题不存在 → `code: "section_missing"`。
- **D3（整批原子）**：多条 edits 在内存里**自下而上**（按行号降序）应用，任一条校验失败 → 整体拒绝、不返回文本；重叠区间 → `code: "overlap"`。
- **D4（写盘）**：`src/edit.ts` 另出 `replaceSectionsFile(path, edits, root?)`：读原文 → 纯函数校验/替换 → 原子写（同目录临时文件 + `rename`；失败清理临时文件、**不落盘**）。**保留 BOM 与换行风格**（检测 `\r\n` → 重建时用同款；新内容按其自身换行，未带换行的内容用文件风格拼接）。
- **D5（工具面）**：`md_logic` 增 `action: "replace"`——参数 `path` + `edits[]`（`heading` / `start_line` / `end_line` / `content`）；返回值 `{ok, path, applied}` 或 `{error, code, details}`；**只在校验通过后写**；`output.schema` 照旧 + 全函数 render（失败渲染原因与建议：重新 `structure` 取最新范围）。描述里写清三方分工（`md_logic replace` = 按节 + 漂移检测；`hash_edit` = 行级锚点；官方 `edit` = 文件级字符串替换）。
- **D6（验证）**：单测（纯函数 + 落盘）：happy path（替换节体、保留其它节与尾空行）、标题漂移 / 范围漂移 / 标题缺失 / 重复标题 / 重叠区间 / 越界 → 拒绝且**文件字节不变**、批量原子（第 2 条失败 → 第 1 条也不落盘）、BOM + CRLF 保留、空内容删除节、工具面（参数校验先于 IO、失败不写、render 形状）；dist 级真跑一次（临时文件 → structure 取范围 → replace → 复核）。
- **D7（不做）**：不做插入/移动节（只整体替换/删除）；不做 Markdown 语法校验（只保证结构漂移安全）；不引入依赖；不改读面行为。
- **D8（文档）**：`md-logic/README.md` 增「改写面」段（API、漂移语义、原子性、与另两个工具的分工）；模块 BACKLOG 关闭本条。

## 计划改动文件清单

- `md-logic/src/edit.ts`（新）、`md-logic/src/index.ts`（导出）、`md-logic/src/tools.ts`（`replace` action + 描述分工）、`md-logic/src/render.ts`（replace 渲染）
- `md-logic/tests/edit.test.ts`（新）、`md-logic/tests/tool.test.ts`（replace 用例）
- `md-logic/README.md`、`md-logic/docs/BACKLOG.md`（进行中 → 关闭）、本追踪文档

## 实现记录

| 文件 | 改动 |
|---|---|
| `md-logic/src/edit.ts`（新） | `replaceSections(text, edits)`（纯函数：值域校验 → 定位 + 漂移校验 → 重叠拒绝 → 自下而上替换 → 按 BOM/换行风格重建）+ `replaceSectionsFile(path, edits, root?)`（读 → 纯函数 → 同目录临时文件 + `rename` 原子写；失败清临时文件；NUL 拒写） |
| `md-logic/src/tools.ts` | `md_logic` 增 `action: "replace"`：`edits` 参数（`{heading, start_line, end_line, content}`）；`parseEdits` 纯校验；**写入分支在读盘之前**（写入路径不走 readMarkdown）；描述补改写分工（md_logic 按节 / hash_edit 行级 / 官方 edit 文件级） |
| `md-logic/src/render.ts` | `renderReplace()`：成功报处数；失败给 `code` + 原因 + 「先 structure 取最新范围」的下一步；drift 附当前范围 |
| `md-logic/src/index.ts` | 导出 `replaceSections` / `replaceSectionsFile` 与三个类型 |
| `md-logic/tests/edit.test.ts`（新） | 7 例：替换节体（其它节与尾空行不动）、漂移/缺失/参数非法、重叠（父+子）、空串删除、**BOM + CRLF 字节级保留**、落盘失败不写 + 成功原子写、工具面（校验先于 IO / drift 渲染 / 成功写盘 + 处数） |

## 测试与证据（2026-10-02）

- 包内：`npm run check` exit 0、`build` 通过、`npm run test` **41 例全绿**（改前 34 例）。
- **dist 级真机形态**（加载 `dist/src/index.js` → `apply` → 临时文件上走 `structure` → `replace`）：
  - `structure` 给 `L9-11 h2 乙` → `replace` 用该范围 → 「已按节替换：/tmp/…/a.md（1 处，整批原子写）」、文件确实含新文本 ✓；
  - 用错范围 → 「md_logic replace 失败（section_drift）：节「甲」的行范围已变（结构漂移）：你给 99-100，当前为 5-7；请重新 structure 后再改」✓（模型有明确重试路径）。
- 全仓：`npm run check` / `build` / `test` 见关闭前复跑。

## 审阅（子代理，2026-10-02）——结论：**有条件通过**

方向成立；必修项全部处置（含 3 处写路径 P0 与 D1 文档口径）：

| 审阅发现 | 处置 |
|---|---|
| P0-1 权限位丢失（`rename` 后 0600 → 0664） | `stat` 取 mode → 临时文件写入后**显式 `chmod`**（不受 umask 影响）；测试断言 0600 保留 |
| P0-2 非 UTF-8 静默损坏（有损 `readFile(…,"utf8")` 把字节改成 U+FFFD 仍报 ok） | 读 Buffer + `new TextDecoder("utf-8",{fatal:true})`；失败 → `code:"not_utf8"`；测试断言字节不变 |
| P0-3 `maxBytes` / `isFile` 守卫被写路径绕过 | `replaceSectionsFile` 增 `maxBytes` 参数（读取前判 size）+ `stat().isFile()` 守卫；工具面透传 `maxBytes`；测试覆盖超限拒写 |
| P0-4 描述自相矛盾（「单文件、只读」+ action 描述漏 replace + `edits` 无 items） | 描述改「读 + 按节改写」、action 描述补 replace、`edits` 补 `items` schema、头注释同步 |
| P1-5 混合换行文件被整体改写 | 未改（口径）→ 模块 BACKLOG #2 |
| P1-6 D1 事实错误（heading 是**标题文本**，非「标题原行」；setext 无单行原文） | 文档 D1 已订正为「标题文本，与 `structure` 的 `L{n} h{级} 标题` 中标题部分一致」 |
| P1-7 漂移盲区（同标题 + 同范围挡不住节体 / level 外部改动） | 未改（本条目锚点口径即「标题 + 行范围」）→ 模块 BACKLOG #1（节级 hash 提案） |
| P1-8 `content` 尾随换行累积空行 | 已改：尾随单个换行视作行终止符（测试断言不累积） |
| P1-9 `content` 无结构校验（首行非标题会静默并入父节 / 引入新标题改范围） | 未改 → 模块 BACKLOG #3 |
| P2-10 越界报 `section_drift` 误导 | 已改：新增 `range_out_of_bounds`（漂移校验前先判 `endLine <= 总行数`）；重复标题按「同标题 + 精确范围」唯一匹配，测试覆盖两候选 |
| P2-11 无 fsync / tmp 名无随机 / symlink | tmp 名加随机后缀（避免同进程并发互截）；fsync 与 symlink 语义记残余 |
| P2-12 绕开 fs-observation-policy 未声明 | README 边界段已补（同 ast-tools 口径） |
| 漏项 1 跨包 `security-guard` 未覆盖插件写工具 | 项目级 `docs/BACKLOG.md` #5 |
| 漏项 2 文档同步面（本包 README / 根双语 / ARCHITECTURE-REUSE / AGENTS / 例数） | 已同步（28 例 → 45 例） |
| 漏项 3 计划外改动 `tests/parse.test.ts`（纯格式） | `format` 重排，与本次功能无关 → **已回退**；文件清单已更正（replace 用例落在新 `tests/edit.test.ts`，未改 `tests/tool.test.ts`） |

## 关闭记录

- 条目从 `md-logic/docs/BACKLOG.md` 清理；模块现存 #1 节级 hash、#2 混合 EOL、#3 `content` 结构校验（均来自本次审阅）。
- **残余**：① 会话内生效需重启 TUI（dist 已重建）；② 真机 profile 未实测（dist 级证据见上）；③ fsync 取舍（崩溃可能留 0 字节目标，与 hash-edit 先例一致）与 symlink 目标会被替换成常规文件；④ Windows rename 覆盖为静态推断。
- 本追踪文档移入 `md-logic/docs/archived/`。
