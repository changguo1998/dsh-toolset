# md-map 设计

> 职责：本包的架构与机制沉淀（为什么这样切、边界在哪）
> 不负责：能力清单与配置表（见 `README.md`）、未完成项（见本目录 `BACKLOG.md`）、变更过程（见 `docs/archived/` 与 git 历史）
> 过期条件：无（机制变化即更新）

## 1. 定位

**文档版的 `code-map`**：扫一个 root 下的 Markdown，建一份「文档 + 边 + 锚点」的内存索引，回答「谁引用了这份文档 / 改这份文档会影响谁 / 哪些文档零入边 / 哪些链接断了」。面向 agent 的典型问题：**改动前的影响面**与**改完后的断链自查**。

与相邻能力的分工：`md-logic` 是**单文件**结构（节树 / 块 / 按节改写）；本包是**跨文件**关系（谁引用谁、锚点是否存在）。两者共享「Markdown 里什么算引用」的直觉，但解析目标不同：前者要节树，后者要边。

## 2. 架构取舍

- **索引是内存态、显式重建**：`buildIndex()` 每次调用重新扫描（`index` / `refresh` 同义），服务实例只保留「最近一次」的索引供查询复用。不做磁盘缓存 —— 文档索引小、重建便宜，而缓存失效（mtime / 内容 hash）会引入一类难解释的陈旧结果。
- **边按「形态」分类型**（`MdEdgeKind`，6 型）：`internal`（`[文本](a.md)`）、`wiki`（`[[a]]`）、`file`（指向非 md 的真实文件 / 目录）、`external`（`http(s)` / `mailto` / `tel` 等站外目标）、`ref`（**行内代码里的路径引用**，如 `` `docs/BACKLOG.md` ``）、`broken`（路径或锚点不存在）。类型既是过滤维度（`callers(path, {kind})`），也是「这条边的可信度」声明 —— 例如 `ref` 只在索引内命中或唯一同名时才产生。
- **锚点校验独立于边的存在**：边指向的文档存在但锚点不存在 → 边仍保留，另打 `anchorOk: false` 并进 `broken`（`missing-anchor`）。理由：锚点断链与文档断链是两种修复动作，混在一起会丢信息。
- **`exclude` 只决定「哪些 md 进索引」**，不决定「哪些路径能被引用」：指向被排除目录（`node_modules/…`）的引用照旧能落 `file` 边 —— 与既有 `file` 边口径一致。反过来，**md 兜底**（按磁盘存在性把无扩展名 token 落成边）刻意不做：否则被 exclude 挡住的文档会绕过滤变成命中。
- **不猜歧义**：跨模块裸名（`` `SPEC.md` ``）只在「索引里唯一同名」时命中；两个同名 → 不产边且计 `refUnresolved`。宁可漏一条边，也不产出错误的影响面。

## 3. 扫描与索引（`src/indexer.ts`）

- `findMarkdownFiles()`：递归 DFS 扫 root 下的 `.md`（每层按 `localeCompare` 排序），POSIX 相对路径，跳过 `DEFAULT_EXCLUDES`（`node_modules` / `.git` / `dist` / `.pi-glla` / `tmp`）+ 配置追加项；`DEFAULT_MAX_FILES = 2000` 截断（防单次索引把上下文吃光）。
- `buildIndex()`：逐文档解析 → 收集锚点（`buildAnchors` 产 slug，按文档存 `anchorsByPath`）→ 解析正文里的引用（`links.ts`）→ 解析**引用式定义**（`[tag]: url`）→ 逐边定类型（见 §4）→ 汇总计数（`edges` / `fileEdges` / `refEdges` / `refUnresolved` / `broken`）。
- `toPosix()` 统一分隔符：本包所有路径（入参、出参、边目标）都是 **root 内 POSIX 相对路径**；绝对路径与 `..` 越界在解析层就被丢弃。

## 4. 引用解析口径（`src/links.ts`）

- 扫描面：`[文本](href)` 行内链接、图片、引用式定义、`[[wiki]]`，以及**行内代码里的路径 token**（`ref` 形态）。行内代码先 `stripInlineCode*` 再判定，避免把示例文本当引用。
- `splitHref()`：拆 `path` / `anchor` / 查询串；`resolveDocPath()`：按「源文档所在目录」解析相对路径，越界（仓库外）→ `null`（该边丢弃，不产出 root 外的 `to`）。
- 候选序（`internal` / `wiki`）：按源文档相对路径 → root 相对 → 逐级 `.md` 兜底（`a` → `a.md` → `a/README.md` …），命中即停；全不中 → `broken`。
- `ref` 形态的三处补口（2026-10-04）：① `x.md#sec` 先拆锚点（否则整串当路径、永不命中）；② 目录形态 token（`` `docs/archived` ``）按 `stat().isDirectory()` 落 `file` 边（名含点的目录如 `docs/v1.0` 同样算）；③ 跨模块裸名按「索引内唯一同名」兜底。出边目标恒为 **root 内规范化路径**（`normalize` + 拒绝 `..` / 绝对路径 / 空路径）。

## 5. 查询与渲染（`src/query.ts` / `src/render.ts`）

- `getDoc` / `resolveDocRef`（按路径或唯一后缀解析）、`callers`（入边，可按 `kind` / `anchor` 过滤）、`impact`（反向引用闭包，按层返回，`depth` 缺省 2）、`orphans`（零入边）、`topBacklinks`、`report` / `summary`（总览与计数）。
- `render.ts` 统一限长（`RENDER_LIMIT = 80`）：索引 / 调用者 / 影响面 / 断链 / 报告各一套渲染，超限截断并注明。渲染是**给人看**的，结构化消费走服务面。

## 6. 服务面与工具（`src/index.ts` / `src/service.ts`）

- `inject: ["tools"]`、`provide: ["mdMap"]`：工具面单个 `md_map`（`action` = `index` / `refresh` / `callers` / `impact` / `orphans` / `report` / `summary`）；服务面 `createMdMapService()` 供其它插件查询（持有最近一次索引，`dispose` 无持久资源，仅为对齐契约）。
- 配置（`MdMapOptions`）：`root` / `exclude` / `maxFiles`；调用级参数覆盖实例配置。

## 7. 约束与已知边界

- 索引**不落盘**、不增量：每次 `index` 全量重扫（大仓库靠 `maxFiles` 截断）；查询面读的是「最近一次」索引，文档已改但未 `refresh` 时会给出陈旧答案。
- `ref` / `file` 兜底**不受 `exclude` 约束**（见 §2），故 `node_modules/x` 这类 token 会产出 `file` 边。
- `ref` 边的锚点不参与校验（`file` 边不带锚点），`` `docs/archived#sec` `` 的锚点按既有口径不落。
- 裸名唯一命中依赖「索引内」唯一性：被 `maxFiles` 截断或 `exclude` 挡住的同名文档不算候选。

## 8. 明确不做

- 不做 Markdown 渲染 / 预览、不做链接自动修复（只报告断链）。
- 不做跨仓库 / 多 root 索引（一次一个 root）。
- 不做增量缓存与 watch（重建比失效判断便宜）。
- 不改写文档内容（改写属 `md-logic` / `hash_edit`）。
