# @dsh-toolset/knowledge-base

DSH（DeepSeek Harness）进程内集成插件：跨会话知识库与持久记忆。

- 范围：`docs/DEVELOPMENT-BACKLOG.md` #8-#10（BACKLOG #8 跨会话知识库、#9 写回/淘汰/提升、#10 持久记忆 CRUD）。
- 任务安排：`TASKS.md`；设计对照 `docs/AGENT-ARCHITECTURE-ANALOGY.md` §12。
- 实现契约：`DSH-CTX-API.md`（跨插件共享研读笔记，只读）；当前对齐版本 0.1.5-rc.2。

## 命令

```sh
npm run check   # 类型检查（tsc --noEmit）
npm run build   # 编译到 dist/
npm run test    # 运行 tests/*.test.ts（node --test，37 项）
npm run demo    # 运行 mock demo（无 DSH 依赖）
npm run smoke   # 宿主联调：profile 引导 + 真实 dsh 会话摄取断言 + dist 往返（约 1-2 分钟）
```

## 结构

- `src/schema.ts` — 四表结构（sources/chunks）+ 双 FTS5 影子表 + TRIGGER 写直达
- `src/knowledge.ts` — `ctx_knowledge` 四接口（search/put/touch/evict）
- `src/hooks.ts` — session/event 数据源接入（白名单过滤 + 摘要化；0.1.5-rc.2：`[tool/meta]`、`[compaction]` 尾注）
- `src/writepolicy.ts` — 两级写策略、LRU+importance 淘汰、resume top-K 提升
- `src/memory.ts` — 持久记忆 CRUD 与过滤检索
- `demo/main.ts` — mock demo（无 DSH 宿主依赖）
- `smoke/smoke.mjs` — 宿主联调 smoke（自动化验收门）

## 宿主联调（smoke）

`npm run smoke` 全自动化（约 1-2 分钟，需本机可用 dsh 0.1.5-rc.2 与模型凭据）：

1. 幂等引导独立 profile `dsh-toolset-kb`（headless 模板；`dsh plugin add` 以 `link:` 挂载本包；
   用户层 `cordis.patch.yml` 配置 dbPath——`KNOWLEDGE_DB_PATH` 环境变量可重定向，
   缺省 `~/.dsh/knowledge-base/knowledge.db`）；
1. 缺 `dist/` 自动构建；
1. 真实 dsh headless 一次性会话：`--patch` 低压缩阈值 overlay 强制触发 compaction，
   任务强制 fs write 产生真实 `tool/result.meta`，`KNOWLEDGE_DB_PATH` 重定向临时目录；
1. SQLite 断言：`ctx_knowledge` 注册指纹（application_id/user_version）+ 新字段摄取
   （`[tool/meta]`、`shadowedRange`）；真实载荷缺失时经 dist hooks 合成事件兜底；
1. dist 产物 put/search/touch/evict 往返（EN 词干 + CJK LIKE）。

profile 属机器级配置（`~/.dsh/profiles/`），不入库；smoke 会幂等重建/刷新其用户层配置。

## 状态

> 状态：核心三件（#8 知识库查询 / #9 两级写策略 / #10 持久记忆）已实现并合入 main；接口对齐
> DSH-CTX-API 0.1.5-rc.2（`tool/result.meta`、`compaction/summary` 新字段、`ignorable` 安全跳过、
> `SessionSeq`/`SessionLogOffset` N/A）；宿主联调完成（profile `dsh-toolset-kb` + `npm run smoke` 全链路
> PASS）。37/37 测试通过，`check/build/demo/smoke` 退出 0。收尾门：真实会话中人工使用
> put/search 的最终确认（不阻塞验收）。
