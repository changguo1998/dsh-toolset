# @dsh-toolset/knowledge-base

DSH（DeepSeek Harness）进程内插件：跨会话知识库与持久记忆——独立 SQLite（`node:sqlite`）库 + FTS5 双索引，搜索密集操作不经过宿主 storage KV 域。

## 能力

本插件**不注册模型侧工具**：订阅宿主 `session/event` 做实时沉淀，并把知识库以服务形态挂在进程内（`provide('knowledge')`，暴露 `getSummary()` 与 `whenReady()`）。可用接口分三组：

**知识库**（`bundle.kb`，`KnowledgeService`）：

| 接口 | 参数要点 | 返回 |
| --- | --- | --- |
| `put(input)` | `project`、`content` 必填；`title`/`target`/`category`/`sessionId`；`importance` 默认 3（clamp 1..5）；`source.kind` 默认 `manual` | `{ids, sourceId, created}` |
| `search(opts)` | `query` 必填；`project`/`target`/`category` 过滤；`limit` 默认 10（clamp 1..100）；`fuzzy` 默认 false | `SearchHit[]`，命中即刷新 `last_referenced` |
| `touch(id)` / `evict(ids)` | — | `boolean` / 删除条数（联动 `sources.chunk_count`） |
| 淘汰与提升辅助 | `staleCandidates({project, ttlMs, maxImportance=2, limit=100})`、`compress(ids)`、`tokenBudgetUsage(project)`、`promote({project, limit=10})` | 过期候选 id / 压缩条数 / 估算 token 数 / `SearchHit[]`（按 `importance × 时间衰减` 排序） |

**持久记忆**（`bundle.memory`，`MemoryService`，与知识同库）：`add({target, content, ...})`（`target` 取 `user`/`memory`/`project`/`failure`，`project` 默认 `__global__`，`importance` 默认 3）、`replace`、`remove`（均按 `target` + 内容子串定位）、`search(opts)`（`limit` 默认 20，支持 `tokenBudget`；返回 `{hits, usedTokens, truncated}`）。

**写策略**（`bundle.policy`，`WritePolicy`）：`writeBack(items)`（锁内批量写，失败项入内存 pending）、`backfill()`（重试 pending）、`pendingCount`、`evictStale({project, ttlMs, ..., compressFirst})`（默认先压缩降级再硬淘汰）。

写直达的默认事件白名单：`tool/result`、`feedback/record`、`plan/mode`、`goal/change`、`todo/write`、`approval/decided`、`compaction/summary`。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dbPath` | `KNOWLEDGE_DB_PATH` → `:memory:` | 库路径；`:memory:` 表示不落盘 |
| `journalMode` | `"wal"` | `wal` / `delete` / `truncate` / `persist` |
| `project` | `"default"` | 写直达事件的项目作用域（字符串或按事件求值函数） |
| `persistTypes` | 内置白名单 | 替换白名单；传 `null` 表示不过滤 |

淘汰、提升、截断的阈值都不是配置项，而是各接口的调用参数。

## 使用示例

```ts
import { createKnowledgeBundle } from "@dsh-toolset/knowledge-base";

const bundle = await createKnowledgeBundle(host, {
  dbPath: "/path/to/knowledge.db",
  project: "my-project",
});

bundle.kb.put({ project: "my-project", content: "内容…", source: { kind: "file", ref: "docs/a.md" } });
bundle.kb.search({ query: "构建 失败", project: "my-project", fuzzy: true });
bundle.memory.add({ target: "project", content: "本项目用 npm run check 做类型检查" });
bundle.dispose(); // 解绑事件订阅并关库
```

profile 挂载（`~/.dsh/profiles/<p>`）以 `link:` 依赖指向本包，并在 `cordis.patch.yml` 配置：

```yaml
- id: knowledge-base
  name: '@dsh-toolset/knowledge-base'
  config:
    dbPath: !!js process.env.KNOWLEDGE_DB_PATH || dshHomePath('knowledge-base/knowledge.db')
    project: 'my-project'
```

宿主侧读取方：TUI `/memory` 经 `ctx.get('knowledge')` 调 `getSummary()` / `whenReady()`。

## 边界与限制

- **检索兜底**：porter 按连续串分词（`构建通过` 匹配不到 `构建`），trigram 需 ≥3 字符子串；故「结果不足 `limit` 且查询含 CJK」或「FTS 语法错误（如 `-`）」时改用 `LIKE` 子串兜底，`fuzzy:false` 不额外召回模糊结果。
- **去重是全局的**：`put` 按 `content_hash` 去重，不区分 `project`。
- **写策略不自动调度**：`writeBack`/`backfill`/`evictStale`/`promote` 均为显式接口，本插件内无启动 / compaction / 定时触发；`pending` 为内存态，进程退出即丢；`ConsolidationLock` 不跨进程。
- token 预算按「1 token ≈ 3 字符」估算（分块上限 2000 token ≈ 6000 字符），非精确分词。
- `[tool/meta]`、`[compaction]` 尾注只写进知识库 chunk 文本，**不会**改写会话上下文；本插件不注入 system prompt。
- 库文件 0o600、父目录 0o700；`application_id` / `user_version` 不匹配的库会被拒绝或整库重置。
- `MemoryService.replace` 的 `project` 参数当前不参与定位，且未传 `category` 会把该条 category 置空。

## 测试

```sh
npm run check   # tsc -p tsconfig.json --noEmit
npm run build   # tsc -p tsconfig.json → dist/
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'
npm run demo    # node --experimental-transform-types demo/main.ts（末行 demo OK）
npm run smoke   # node smoke/smoke.mjs（需本机 dsh 0.1.5-rc.2 与模型凭据）
```

39 例测试（schema 3 + knowledge 8 + hooks 12 + writepolicy 8 + memory 6 + exposure 2）。

`smoke` 幂等引导独立 profile `dsh-toolset-knowledge-base`（`link:` 挂载、缺 `dist/` 自动构建），跑一次性真实 headless 会话强制触发 compaction 与 fs 写入，再断言库 schema 指纹与 `[tool/meta]`/`shadowedRange` 摄取行，最后对 dist 产物做 put / search / touch / evict 往返（profile 属机器级配置，不入库）。断言口径见 `IMPLEMENTATION.md` §6。

设计决策见 `DESIGN.md`，实现落点与踩坑见 `IMPLEMENTATION.md`。
