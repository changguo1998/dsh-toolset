# knowledge-base 设计与实现

> 实现范围：`docs/DEVELOPMENT-BACKLOG.md` #8-#10（跨会话知识库、写回/淘汰/提升、持久记忆 CRUD）。
> 设计对照：`docs/AGENT-ARCHITECTURE-ANALOGY.md` §12；接口契约：根目录 `DSH-CTX-API.md`。
> 语言：本文档中文；代码英文标识符。

## 1. 定位

DSH 进程内集成的**跨会话知识库**插件，独立于 storage KV 域，搜索密集走 SQLite FTS5。
与 task-engine 零依赖，可并行开发（BACKLOG 定位）。

- 独立 SQLite 库（`node:sqlite` 内置，零新增依赖，与 `storage-sqlite`/`session-query-sqlite` 同底座）；
- 接口 `ctx_knowledge: search / put / touch / evict`；
- 复用底座：storage-sqlite、session-query-sqlite（FTS5 底座模式）、session-telemetry（事件源）。

## 2. 存储结构（§12.1）

四表 + 双 FTS5 影子表（`src/schema.ts`）：

| 表 | 关键列 | 职责 |
|---|---|---|
| sources | kind(session/file/url/tool_result/manual)、label、ref、content_hash、chunk_count | 溯源/去重/记账 |
| chunks | source_id、project、target、category、title、content、content_hash、importance(1-5)、session_id、last_referenced、summary | 内容主体（过滤/排序/淘汰） |
| chunks_fts | title、content（porter 分词） | 语义词干 BM25 检索 |
| chunks_trigram_fts | title、content（trigram 分词） | 子串/模糊检索 |

索引：`(project, last_referenced)`、`(source_id)`。
双 FTS5 以 `content='chunks'` external content 挂靠（免双份存储），TRIGGER 在 insert/update/delete
写直达同步（update = delete 旧行 + insert 新行）。

**open 守护**（仿 session-query-sqlite）：`PRAGMA application_id`（'KNOW'）+ `user_version` 版本守护；
0o600 建库、父目录 0o700、journal_mode 默认 WAL；版本不匹配整库重置后重建。

## 3. ctx_knowledge 四接口（`src/knowledge.ts`）

`KnowledgeService` 持有 `DatabaseSync`，方法即四接口：

- `put(input)`：content_hash 去重（相同块不重复写）、~2K token markdown 边界分块
  （超限段落按行/字节硬切）、source 记账（chunk_count 按实际新增数计数）；
- `search(opts)`：porter BM25（`bm25()` 排序），`fuzzy` 时叠加 trigram 子串召回；
  命中即更新 `last_referenced`（检索命中提升 §12.4）；支持 project/target/category 过滤；
- `touch(id)`：手动刷新 `last_referenced`（LRU 参考计数）；
- `evict(ids)`：删除 chunks 并联动 `sources.chunk_count`，归零清理 source（§12.3 溯源联动，供 #9 复用）。

检索健壮性：FTS5 对自由输入语法错误（如 `-` 排除符）try/catch 容错；含 CJK 的查询在
porter/trigram ≤2 字符无法召回时走 LIKE 子串兜底（保持 `fuzzy:false` 不额外召回语义）。

**CJK 检索边界（实测）**：porter（unicode61）按连续串分词，`构建通过` ≠ 查询 `构建`；
trigram 需 ≥3 字符子串。≤2 字符中文词须经 LIKE 兜底命中。已知边界，测试有覆盖。

## 4. 数据源接入（`src/hooks.ts`）

`SessionHooks` 订阅宿主 `session/event`（结构化 `HookHost`，mock/demo 可跑）：

- 写直达事件过滤器白名单（§12.2）：`tool/result`、`feedback/record`、`plan/mode`、
  `goal/change`、`todo/write`、`approval/decided`、`compaction/summary`；
- `summarizeEvent`：`tool/result` 失败（isError/error）importance=4、成功=2，其余类型 3；
  递归抽取文本（string / `{text}` / `{content}` / `{message.content}`）；
- 重复事件经 content_hash 去重；`attach` 返回解绑函数。
- project 作用域：静态字符串或按事件求值函数（多项目路由）。

## 5. 两级写策略与淘汰提升（`src/writepolicy.ts`，#9）

- **写直达**（实时，会话内）：hooks 事件过滤器（见上）；
- **批量写回**：`WritePolicy.writeBack` 在 `ConsolidationLock`（进程内互斥，同 key 串行化）内批量
  `put`；失败项入 pending，`backfill()` 下次启动/compaction 重试兜底（最终一致）；
- **淘汰**：`evictStale` 取候选（`last_referenced` 早于 TTL 且 importance≤2），先 `compress` 降级为
  单行摘要（保留可检索足迹），再硬淘汰（`kb.evict` 联动 source 清理）；
  触发条件：project 级 token 超预算（`tokenBudgetUsage` 估算）或定期；
- **提升**：`kb.promote` resume top-K（`last_referenced` 倒序 × importance 加权）注入上下文；
  检索命中更新 last_referenced（search 内联）；回填按 relevance × importance。

## 6. 持久记忆（`src/memory.ts`，#10）

记忆沉淀在 chunks 表（`target`=记忆域，`category`=类别），复用 knowledge 底座：

- `add`：content_hash 去重；无 project 归 `__global__`；
- `replace` / `remove`：按 `target` + 内容子串定位（LIKE 转义）；
- `search`：target/category/project 过滤 + **token-aware 预算截断**（返回 usedTokens/truncated）；
- 检索命中自动更新 last_referenced（提升）。

## 7. DSH 接入面（`src/index.ts`）

按 bundle 契约 `export { name, apply }`；`@deepseek-ai/cordis` 未发布到 npm，ctx 用结构化
`BundleHost`（`session/event` + `logger`）。`createKnowledgeBundle` 为核心工厂（开库→建服务→挂事件→
dispose），`apply` 为宿主挂载入口；`cordis.patch.yml` 声明 bundle 插入。

**真实宿主联调**（dsh profile 部署、`ctx_knowledge` 服务注册到宿主 service 域）留待部署时人工确认。

## 8. 约束与已知边界

- 检索词干/子串对 ≤2 字符中文走 LIKE 兜底（见 §3）；
- ConsolidationLock 为进程内互斥，多进程共享库需升级文件锁（ponytail 标注）；
- pending 写回为内存态，进程重启丢失（ponytail 标注，升级为持久队列时处理）；
- token 估算 `len/3` 为近似（ponytail 标注，精确 tokenizer 需要时引入）。
