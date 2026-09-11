# knowledge-base 实现记录

> 与 `DESIGN.md`（设计决策）配套；本文件记录文件职责、运行/验证方式与宿主接口对齐。

## 1. 文件职责

| 路径 | 职责 |
|---|---|
| `src/schema.ts` | 四表 + 双 FTS5 影子表 + TRIGGER 写直达 + open 守护（application_id/user_version） |
| `src/knowledge.ts` | `ctx_knowledge` 四接口：search/put/touch/evict + 分块/去重/联动 + promote/compress/staleCandidates/tokenBudgetUsage |
| `src/hooks.ts` | session/event 写直达：白名单过滤、事件摘要化（tool/result meta、compaction 尾注）、SessionHooks 挂接 |
| `src/writepolicy.ts` | 写回编排：批量写回 + consolidation 锁 + backfill + evictStale |
| `src/memory.ts` | 记忆 CRUD + target/category/project 过滤 + token-aware 截断 |
| `src/index.ts` | DSH bundle 接入面：createKnowledgeBundle 工厂 + apply |
| `demo/main.ts` | mock demo（无 DSH 依赖，人工确认用） |
| `smoke/smoke.mjs` | 宿主联调 smoke（profile 引导 + 真实会话摄取断言 + dist 往返） |
| `tests/*.test.ts` | node:test 单测 |
| `cordis.patch.yml` | dsh bundle 插件声明 |

## 2. 运行与验证

```sh
npm run check   # tsc --noEmit（类型/严格检查）
npm run test    # node --experimental-transform-types --test（37 项）
npm run build   # 编译到 dist/
npm run demo    # mock demo，退出码 0 视为流程通过
npm run smoke   # 宿主联调：真实 dsh headless 会话 + 摄取断言 + dist 往返（约 1-2 分钟）
```

验证契约机械项（单命令、以仓库根目录为工作目录，不含管道/重定向/逻辑连接）：

```
dsh --version
npm --prefix knowledge-base run check
npm --prefix knowledge-base run test
npm --prefix knowledge-base run build
npm --prefix knowledge-base run smoke
grep -c "shadowedRange" knowledge-base/src/hooks.ts
grep -c "sourceCommandId" knowledge-base/src/hooks.ts
git log --oneline -- knowledge-base
```

## 3. 测试覆盖（schema 3 + knowledge 8 + hooks 12 + writepolicy 8 + memory 6 = 37）

- `schema.test.ts`（3）：insert/update/delete 双 FTS 索引一致、索引建立、文件库幂等 reopen；
- `knowledge.test.ts`（8）：put/search 词干命中、命中更新 last_referenced、去重、touch、
  evict source 联动、分块、project/target/category 过滤、trigram 子串召回；
- `hooks.test.ts`（12）：extractText、summarizeEvent（失败/成功 importance）、白名单过滤、
  重复事件去重、detach、project 按事件求值、serializeToolMeta 序列化、compaction 摘要
  （新字段尾注/旧载荷回落/summary 缺失整体 JSON）、ignorable 安全跳过、
  e2e compaction 新字段摄取、e2e tool/result meta 摄取；
- `writepolicy.test.ts`（8）：writeBack、writeBack+backfill 失败兜底、锁串行化、
  staleCandidates 阈值、compress、promote 排序、evictStale、tokenBudgetUsage；
- `memory.test.ts`（6）：add 去重、target/category/project 过滤、replace、remove 联动清理、
  token-aware 截断、命中提升 last_referenced。

## 4. 宿主接口对齐（0.1.5-rc.2）

| 项 | 0.1.5-rc.2 契约 | 插件处理 |
|---|---|---|
| `tool/result` | `data.meta` 新增（FsDiffMeta 等结构化 diff 元数据，fs 工具产生） | `serializeToolMeta` 非空时在 chunk 尾部追加 `[tool/meta]\n<compact JSON>`；`{}`/`[]`/null 不追加 |
| `compaction/summary` | `data` 含 `shadowedRange:{start,end}`、`shadowedSeqs`、`shadowedTokenCount`、`provider`、`model`；`sourceCommandId` 仅命令触发压缩时出现 | 摘要文本后追加 `[compaction]` 尾注块（逐字段 `key: <json>`）；无 summary 文本时回落整体 JSON 不丢数据；宿主缺字段时仅输出存在的字段（向后兼容） |
| `SessionEvent.ignorable` | 可选安全标记（宿主「可丢弃」语义） | 白名单类型仍摄取（保守，不丢数据）；非白名单类型本就安全跳过 |
| `SessionSeq`/`SessionLogOffset` | — | **N/A**：插件以 content_hash 全局去重，seq/log offset 不消费；session_id 仅作簿记，不参与唯一性（DESIGN.md §8 已论证） |

实测真实载荷（0.1.5-rc.2 会话 JSONL）：`tool/result.data.meta = { diffs: [...] }`；
`compaction/summary.data` 含 `shadowedRange:{start:8,end:10}`、`shadowedTokenCount:523`、
`provider:"ustc"`、`model:"deepseek-v4-flash"`；auto-compact 无 `sourceCommandId`（命令触发才有，
由合成路径单测覆盖）。

## 5. 宿主联调（smoke）

- 独立 profile `dsh-toolset-kb`（headless 模板，~/.dsh/profiles/dsh-toolset-kb，机器级、不入库）：
  `dsh plugin add "@dsh-toolset/knowledge-base@link:<worktree>/knowledge-base"` 挂载；
  profile 用户层 `cordis.patch.yml` 配置 `dbPath`（`KNOWLEDGE_DB_PATH` 环境变量可重定向，
  缺省 `~/.dsh/knowledge-base/knowledge.db`）与 `project: 'dsh-toolset-kb'`。
- `npm run smoke`（`smoke/smoke.mjs`）自动化断言链：
  0\. `dsh --version` 要求 0.1.5-rc.2；
  1. profile 幂等引导（缺则 headless 模板创建 + link: 挂载 + 写用户层配置）；
  1. 缺 `dist/` 自动 `npm run build`；
  1. 真实 dsh headless 一次性会话：`--patch` 低压缩阈值 overlay（thresholdRatio 0.001 /
     retainRatio 0.0004，宿主校验 retainRatio < thresholdRatio）+ 任务强制 fs write（真实 meta）+
     `DSH_PERMISSION_MODE=danger-full-access` + `KNOWLEDGE_DB_PATH` 重定向临时目录；
  1. SQLite 断言：注册指纹（application_id=0x4b4e4f57、user_version=1）+ `[tool/meta]` +
     `shadowedRange` 摄取行；
  1. 真实载荷缺失时经 dist hooks 注入合成事件兜底（含 sourceCommandId 路径）；
  1. dist 产物 put/search(EN 词干 + CJK LIKE)/touch/evict 往返（同一文件库）。
     成功删临时目录；失败保留并打印路径。
- 实测结果：smoke 全链路 PASS（注册指纹 OK、meta 真实摄取、compaction 字段摄取、往返全通过）。
  注册判定口径：真实会话后知识库文件由 bundle apply 创建且 schema 指纹匹配（确定性证据，
  不依赖宿主 logger 输出）。

## 6. 人工确认口径

- mock demo 已确认（`demo OK`）。
- 真实 profile 挂载与 `ctx_knowledge` 注册已由 smoke 自动化覆盖（§5）；真实会话中人工使用
  put/search 的最终确认作为收尾门，不阻塞验收。
