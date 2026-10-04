# knowledge-base 设计

## 1. 定位与取舍

DSH 进程内集成的**跨会话知识库 + 持久记忆**。三个取舍：

- **独立 SQLite 库（`node:sqlite` 内置）而非宿主 storage KV**：知识库是搜索密集型负载（关键词/子串/打分排序/过期淘汰），关系库 + FTS5 比 KV 域更贴合；用内置模块意味着零新增依赖。
- **双 FTS5 索引而非单一分词器**：语义词干检索（porter）与子串/模糊检索（trigram）语义不同，各自建索引、各自 `bm25()` 排序，查询时按需合流。
- **记忆与知识同库**：记忆是 `chunks` 表上 `target` 划域的记录（`category` 表类别），复用同一套分块、去重、检索、淘汰底座，避免第二套存储语义。
- **与相邻组件的边界**：会话历史的**原始事件**检索归官方 `session-query-sqlite`（`ctx.sessionQuery`），本库只存「已沉淀」的知识 / 记忆；`output-compress` 以「同一 SQLite 文件」为唯一共享面直写 `sources`/`chunks`，本包与它不建立代码或服务依赖（见 §9 共库直写口径）。

对外接口面与配置见 `README.md`。

## 2. 数据模型（`src/schema.ts`）

2 张基表（`STRICT`）+ 2 张 FTS5 虚表：

| 表 | 关键列 | 职责 |
| --- | --- | --- |
| `sources` | `kind`、`label`、`ref`、`content_hash`、`chunk_count` | 溯源与记账（一个来源 → 多个 chunk） |
| `chunks` | `source_id`、`project`、`target`、`category`、`title`、`content`、`content_hash`、`importance`(CHECK 1..5)、`session_id`、`last_referenced`、`summary` | 内容主体 |
| `chunks_fts` | `title`、`content`，`tokenize='porter'` | 语义词干 BM25 检索 |
| `chunks_trigram_fts` | 同上，`tokenize='trigram'` | 子串 / 模糊检索 |

- 两张 FTS 表都以 `content='chunks'` external content 挂靠（不双份存原文），由 3 个 TRIGGER（insert / delete / update）写直达同步；update 实现为「旧行 delete + 新行 insert」，保证两个索引都一致。
- 索引两条：`(project, last_referenced)` 服务按项目取过期候选与提升排序，`(source_id)` 服务 source 联动。
- **open 守护**：库文件 0o600、父目录 0o700；`PRAGMA application_id = 0x4b4e4f57`（`'KNOW'`）、`user_version = 1`。application_id 属于其他应用、或为空但库非空时拒绝打开；版本不匹配时整库重置（DROP 后重建），避免半旧 schema 带着不兼容数据继续跑。
- 默认 `journal_mode = wal`（可配），允许知识库长连接与其他写入者（如 output-compress）并发读写；直写方的写入不受本包入库规则约束（见 §9 共库直写边界）。

## 3. 写入策略（两级）

- **写直达（会话内实时）**：`src/hooks.ts` 订阅 `session/event`，只对白名单事件类型（工具结果、用户反馈、计划/目标/待办决策、审批结论、压缩摘要）实时 `put`；过滤先于写入，非白名单类型直接跳过，不产生半写。
- **批量写回（最终一致）**：`WritePolicy.writeBack` 在 `ConsolidationLock` 内批量 `put`；单条失败不抛错，而是进内存 `pending` 队列，`backfill()` 重试。取舍：知识沉淀的可用性优先于强一致——写入失败不应反过来打断会话。
- **锁的边界**：`ConsolidationLock` 是进程内互斥（同 key 串行化），多进程共享同一库时需升级为文件锁。

## 4. 检索算法（`src/knowledge.ts`）

1. **分块**（写入侧）：按 markdown 段落边界累加到 ≤ 2000 token（估算 `len/3` ≈ 6000 字符）；单段落超限时按行边界硬切（找不到合适换行则按字符硬切）；分块后 trim 并丢弃空块。
1. **去重**：chunk 级 `content_hash`（sha256）全局去重，命中即复用既有 id、`created` 不增；`sources` 按 `(content_hash, kind)` 复用。取舍：跨 project 复用同内容是刻意的——同一份事实不必因作用域不同存两遍，代价是「同内容不同 project」不会各自成条。
1. **召回链**：`chunks_fts` 用 `MATCH` + `bm25()` 升序取 `limit` 条；`fuzzy` 时叠加 `chunks_trigram_fts` 结果补足（不覆盖 porter 命中）；两者都失败或结果不足且查询含 CJK 时，退到 `LIKE` 子串扫描兜底。
1. **命中即提升**：`search` 命中的行把 `last_referenced` 刷成当前时间，作为 LRU/提升的参考计数——检索本身就是「这条仍然有用」的证据。

取舍说明：FTS5 对自由输入（如 `-` 这类查询语法字符）会直接报错，故每次 `MATCH` 都包 try/catch 并降级；CJK 词干/子串命中能力有限（见 `README.md` 边界），`LIKE` 兜底牺牲排序质量换取召回。

## 5. 淘汰与提升

- **淘汰候选** `staleCandidates`：`last_referenced > 0` 且早于 `now - ttlMs`，且 `importance <= maxImportance`（默认 2），按 `last_referenced` 升序取前 `limit` 条。`last_referenced = 0`（从未被检索）不参与，避免误杀刚写入的条目。
- **降级再淘汰** `evictStale`：默认先 `compress` 把 `content`/`summary` 降级为首行截断 300 字符（保留可检索足迹），再 `evict` 硬删（联动 `sources.chunk_count`，归零清理 source）。取舍：一步硬删会让「曾经知道过什么」彻底消失，压缩降级保留了索引可寻的回指。
- **提升** `promote`：按 `importance × 1/(1 + 距今小时数/24)` 排序取 top-K（默认 10），只取 `last_referenced > 0` 的条目；分数相同时按 `last_referenced` 倒序。取舍：用重要性加时间衰减表达「重要且近期用过」，比单纯 LRU 更稳。

这些编排都是显式接口，**本插件内没有调度器**（谁在何时触发由宿主/上层决定）。

## 6. 持久记忆

记忆复用 `chunks` 表：`target` 划域（`user`/`memory`/`project`/`failure`），`category` 记类别，无 project 时归 `__global__`。

- `replace` / `remove` 用 `target` + 内容子串（`content`/`summary` 的 `LIKE`，转义 `\`、`%`、`_`）定位，因此同一域内**首个**匹配项被改动。
- `search` 在过滤之上做 token-aware 截断：逐条累加估算 token，若追加下一条会超 `tokenBudget` 且已有至少一条命中则停止，返回 `usedTokens` 与 `truncated`——把「预算」这件事从调用方挪进服务内。

## 7. 入库规则与容量边界（2026-10-02）

- **规则三段**（`src/rules.ts`）：类型（沿用 `persistTypes` 语义，`null` = 不过滤）→ 最小长度（`minChars`）→ 拒绝模式（内置隐私 + `denyPatterns` 追加）。三段都在**摘要化之后、`put` 之前**判定，保持「过滤先于写入、不半写」。
- **隐私边界用形态匹配、整条拒绝**：PEM 私钥 / `sk-` / GitHub / AWS / `Bearer` / `key = value` 六类内置模式；命中即整条不入库（不打码）——半脱敏的内容写进库等于没防，宁可丢不可泄。非法自定义正则只 warning（沿用本包「不崩」口径）。
- **容量守卫**（`src/budget.ts`）：由 `maxTokensPerProject` 触发，顺序是**先压缩降级、再小步硬淘汰**；候选顺序固定「低重要度 → 最旧」（`budgetCandidates`）。与 `staleCandidates` 的口径区分：后者筛「已陈旧」（TTL + 重要度上限），前者只给牺牲顺序、不设门槛。每轮最多 10 条（`EVICT_STEP`）且累计不超过 `batch`——避免一次删掉整片内容。
- **可观测**：`SessionHooks.handle()` 返回单条结果（`accepted` / `reason` / `deduped` / `budget`），`stats` 累计计数。取舍：自动类功能没有计数就无法排查「这条为什么没进库」。

## 8. 自动巩固（2026-10-02）

`ConsolidationService`（`src/consolidate.ts`）= 三段机械策略的编排，`plan()` 与 `run()` 共用同一判据（前者只读、零副作用）：

1. **提升**：`boostCandidates` 取「被检索命中过（`last_referenced > created_at`）且 `importance < 5`」的条目 +1 —— 「高频」用 `search` 会刷新 `last_referenced` 作机械代理（README 已述该副作用）。
1. **合并**：同 `target` 分组，归一化（压空白 + 小写）后「完全相同」或「短者是长者子串且长度占比 ≥ 0.8」→ 保留排序靠前者（importance → 最近引用 → id 小），删除其余。
1. **淘汰**：`staleCandidates`（TTL + 重要度上限）先 `compress` 再 `evict`，随后按 `maxTokens` 走容量守卫。

**触发**在入口（`src/index.ts`）：启动后一次 + `compaction/end`（或 `compaction/summary`）后一次，进程内 `minIntervalMs`（缺省 10 min）节流；`project` 配成函数时自动巩固不启用（没有稳定作用域可巩固）。取舍：知识库天然在 compaction 后进入低谷，是巩固的低廉时机；不做跨进程调度（无守护进程 / 定时器），需要时由宿主或上层显式 `consolidate.run()`。

## 9. 已知边界

- CJK 检索需经 `LIKE` 兜底（分词器限制，非实现缺陷）；`fuzzy:false` 不额外召回模糊结果。
- `pending` 为内存态，进程重启丢失；`ConsolidationLock` 不跨进程。
- token 估算为 `len/3` 近似，未引入精确 tokenizer。
- `SessionSeq`/`SessionLogOffset` 不消费：去重键是 `content_hash`，`session_id` 仅作溯源列，不参与唯一性。
- **共库直写边界**：`output-compress` 直写同一库时绕过本包的三道闸——入库规则（隐私拒绝模式 / `minChars`）、容量守卫（`maxTokensPerProject`）与 `hooks.stats` 计数；反向地，本包的 `staleCandidates` / `budgetCandidates` / 自动巩固按 `chunks` 全表筛选，同样会作用到它写入的行（其 importance 取 4/2、`last_referenced` 为写入时刻，TTL 到期后会先压缩再硬淘汰）。口径与 `output-compress/README.md` 的「边界与限制」一致。
- **与 `session-query-sqlite` 不共用索引**：会话日志检索（原始事件）与本库检索（沉淀知识）各自独立，`search` 不跨库合并结果。
