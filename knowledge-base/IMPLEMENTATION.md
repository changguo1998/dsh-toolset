# knowledge-base 实现记录

> 与 `DESIGN.md`（设计决策）配套；本文件记录文件职责、运行/验证方式与阶段演进。

## 1. 文件职责

| 路径 | 职责 |
|---|---|
| `src/schema.ts` | 四表 + 双 FTS5 影子表 + TRIGGER 写直达 + open 守护（application_id/user_version） |
| `src/knowledge.ts` | `ctx_knowledge` 四接口：search/put/touch/evict + 分块/去重/联动 + promote/compress/staleCandidates/tokenBudgetUsage（#9 查询） |
| `src/hooks.ts` | session/event 写直达：白名单过滤、事件摘要化、SessionHooks 挂接 |
| `src/writepolicy.ts` | #9 编排：批量写回 + consolidation 锁 + backfill + evictStale |
| `src/memory.ts` | #10 记忆 CRUD + target/category/project 过滤 + token-aware 截断 |
| `src/index.ts` | DSH bundle 接入面：createKnowledgeBundle 工厂 + apply |
| `demo/main.ts` | mock demo（无 DSH 依赖，人工确认用） |
| `tests/*.test.ts` | 31 项 node:test 单测 |
| `cordis.patch.yml` | dsh bundle 插件声明 |

## 2. 运行与验证

```sh
npm run check   # tsc --noEmit（类型/严格检查）
npm run test    # node --experimental-transform-types --test（31 项）
npm run build   # 编译到 dist/
npm run demo    # mock demo，退出码 0 视为流程通过
```

验证契约机械项（单命令、以仓库根目录为工作目录，不含管道/重定向/逻辑连接）：

```
npm --prefix knowledge-base run check
npm --prefix knowledge-base run test
npm --prefix knowledge-base run build
npm --prefix knowledge-base run demo
grep -c "CREATE VIRTUAL TABLE chunks_fts" knowledge-base/src/schema.ts
grep -c "CREATE VIRTUAL TABLE chunks_trigram_fts" knowledge-base/src/schema.ts
git log --oneline -- knowledge-base
```

## 3. 测试覆盖（schema 3 + knowledge 8 + hooks 6 + writepolicy 8 + memory 6 = 31）

- `schema.test.ts`（3）：insert/update/delete 双 FTS 索引一致、索引建立、文件库幂等 reopen；
- `knowledge.test.ts`（8）：put/search 词干命中、命中更新 last_referenced、去重、touch、
  evict source 联动、分块、project/target/category 过滤、trigram 子串召回；
- `hooks.test.ts`（6）：extractText、summarizeEvent（失败/成功 importance）、白名单过滤、
  重复事件去重、detach、project 按事件求值；
- `writepolicy.test.ts`（8）：writeBack、writeBack+backfill 失败兜底、锁串行化、
  staleCandidates 阈值、compress、promote 排序、evictStale、tokenBudgetUsage；
- `memory.test.ts`（6）：add 去重、target/category/project 过滤、replace、remove 联动清理、
  token-aware 截断、命中提升 last_referenced。

## 4. 阶段演进（小阶段分开提交）

1. `feat(knowledge-base): 脚手架包结构` — package.json/tsconfig/cordis.patch.yml/index/demo/README；
1. `feat(knowledge-base): schema 四表双 FTS5` — 表/影子表/TRIGGER/open 守护 + 测试；
1. `feat(knowledge-base): ctx_knowledge 四接口` — search/put/touch/evict + 分块/去重 + 测试；
1. `feat(knowledge-base): session/event 事件 hooks 数据源接入` — 白名单过滤器 + 摘要化 + 测试；
1. `feat(knowledge-base): #9 两级写策略与淘汰提升` — 批量写回/锁/backfill、LRU 淘汰、top-K 提升 + 测试；
1. `feat(knowledge-base): #10 持久记忆 CRUD 与过滤检索` — 记忆 CURD + token-aware + 测试；
1. `docs(knowledge-base): demo 与设计文档` — mock demo + DESIGN/IMPLEMENTATION + TASKS 勾选。
1. `docs(knowledge-base): 修正 IMPLEMENTATION 测试覆盖计数与验证契约形` — 订正 §3 计数（schema3/knowledge8/hooks6/writepolicy8/memory6=31）与 §2 契约改为根目录可执行版。

## 5. 进度状态（2026-09-10 验收）

- 功能实现完成：8 条提交（见 §4）；`npm run check/test/build/demo` 全部退出 0，node:test 31/31 通过，demo 输出 `demo OK`；
- glla 验收目标经独立审计通过（auditor approved，存档 `.pi-glla/archive/20260910132849-yaf437.md`）；
- 验证契约采用根目录可执行单命令版（见 §2），与自动化审计在仓库根执行命令保持一致。

## 6. 待人工确认

- mock demo 已确认（`npm run demo` 输出检索/记忆/写回示例与 `demo OK`，退出码 0）；
- （未完成）真实 DSH profile 挂载（`dsh.bundle` + `cordis.patch.yml`）联调：`ctx_knowledge` 服务注册到宿主、session/event 事件接入实跑；本机暂无 dsh profile，待有环境后执行。
