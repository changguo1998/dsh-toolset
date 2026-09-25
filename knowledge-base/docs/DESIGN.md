# knowledge-base 设计

## 1. 定位与取舍

DSH 进程内集成的**跨会话知识库 + 持久记忆**。三个取舍：

- **独立 SQLite 库（`node:sqlite` 内置）而非宿主 storage KV**：知识库是搜索密集型负载（关键词/子串/打分排序/过期淘汰），关系库 + FTS5 比 KV 域更贴合；用内置模块意味着零新增依赖。
- **双 FTS5 索引而非单一分词器**：语义词干检索（porter）与子串/模糊检索（trigram）语义不同，各自建索引、各自 `bm25()` 排序，查询时按需合流。
- **记忆与知识同库**：记忆是 `chunks` 表上 `target` 划域的记录（`category` 表类别），复用同一套分块、去重、检索、淘汰底座，避免第二套存储语义。

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
- 默认 `journal_mode = wal`（可配），允许知识库长连接与其他写入者（如 output-compress）并发读写。

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

## 7. 已知边界

- CJK 检索需经 `LIKE` 兜底（分词器限制，非实现缺陷）；`fuzzy:false` 不额外召回模糊结果。
- `pending` 为内存态，进程重启丢失；`ConsolidationLock` 不跨进程。
- token 估算为 `len/3` 近似，未引入精确 tokenizer。
- `SessionSeq`/`SessionLogOffset` 不消费：去重键是 `content_hash`，`session_id` 仅作溯源列，不参与唯一性。
