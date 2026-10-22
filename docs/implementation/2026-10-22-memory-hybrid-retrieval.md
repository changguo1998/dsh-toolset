# memory-base 的意图 / 多策略混合检索（接取条目：`docs/BACKLOG.md` §2「2. memory-base 的意图 / 多策略混合检索」）

状态：进行中（d1 决策完成）　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把 `memory-base` 的检索从单语词面 FTS5 升级为**混合检索**：FTS5 BM25 权重 + 词项邻近（proximity）加分 + 多路结果融合（RRF），并允许调用方按策略取用。

交付：`memory_query` 等入口可指定策略（缺省保持现有行为）、固定查询与期望命中序的测试夹具、延迟不劣化的证据。

边界：不改存储 schema 与写入 / 巩固逻辑；不引入外部检索依赖；不改变无命中时的行为。

## 调研

现状（`memory-base/src`，2026-10-22 通读）：

- **索引**：每个分类表挂两套 external content FTS5——`<table>_fts`（`tokenize='porter'`，词干）与 `<table>_trigram_fts`（`tokenize='trigram'`，≥3 字符子串），由 TRIGGER 写直达同步（`schema.ts:105`）。索引与表结构本身已够用，**无需改 schema**。
- **检索**（`knowledge.ts:264`）：逐分类表跑 `bm25(<fts>)`（**无列权重**，`ORDER BY score LIMIT ?`），`fuzzy: true` 时再跑一路 trigram；两路结果按 `(kind, id)` 去重后按分数取 Top-N。**没有任何融合**——后跑的一路只补空位，先到者按裸 BM25 分数排；trigram 的分数与 porter 的 BM25 分数**量纲不同却混在同一排序里**（当前实际影响小，因为 trigram 只在 fuzzy 下追加，且分数会被排在后面）。
- **兜底**：结果不足 `limit` 且（查询含 CJK 或 FTS 语法错误）时走 `LIKE` 子串（`knowledge.ts:314`），分数记 0。CJK 短词（≤2 字符）只能靠这一路召回。
- **跨层**（`tiers.ts:223`）：逐库 `search` 后按层权重 U > P > S、同层按 `score` 升序（分数越小越相关）。
- **工具面**（`tools.ts:101`）：`memory_query` 参数只有 `action` / `query` / `kind` / `tier` / `project` / `limit` / `fuzzy` / `offset`，**没有策略开关**。
- **`node:sqlite` 实测**（`tmp` 探针，未纳入仓库）：`bm25(fts, 2.0, 1.0)` 列权重可用；trigram 表 `MATCH '"词干" OR "后缀"'` 可用；`LIKE ... ESCAPE '\'` 可用；FTS5 语法错误可被 `try/catch` 捕获。三路都能在**不改 schema、不加依赖**的前提下拿到。

结论：缺的是**策略层**——列权重、跨路融合与邻近信号；存储与索引层不用动。

## 决策

01. **策略字段**：`SearchMode = "bm25" | "hybrid"`，经 `SearchOptions.mode` 传入（`mode` 缺省 = `"bm25"`）。`"bm25"` 分支**逐行保留现有实现**（原 `search` 方法体原样搬进私有分支），保证缺省行为零回归；`"hybrid"` 走新的多路融合分支。
02. **BM25 列权重**：hybrid 的 porter 路用 `bm25(<fts>, 2.0, 1.0)`（`title` 权重 2、`content` 权重 1）。bm25 模式仍用无参 `bm25(<fts>)`。
03. **四路召回**（每张已建分类表，每路独立 `LIMIT` 候选池）：
    - `bm25`：porter 词干路（带列权重，按 BM25 升序）；
    - `trigram`：trigram 路，查询词按空白切分后取 ≥3 字符的词项，各自加引号（FTS5 phrase 字面量）以 `OR` 连接；hybrid 下**恒开**，不再依赖 `fuzzy`；
    - `like`：逐词项 `content LIKE %词% OR title LIKE %词%`（沿用 `likePattern` 转义），`ORDER BY c.id` 保证确定序；这是 CJK 短词的主力召回；
    - `proximity`：对 `like` 路的候选行做词项邻近计算（不再发 SQL）。命中词项数 ≥2 且这些词项共现于同一小窗口（跨度 ≤ `PROXIMITY_MAX_SPAN = 64` 字符）才进入该路，排序 = 覆盖词项数降序 → 最小窗口跨度升序 → id 升序。窗口阈值是「邻近」与「长文里恰好都出现」的分界。
04. **融合用 RRF，而不是分数相加**：各路的分数（BM25 / trigram BM25 / 常量 0 / 邻近跨度）量纲不可比，故只取**路内名次**——`fused` 为各路 `1 / (K + rank + 1)` 之和，`K = 60`。RRF 之外不做归一化，避免引入可调参数。
05. **`SearchHit.score` 语义不变**（越小越相关）：hybrid 下 `score = -fused`（负值）。这样 `TierSet.search` 的跨层排序（层权重优先、同层按分数升序）**一行不改**即可复用，`score < 0` 只表示「融合分高」。
06. **邻近窗口算法**：把 `title + "\n" + content` 小写化并截到 `PROXIMITY_SCAN_CHARS = 4000` 字符，收集各词项出现位置，用双指针求「覆盖文档内全部出现词项」的最小窗口；跨度 = 末位置减首位置。纯函数放 `src/hybrid.ts`，可单测。
07. **候选池与上限**：每路 `LIMIT poolSize`，`poolSize = clamp(max(limit * 4, 20), 20, 200)`；融合后截 `limit`。每表最多 3 条 SQL + 一次纯 JS 邻近计算，耗时与语料规模无关（不随行数线性增长），这是「延迟不劣化」的机制解释。
08. **参数暴露**：`memory_query` 增 `mode`（`enum: ["bm25", "hybrid"]`，缺省不变），非法值按缺省处理（与 `fuzzy` 同样的宽松读取）；全局面 `search` 与 `TierSet.search` 透传 `mode`。**`fuzzy` 在 hybrid 下不再改变召回**（trigram 恒开），保留参数只为向后兼容。
09. **无命中与截断语义不变**：hybrid 无候选返回 `[]`，工具渲染仍是 `(无命中)`；`truncated` 仍按「条数 ≥ limit」判定。
10. **不改范围**：schema、写入 / 分块 / 去重 / 巩固、隐私闸、TUI 侧调用（`/memory search` 不传 `mode` = 走旧分支）。本组边界裁定：只改 `memory-base/src`、`memory-base/tests` 与本追踪文档。

## 规划

### 计划改动文件清单

- `memory-base/src/hybrid.ts`（新增）：策略常量、词项切分、trigram 查询构造、邻近窗口、RRF 融合（纯函数）。
- `memory-base/src/knowledge.ts`：`SearchMode` / `SearchOptions.mode`；`search` 分流到 `#searchBm25`（原实现）与 `#searchHybrid`。
- `memory-base/src/tiers.ts`：`TierSet.search` 透传 `mode`。
- `memory-base/src/index.ts`：全局面 `search` 透传 `mode`，导出类型。
- `memory-base/src/tools.ts`：`memory_query` 的 `mode` 参数、执行面透传、描述补充。
- `memory-base/tests/hybrid-search.test.ts`（新增）：纯函数单测、固定查询 + 期望命中序夹具、缺省不回归对比、无命中、工具透传、延迟对比证据。
- 不改：`memory-base/README.md`、`memory-base/docs/DESIGN.md`、两级 `BACKLOG`、TUI 任何文件（按组任务边界，收尾与文档同步不在本次范围）。

### 验收

- 旧模式不回归：同一查询下 `mode` 缺省与 `mode: "bm25"` 的结果（含 `score`）逐字段相等；现有 61 例全过。
- 混合模式可复现：固定语料 + 固定查询，命中序与期望一致（列权重、邻近、RRF 各有一条断言）。
- 无命中行为不变；`limit` / `truncated` 语义不变。
- 延迟不劣化：200 行语料上 hybrid 单查询耗时低于约定阈值（300 ms），并在用例里输出两策略实测耗时。
