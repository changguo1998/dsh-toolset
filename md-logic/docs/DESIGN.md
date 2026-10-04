# md-logic 设计

> 职责：本包的架构与机制沉淀（为什么这样切、边界在哪）
> 不负责：能力清单与配置表（见 `README.md`）、未完成项（见本目录 `BACKLOG.md`）、变更过程（见 `docs/archived/` 与 git 历史）
> 过期条件：无（机制变化即更新）

## 1. 定位

Markdown 的**逻辑结构层**：把一篇文档读成「节树（标题层级 + 每节行范围 + 内容 hash）」并提供按节整块改写；同时能列块（`blocks`）与链接（`links`）。它是 agent 改 Markdown 的**默认入口**——比行号编辑稳（行漂移由结构 + hash 兜住），比整文件替换小（只动目标节）。

与相邻能力的分工：`hash_edit` 是行级 `LINE:HASH` 锚点（细粒度）、官方 `edit` 是文件级字符串替换 + 版本守卫；**本包按节**（标题 + 行范围 + 内容 hash）。三者并存不是冗余：粒度不同、失败模式不同。

## 2. 架构取舍

- **节树是主数据结构，不是「行号区间表」**：解析（marked + 自己的行号回填）后每节带 `level` / `title` / `line` / `endLine` / 内容 `hash`。所有查询（`structure` / 定位 / 漂移检测）都从同一棵树出发，避免「行号算法」与「层级算法」两套真相。
- **改写按节整块替换，不做行级 patch**：行级 patch 的边界要靠缩进 / 列表归属判断（易错且难解释）；「整节新文本」把责任交给调用方，本包只保证**结构安全**（不悄悄改变其后节的归属）。
- **双锚定位**：「同标题 + 同范围」是基本匹配，可选 `section_hash` 补上「同标题同范围但节体 / 层级已被外部改动」的漂移盲区（`section_stale` → fail-safe 不落盘）。
- **不做语法校验，但做结构守卫**：本包不保证 content 是「好 Markdown」，只拦**会静默改变节树**的写法（首行不是标题行、setext 吞段、改层级、内嵌同级/更高级标题、未闭合围栏 / 注释）。理由是这些写法在 CommonMark 里不报错，只是让**后面的节消失**。
- **失败用稳定错误码**（`EditFailureCode`）而非文案匹配；文案可改、码不改。

## 3. 解析与节树（`src/parse.ts` / `src/query.ts`）

- `detectFrontmatter()`：识别 YAML frontmatter（用于「别把 frontmatter 当正文」的判定）。
- `parseMarkdownDocument()`：用 marked 拿块级结构，再回填**行号**与**层级**，产 `SectionNode[]`（行号一律 **1 基**、范围含两端；ATX 与 setext 等价：`===` = h1、`---` = h2，按层级判定而非写法）。
- `flattenSections()`：深度优先拍平（父 → 子），用于「首行之外是否出现 ≤ 目标层级标题」这类检查与渲染。
- 查询面：`findSections`（按标题 / 层级 / 命中条件）、`sectionAt`（按行号）、`queryBlocks`（节内块，带类型 / 行范围 / 列表条目数与嵌套层数 / 表格行列数）、`listLinks`（链接、图片、引用式定义）。

## 4. 改写管线（`src/edit.ts`）

按顺序（**错误优先级即此顺序**，前一步失败不进入后一步）：

1. **① 定位**：按标题取候选（同标题多节**由行范围消歧**，不因此拒绝）；找不到 → `section_missing`；范围与当前树不符 → `section_drift`（带当前范围），行号越界先判 `range_out_of_bounds`；带 `section_hash` 且不符 → `section_stale`。`section_ambiguous` 只在定位结果为空时兜底（内部错误，正常不可达）。
1. **①.5 content 结构守卫**（空串 = 删除该节，跳过）：首行必须是标题行（ATX / setext）→ 否则 `content_invalid`；setext 且目标节前一行非空 → 拒绝（会吞并上一段）；首行层级须与目标节一致（文本可不同 = 合法重命名）；首行**之外**不得出现 ≤ 目标层级的标题；**吞节裁决**：把 content 代进目标节范围**重新解析**、比较「改前 / 改后」的节大纲——目标节**之后**（且不在其子树内）的节有丢失即拒（判据文本与落盘文本同口径：剥掉 content 的单个尾随换行）；启发式扫描 `unclosedBlockReason()` 只用于给出可读成因文案（未闭合围栏 / 注释的行号），不参与判据。
1. **② 重叠拒绝**：同一批 edits 的节区间相交（父节与其子节同时被改）→ `overlap`。
1. **③ 原子写**：读文件（记录内容 hash）→ 生成新内容 → 临时文件 + `rename`（保权限）→ 期间文件被外部改动 → `file_changed`（不落盘）。
1. 返回值分两路：`ok: true` + 新结构 / 变更摘要；`ok: false` + 上述码之一 + 可读文案。

**失败码全集**（`EditFailureCode`，12 个）：`edits_invalid`（入参形状）/ `content_invalid`（结构守卫）/ `section_missing` / `section_ambiguous` / `section_drift`（范围与树不符）/ `section_stale`（内容 hash 不符）/ `range_out_of_bounds` / `overlap` / `read_failed` / `not_utf8` / `write_failed` / `file_changed`（读→写之间被外部改动）。

## 5. 渲染与工具面（`src/render.ts` / `src/tools.ts`）

- 渲染统一限长（`RENDER_LIMIT = 80`）：`structure` 出节树（含每节 `L{起}-{止}` 与 `·#xxxxxxxx` 内容 hash，供后续 edit 直接引用）、`blocks` / `links` 出清单、`replace` 出变更摘要。限长是为了让上下文里「看结构」便宜。
- 工具面：单个 `md_logic` 工具 + `action` 参数（`structure` / `blocks` / `links` / `replace`），描述里写明「读用前三者、改写用 `replace`」——**action 面是稳定契约**，描述随守卫口径同步更新（三处：主描述 / edits 参数 / 单项说明）。
- cwd 解析走 `resolveExecCwd()`（工具执行 ctx 优先），大文件由 `DEFAULT_MAX_BYTES` 兜底。

## 6. 约束与已知边界

- **容器相位（2026-10-05 起）**：围栏 / 注释的**吞节判据**改为解析器裁决（见 §4 ①.5），故列表项 / 引用块内的围栏与注释不再造成误拒 / 漏拦；启发式里仍做容器前缀剥离与「闭行须与开栏同相位族 `[phase, phase+3]`」判定，仅用于生成成因文案。口径与实证见 `docs/archived/2026-10-05-unclosed-block-container-aware.md`。
- 渲染限长会截断（超出部分按 `RENDER_LIMIT` 截），需要完整内容时直接读文件。
- 节树是**单文件**视图：跨文件结构（谁引用了谁）属 `md-map`。
- 内容 hash 是**节体**级：改造某节的子节会让祖先节的 hash 也失效（需重取 `structure`）。

## 7. 明确不做

- 不做 Markdown 语法校验 / 格式化（那是 formatter 的职责）。
- 不做跨文件改写、不做全文搜索替换（用 `hash_edit` / 官方 `edit` / `grep`）。
- 不做「按行号改写」的便利接口：那会把结构安全的保证让位给调用方的算术。
- 不接管 frontmatter 的语义（只识别边界，不解析成配置）。
