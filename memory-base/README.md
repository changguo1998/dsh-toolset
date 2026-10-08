# @dsh-toolset/memory-base

DSH（DeepSeek Harness）进程内插件：跨会话知识库与持久记忆——独立 SQLite（`node:sqlite`）库 + FTS5 双索引，搜索密集操作不经过宿主 storage KV 域。

## 能力

本插件**不注册模型侧工具**：订阅宿主 `session/event` 做实时沉淀，并把记忆库以服务形态挂在进程内（`provide('memory')`，暴露 `getSummary()`、`whenReady()`、`consolidate(opts?)`、`lastConsolidation()`、`rescanDenied(opts?)`、`migrate(opts?)`、`search(opts)`、`remember(input)`、`forget(refs)`、`usage()`、`enforceLimits(opts?)`）。可用接口分三组：

**知识库**（`bundle.kb`，`KnowledgeService`）：

| 接口 | 参数要点 | 返回 |
| --- | --- | --- |
| `put(input)` | `project`、`content` 必填；`title`/`target`/`category`/`sessionId`；`importance` 默认 3（clamp 1..5）；`source.kind` 默认 `manual` | `{ids, sourceId, created}` |
| `search(opts)` | `query` 必填；`project`/`target`/`category` 过滤；`limit` 默认 10（clamp 1..100）；`fuzzy` 默认 false | `SearchHit[]`，命中即刷新 `last_referenced` |
| `touch(id)` / `evict(ids)` | — | `boolean` / 删除条数（联动 `sources.chunk_count`） |
| 淘汰、提升与巩固辅助 | `staleCandidates({project, ttlMs, maxImportance=2, limit=100})`、`budgetCandidates({project, limit=50})`、`boostCandidates({project, limit=50})`、`targetRows({project, limit=500})`、`compress(ids)`、`setImportance(id, n)`、`tokenBudgetUsage(project)`、`promote({project, limit=10})` | 过期候选 id（TTL + 重要度上限）/ 淘汰顺序候选（低重要度 → 最旧，不设门槛）/ 提权候选 / 具名记忆快照 / 压缩条数 / 是否变更 / 估算 token 数 / `SearchHit[]`（按 `importance × 时间衰减` 排序） |

**持久记忆**（`bundle.memory`，`MemoryService`，与知识同库）：`add({target, content, ...})`（`target` 取 `user`/`memory`/`project`/`failure`，`project` 默认 `__global__`，`importance` 默认 3）、`replace`、`remove`（均按 `target` + 内容子串定位）、`search(opts)`（`limit` 默认 20，支持 `tokenBudget`；返回 `{hits, usedTokens, truncated}`）。

**写策略**（`bundle.policy`，`WritePolicy`）：`writeBack(items)`（锁内批量写，失败项入内存 pending）、`backfill()`（重试 pending）、`pendingCount`、`evictStale({project, ttlMs, ..., compressFirst})`（默认先压缩降级再硬淘汰）。

写直达的默认事件白名单：`tool/result`、`feedback/record`、`plan/mode`、`goal/change`、`todo/write`、`approval/decided`、`compaction/summary`。

**入库过滤与容量（2026-10-02，条目「会话事件自动入知识库」）**：

- 过滤规则（`persistRules`）：`types`（缺省沿用 `persistTypes`，`null` = 不按类型过滤）、`minChars`（最小正文长度）、`denyPatterns`（追加拒绝模式，大小写不敏感）；非法正则只记 warning 不抛。
- **隐私边界**：内置拒绝模式（PEM 私钥、`sk-` / GitHub / AWS 凭据、`Bearer …`、`password|token|api_key =` 形态）**命中即整条不入库**（不打码）；与 security-guard 的命令 / 文件级防护不重叠——这里是写库前的最后一道闸。
- **容量边界**（`maxTokensPerProject`）：每次入库后若 project 估算 token 超限，按「低重要度 → 最旧」先 `compress` 降级（正文降为 ≤300 字符摘要行），仍超预算再小步硬淘汰。
- **可观测**：`hooks.stats` 给出 `accepted` / `deduped` / `skipped{type,no-summary,empty,short,pattern}` / `compressed` / `evicted` 计数；`handle()` 返回单条结果（含跳过原因与容量守卫结果），`resetStats()` 清零。

**自动巩固（2026-10-02，条目「记忆 auto-consolidation」）**：`bundle.consolidate`（`ConsolidationService`）

| 接口 | 说明 |
| --- | --- |
| `plan(opts)` / `run(opts)` | 只读预演 / 执行一次巩固；返回报告（`promoted` / `merged` / `compressed` / `evicted` / `tokensBefore→After`） |
| 三段策略 | **提升**：被检索命中过（`last_referenced > created_at`）且 `importance < 5` 的条目 +1；**合并**：同 `target` 分组内归一化后相同、或短者是长者子串且长度占比 ≥ 0.8 → 保留 importance 高者；**淘汰**：`staleCandidates`（TTL + 重要度上限）先压缩再删除 |
| 自动触发 | `autoConsolidate{enabled,onStart,afterCompaction,minIntervalMs,options}`：apply 后一次 + `compaction/end`（或 `compaction/summary`）后一次，进程内按 `minIntervalMs`（缺省 10 min）节流；失败只 warning |
| 只读面 | `ctx.get('memory').consolidate(opts?)` 手动触发、`.lastConsolidation()` 取最近报告 |

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dbPath` | `MEMORY_DB_PATH` → `:memory:` | 库路径；`:memory:` 表示不落盘 |
| `journalMode` | `"wal"` | `wal` / `delete` / `truncate` / `persist` |
| `project` | 派生链 | 写直达事件的项目作用域：显式配置（字符串或按事件求值函数）> 会话 `header.cwd` > `process.cwd()`；自动巩固只认静态作用域（显式配置，否则进程 cwd） |
| `persistTypes` | 内置白名单 | 替换白名单；传 `null` 表示不过滤 |
| `persistRules` | 无 | `{types?, minChars?, denyPatterns?}`：类型 / 最小长度 / 拒绝模式（内置隐私模式始终生效） |
| `maxTokensPerProject` | `0`（不设限） | 入库容量守卫：超限先压缩降级再淘汰 |
| `autoConsolidate` | 全开 | `{enabled?, onStart?, afterCompaction?, minIntervalMs?, options?}`：自动巩固触发与参数；触发时顺带做逐库容量兜底 |
| `tiers` | 关闭 | 分层三库（设计 §2）：`{enabled, sessionDir?, projectRoot?, dshHome?, crossProjectRoots?}`。开启后 S / P / U 各一个库——默认落点 `<会话目录>/session.db`、`<项目根>/.dsh/project.db`、`~/.dsh/memory-base/user.db`，各带**独立指纹**（`SESS` / `PROJ` / `USER`）与独立字节上限（50 / 200 / 1 MB，U 为软上限）。**缺省关闭**：不静默在项目里建 `.dsh/`、不在家目录建库 |

淘汰、提升、截断的阈值多数不是配置项，而是各接口的调用参数（`maxTokensPerProject` 与 `autoConsolidate.options` 是写入路径上的例外）。

## 使用示例

```ts
import { createKnowledgeBundle } from "@dsh-toolset/memory-base";

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
- id: memory-base
  name: '@dsh-toolset/memory-base'
  config:
    dbPath: !!js process.env.MEMORY_DB_PATH || dshHomePath('memory-base/memory.db')
    project: 'my-project'
```

宿主侧读取方：TUI `/memory` 经 `ctx.get('memory')` 调 `getSummary()` / `whenReady()`。

## 边界与限制

- **检索兜底**：porter 按连续串分词（`构建通过` 匹配不到 `构建`），trigram 需 ≥3 字符子串；故「结果不足 `limit` 且查询含 CJK」或「FTS 语法错误（如 `-`）」时改用 `LIKE` 子串兜底，`fuzzy:false` 不额外召回模糊结果。
- **去重是全局的**：`put` 按 `content_hash` 去重，不区分 `project`。
- **与 `output-compress` 共库直写（同一 `dbPath`）**：`output-compress` 不依赖本包代码，直接对同一库插 `sources`/`chunks`（同 `content_hash` 去重键、同 2000 token 分块预算），因此**本包的入库规则（`persistRules` 的隐私拒绝模式 / `minChars`）、容量守卫（`maxTokensPerProject`）与 `hooks.stats` 计数对它的写入不生效**；反向地，本包的淘汰 / 自动巩固 / 容量守卫按 `chunks` 全表作业，会一并作用到它写入的行（那些行 `category`/`target` 均为 `output-compress`、importance 取 4/2，在合并段里自成一组、只做组内判重）。FTS 索引由库内 TRIGGER 统一维护，两条写路径都不各自建索引。
- **与官方 `session-query-sqlite`（`ctx.sessionQuery` 的 SQLite FTS5 后端）的分工**：它索引**会话历史的原始事件**（`openAt` 控制建库时机）；本包索引**沉淀后的知识 / 记忆**（去重、分段，带 importance / `last_referenced` 可淘汰）。两库各自独立，`search` 不跨库合并结果；`schema.ts` 只是参照它的 `application_id` / `user_version` 守护写法，两者不共用索引。
- **写策略本身仍不自动调度**：`writeBack` / `backfill` / `evictStale` / `promote` 保持显式接口；本插件内唯一自动的是「自动巩固」（`autoConsolidate`：启动后一次 + compaction 后，进程内节流），它调用 `consolidate.plan/run`。`pending` 为内存态，进程退出即丢；`ConsolidationLock` 不跨进程。
- **合并判据是机械的**：只合并「同 `target` 下归一化后完全相同，或短者是长者子串且长度占比 ≥ 0.8」的条目，不做语义相似（留待后续条目）；跨 `target`、跨 `project` 不合并。
- **隐私边界是形态匹配**：内置模式按常见凭据 / 私钥形态识别，无熵检测、无规则语言；命中即**整条拒绝**（不打码），故「正文里混了一段密钥」的条目会整体丢弃——宁可丢，不可泄漏。自定义 `denyPatterns` 只做追加，不能关闭内置模式。
- token 预算按「1 token ≈ 3 字符」估算（分块上限 2000 token ≈ 6000 字符），非精确分词。
- `[tool/meta]`、`[compaction]` 尾注只写进知识库 chunk 文本，**不会**改写会话上下文；本插件不注入 system prompt。
- 库文件 0o600、父目录 0o700；**一库一指纹**（S / P / U 各一个 `application_id`）：指纹不符（含旧 v1 单库的 `KNOW`）或版本不匹配一律**拒绝打开**，不再整库重置。清空重建走显式 `migrate({ from: "v1", mode: "drop" })`——删库文件与 `-wal` / `-shm`，不备份、不静默删。
- **闸门在库核心**：`knowledge.put()` 内先过该层规则（隐私底线 + `persistRules`），`writeBack` / `backfill` / `memory.add` / `remember` 一并继承——绕过事件钩子不再能绕过闸门。被拒时返回 `{ids: [], skipped}`。
- `MemoryService.replace` 的 `project` 参数当前不参与定位，且未传 `category` 会把该条 category 置空。

## 测试

```sh
npm run check   # tsc -p tsconfig.json --noEmit
npm run build   # tsc -p tsconfig.json → dist/
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'
npm run demo    # node --experimental-transform-types demo/main.ts（末行 demo OK）
npm run smoke   # node smoke/smoke.mjs（需本机 dsh 0.2.0-rc.2 与模型凭据）
```

80 例测试（schema 5 + knowledge 8 + hooks 12 + writepolicy 8 + memory 6 + exposure 2 + rules 4 + budget 3 + hooks-rules 6 + consolidate 5 + migrate 3 + rescan 4 + tiers 6 + bundle-tiers 2 + project-derivation 3 + capacity 4）。

`smoke` 幂等引导独立 profile `dsh-toolset-memory-base`（`link:` 挂载、缺 `dist/` 自动构建），跑一次性真实 headless 会话强制触发 compaction 与 fs 写入，再断言库 schema 指纹与 `[tool/meta]`/`shadowedRange` 摄取行，最后对 dist 产物做 put / search / touch / evict 往返（profile 属机器级配置，不入库）。断言口径见 `smoke/smoke.mjs` 头注释（流程 4-6）。

设计决策与实现落点见 `docs/DESIGN.md`；已知边界见其 §13。

> **实施状态（2026-10-08）**：包已改名 **`memory-base`**（服务键 `ctx.get('memory')`，目录 / 包名 / profile id / TUI 消费点全量同步）。`docs/DESIGN.md` 的目标架构**部分落地**：
>
> - **已完成**：分层三库骨架（`tiers.enabled`，一库一指纹 + 逐库字节上限 + 跨项目 P 显式开启）、路径路由（`router.ts`）、写入路由（自动路径落 S、`origin: "user"` 直达 P / U）、库核心闸门、`project` 派生链、跨层检索（层 × 分类的「层」维度）、按缺口淘汰 + S 层就地降级 + U 层软上限、存量回扫 `rescanDenied()`、显式迁移 `migrate()`、版本策略改「拒绝打开」。
> - **未完成**（DESIGN §12 差异清单剩余项）：分类注册制（一类一张表 + `registerKind`）、提升链与审阅队列（`candidates` / `promote` / `review(id)` / `resolveConflict` / LLM 概括）、`doc_index` 文档索引、`output-compress` 自持 `digest.db`、TUI 审阅面板与 `/memory` 改造。当前每层库仍是 `sources` + `chunks` 两表结构。
