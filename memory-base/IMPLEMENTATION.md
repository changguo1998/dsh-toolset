# memory-base 实现

本文件记实现落点、关键机制与踩坑；设计取舍见 `docs/DESIGN.md`，接口与配置见 `README.md`。

## 1 文件落点

| 路径 | 职责 |
| --- | --- |
| `src/schema.ts` | 建表 / 索引 / 双 FTS5 + TRIGGER、schema 版本与应用指纹守护、文件权限 |
| `src/router.ts` | `Tier` 与全量层顺序、`KindSpec` / `KindRegistry`（注册校验与 `writableTiers` 归一）、`kindTableName` |
| `src/scope.ts` | `MemoryScope` 句柄：`put` / `forget`，越权层与参数级抛错、内容级走 `skipped` |
| `src/tiers.ts` | `TierSet`：落点解析、惰性打开、按会话缓存、跨层检索 / 列举、用量 |
| `src/knowledge.ts` | `KnowledgeService`：put / search / listRows / evict + 分块 / 去重 / source 联动 |
| `src/rules.ts` | 内容闸门：内置隐私模式 + 追加拒绝模式 + 最小长度；`checkContent` / `matchDenyPattern` |
| `src/tools.ts` | 模型侧只读工具 `memory_query`（参数解析、clamp、截断、渲染） |
| `src/index.ts` | bundle 接入面：`createMemoryBundle` / `createGlobalService` / `apply`、`provide` 与 `inject` |
| `src/migrate.ts` | 旧库显式清理（`from: "v1"` / `mode: "drop"`） |
| `demo/main.ts` | mock demo（无 DSH 依赖，人工确认用） |
| `smoke/smoke.mjs` | 确定性自检（构建产物 → 三层写入 → 指纹 → 读面 → 闸门 → 真删 → 工具面） |
| `tests/*.test.ts` | node:test 单测（9 个文件 61 例） |
| `cordis.patch.yml` | dsh bundle 插入声明 |

## 2 装配与生命周期（`src/index.ts`）

- `apply(ctx, config)` **同步完成**：`readSessionPaths(ctx)`（`ctx.get("sessionPaths")` 探测）→ `createMemoryBundle({config, sessionPaths})` → `createGlobalService(bundle, config)` → `ctx.provide("memory", 八键)` → 注册 `memory_query`。没有异步就绪窗口，故 `whenReady()` 恒 resolve。
- `createMemoryBundle` **不打开任何库**：只建 `KindRegistry` 与 `TierSet`（后者只存落点参数）。库在首次写入时惰性创建。
- `ctx.get("sessionPaths")` 只认 `sessionDirFor` 一个方法；形状不符视为未挂载。包装层把解析异常统一改写成带 `sessionId` 的文案，便于定位「会话取不到」还是「服务缺失」。
- `ctx.tools` 缺失时只记日志、不注册工具（写入面不受影响）；`ctx.provide` 缺失时同样静默跳过。
- `inject = ["tools"]`；`sessionPaths` **不写进 inject**（可选读取，未挂载时只影响 S 层写入）。

## 3 分层库（`src/tiers.ts`）

- 落点：`pathFor(tier, sessionId?)` 纯解析——U 固定 `<dshHome>/memory-base/user.db`；P 为 `<projectRoot>/.dsh/project.db`；S 经 `sessionPaths.sessionDirFor(sessionId)` 取目录后拼 `session.db`。S 层缺 `sessionId`、P 层无 `projectRoot` 时返回 `undefined`。
- 打开：`openWritable`（写，缺库即建）与 `openExisting`（读 / 删，**文件不存在返回 `undefined`，绝不建库**）两条路径；后者保证一次删除不会在磁盘上留新文件。
- 缓存键是 `(tier, sessionId)`，不是路径——同一进程两个会话各有一个 `session.db`，按路径做键会让两库互相顶掉（实现期踩过）。P / U 各一份。
- S 层降级顺序：缺 `sessionPaths` → 抛「需要 session-paths 服务」；缺 `sessionId` → 抛「需要 sessionId」；解析抛错 → 原样上抛并补文案。三者都在建库之前判定。
- 检索 `search` 遍历**已打开**的库（未打开 = 空库，没有行可查），按 `TIER_WEIGHT`（U 3 / P 2 / S 1）再按分数排序截断；`list` 按 kind 逐库列举后合并、`created_at` 倒序分页。
- `usage()` 只报已创建的库：已打开的 + 落点文件已存在的 P / U；字节数直接 `stat` 文件，不再用 `page_count × page_size`（没有逐库上限了，不需要扣除 freelist）。

## 4 写入与去重（`src/knowledge.ts`）

- `put` 是 **async**：注册方 `preWrite` 允许返回 Promise，故钩子 `await` 后再决定 `skipped` / `importance`。
- 闸门顺序固定：隐私闸（`checkContent`）→ 分类解析（未注册 → `skipped: "kind"`）→ `preWrite`（拒绝 → `skipped: "hook"`）→ 建表（首次）→ 去重 / 插入。
- 去重键是**全局** `content_hash`（不按 project 隔离）；`sources` 按 `(content_hash, kind)` 复用，`chunk_count` 只按**实际新增**块数累加，重复写入不会让记账漂移。
- 分块只在超预算时触发（`estimateTokens` 上限 2000）；段落超限用 `splitBlock` 按最后一个换行硬切，找不到合适换行（换行位置早于半程）则按 `maxChars` 字符切。
- `evict` 删除后按**全部已建分类表**重算 `sources.chunk_count`，归零则删 source——只算本表会把别表的行误判为孤儿并连带删掉来源。
- `search` 的每个 `MATCH` 分支（porter / trigram）各自 try/catch：FTS5 语法错误不能让检索整体失败。
- `listRows` 按 `(kind → 物理表)` 直查，`created_at DESC, id DESC` + `LIMIT/OFFSET`；未注册或未建表返回空数组（读侧宽松，不抛）。

## 5 句柄与失败语义（`src/scope.ts`）

- `put`：`tier` 缺省 `session`；先判「合法层 → 在 `writableTiers` 内 → S 层有 `sessionId`」，三者任一不满足抛错，**不落库**。会话层写入时记下 `sessionId`，供同一句柄后续 `forget` 定位同一库。
- `forget`：同样校验层与 `writableTiers`；只对**已打开**的库执行，返回实际删除条数。S 层用最近一次写入的 `sessionId` 定位（删除与会话库是同一个键）。
- 内容级拒写一律 `skipped`：隐私闸命中给 `pattern` / `empty` / `short`，钩子拒绝给 `hook`，未注册 kind（直接调 `KnowledgeService.put` 时）给 `kind`。

## 6 模型侧工具（`src/tools.ts`）

- 参数解析对畸形输入宽容：`limit` 非数字回落缺省、非法 `tier` 当没给、`action` 非 `list` 一律按 `search`；`search` 缺 `query` 返回 `error` 值而不是抛错。
- `truncated` 的判据是「返回行数达到 `limit`」（可能还有更多），不是「查到了总数」——工具不额外计数。
- `output.render` 必须对任意值都能出文本（`null` / 数字 / 字符串都退化为默认值），否则宿主渲染层会拿到异常。

## 7 踩坑与不变量

- **FTS5 自由输入**：`MATCH` 按 FTS 语法解释查询串，`-`（NOT）、引号不闭合等都会抛错；必须逐条 try/catch 降级，不能假设查询串安全。
- **CJK 召回**：porter（unicode61）按连续串分词，`构建通过` 不等于查询 `构建`；trigram 需要 ≥3 字符子串。因此「结果不足且查询含 CJK」时走 `LIKE` 兜底——分词器能力边界，不是可调参数。
- **LIKE 转义**：查询串进 `LIKE` 前必须转义 `\`、`%`、`_`，否则用户内容里的 `%` 会变成通配符。
- **STRICT 表**：所有列都要显式类型，插入时必须提供 `not null` 无默认值的列（`source_id` / `project` / `content` / `content_hash` / `created_at`）。
- **权限与守护**：建库时 0o600 文件、0o700 父目录；打开既有库先校验 `application_id` 与 `user_version`，不符**拒绝打开**（不 DROP 重建）。
- **会话层多库**：S 层的缓存键必须带 `sessionId`；`getSummary()` 在拿不到会话 id 时不列 S 层落点（那一条没有确定路径）。
- **重算 `chunk_count` 不能只看本表**：跨分类共享 source 时，只算本表会把别的表的行当成孤儿（决策 D40 的回归点，`tests/kinds.test.ts` 有对应用例）。

## 8 测试与联调

```sh
npm run check   # tsc -p tsconfig.json --noEmit
npm run build   # tsc -p tsconfig.json → dist/
npm run test    # node --experimental-transform-types --test 'tests/*.test.ts'
npm run demo    # node --experimental-transform-types demo/main.ts（末行 demo OK）
npm run smoke   # node smoke/smoke.mjs（自包含自检，不依赖模型凭据）
```

- 单测分布（61 例）：`schema` 5（双索引 TRIGGER、列集与已删表、索引、文件库幂等 reopen、版本拒绝打开）、`knowledge` 12（检索 / 只读性 / 去重 / 未注册 / 隐私闸 / 删除联动 / 分块 / 过滤 / fuzzy / CJK / 列举 / kinds）、`kinds` 8（按需建表 / 未注册 / 钩子同步与异步 / 并集 / 跨表删除 / 注册约束 / 无具体分类名）、`tiers` 9（指纹 / 旧库 / 惰性 / 按会话 / 三条降级 / 跨层检索 / 列举 / 删除 / 用量）、`bundle-tiers` 9（摘要 / 句柄三层 / S 层 / 内容级拒写 / 真删 / 八键 / 列举检索 / apply）、`exposure` 3、`tools` 8、`rules` 4、`migrate` 3。
- `smoke` 判定口径是确定性证据：构建产物 → `createMemoryBundle` 落点断言（未落盘）→ 三层各写一条 → 三个库文件存在且 `application_id` / `user_version` 匹配 → `search` 跨层排序与 `list` / `usage` → 隐私闸 / `preWrite` / 越权层 → `forget` 计数 → `memory_query` 两种 action 与渲染 → 可选报告宿主机版本。失败保留临时目录并打印路径。
