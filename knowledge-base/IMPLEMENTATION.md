# knowledge-base 实现

本文件记实现落点、关键机制与踩坑；设计取舍见 `DESIGN.md`，接口与配置见 `README.md`。

## 1. 文件落点

| 路径 | 职责 |
| --- | --- |
| `src/schema.ts` | 建表/索引/TRIGGER、schema 版本与应用指纹守护、文件权限 |
| `src/knowledge.ts` | `KnowledgeService`：put/search/touch/evict + 分块/去重/source 联动 + staleCandidates/compress/tokenBudgetUsage/promote |
| `src/hooks.ts` | `session/event` 写直达：白名单过滤、事件摘要化（`[tool/meta]`、`[compaction]`）、attach/detach |
| `src/writepolicy.ts` | `WritePolicy` + `ConsolidationLock`：批量写回、pending 与 backfill、evictStale 编排 |
| `src/memory.ts` | `MemoryService`：记忆 CRUD + 过滤检索 + token-aware 截断 |
| `src/index.ts` | bundle 接入面：`createKnowledgeBundle` 工厂、`apply`、服务暴露与就绪查询 |
| `demo/main.ts` | mock demo（无 DSH 依赖，人工确认用） |
| `smoke/smoke.mjs` | 宿主联调：profile 引导 + 真实会话摄取断言 + dist 往返 |
| `tests/*.test.ts` | node:test 单测 |
| `cordis.patch.yml` | dsh bundle 插入声明 |

## 2. 装配与生命周期（`src/index.ts`）

- `createKnowledgeBundle(host, config)`：开库 → 建 `KnowledgeService`/`MemoryService`/`WritePolicy` → `SessionHooks.attach(host)` → 返回 `{kb, memory, policy, hooks, dbPath, summary(), dispose()}`；`dispose` 解绑事件订阅并关库。
- `apply(ctx, config)` 保持宿主调用语义：**void、fire-and-forget**，创建 Promise 存入模块级 `readyPromise`，成功后才赋给 `activeBundle`；失败只写日志（`ctx.logger("knowledge-base").info`）。
- 命令侧通过 `getKnowledgeBundle()`（同步，未就绪返回 `undefined`）、`getKnowledgeBundleSummary()`、`whenKnowledgeReady()`（未 apply 时 reject）访问，避免「apply 尚未完成就读」的竞态。
- 只读服务经 `ctx.provide('knowledge', { getSummary, whenReady })` 暴露，`ctx.provide` 不是函数时静默跳过（防御式，不因宿主形态差异而失败）。

## 3. 事件接入与摘要化（`src/hooks.ts`）

- 挂接点只有一处：`ctx.on('session/event', (session, event) => hooks.handle(sessionId, event))`，`attach` 返回解绑函数。
- 过滤先于写入：非白名单类型直接返回 `null`，不产生半写；`persistTypes` 传 `null` 时不过滤。
- `summarizeEvent` 的事件形态差异由 `extractText` 吸收：递归处理 `string` / `{text}` / `{content}` / `{message.content}` / 数组；`isError` 同样递归探测。
- **`[tool/meta]`**：`serializeToolMeta` 对 `tool/result.meta` 做紧凑 JSON 序列化，`null`/`undefined`/`{}`/`[]`/循环引用（`JSON.stringify` 抛错）一律视为无载荷返回 `null`，非空时才在正文后追加 `\n\n[tool/meta]\n<compact JSON>`。
- **`[compaction]`**：`summarizeCompaction` 输出固定字段序列 `compactionId` → `shadowedRange`（缺失时回落 `shadowedSeqs`）→ `sourceCommandId` → `shadowedTokenCount` → `provider` → `model`，只输出存在且非 null 的字段；summary 文本缺失时回落整体 JSON（且不带 `[compaction]` 头），保证不丢数据。
- importance 约定：`tool/result` 失败 4、成功 2，其余白名单类型 3（compaction 走专用分支，同样 3）。
- `SessionEvent.ignorable` 的处理是**保守**的：白名单类型带该标记仍照常摄取（宁多勿漏），非白名单类型本来就会被过滤；本层不消费事件 `seq` / 日志偏移，去重完全依赖 `content_hash`。

## 4. 写入与去重（`src/knowledge.ts`）

- `put` 先按全文 `content_hash` 查既有 chunk：命中即复用 id（`created` 不增）；`sources` 按 `(content_hash, kind)` 复用，`chunk_count` 只按**实际新增**的块数累加，因此重复写入不会让记账漂移。
- 分块只在超预算时触发（`estimateTokens` 上限 2000）；段落超限用 `splitBlock` 按最后一个换行硬切，找不到合适换行（换行位置早于半程）则按 `maxChars` 字符切。
- `evict` 删除后重算受影响 source 的 `chunk_count`，归零则删 source——保证 `sources` 不会留下无 chunk 的孤儿记录。
- `search` 的三个 `MATCH` 分支（porter / trigram）各自 try/catch：FTS5 语法错误不能让检索整体失败。

## 5. 踩坑与不变量

- **FTS5 自由输入**：`MATCH` 对查询串按 FTS 语法解释，`-`（NOT）、引号不闭合等都会抛错；必须逐条 try/catch 降级，不能假设查询串是安全的。
- **CJK 召回**：porter（unicode61）按连续串分词，`构建通过` 不等于查询 `构建`；trigram 需要 ≥3 字符子串。因此「结果不足且查询含 CJK」时走 `LIKE` 兜底——这是分词器能力边界，不是可调参数。
- **LIKE 转义**：`memory.findByText` 与 `replace`/`remove` 定位都要转义 `\`、`%`、`_`，否则用户内容里的 `%` 会变成通配符、误伤其他记忆条目。
- **`MemoryService.replace`**：签名收 `project` 但实现未用它做定位；未传 `category` 时会把该条 category 置为 `null`。调用方需知晓这两点。
- **去重是全局的**：`content_hash` 不按 project 隔离，跨 project 写入相同内容会复用同一 chunk。
- **STRICT 表**：所有列都要显式类型，插入时必须提供 `not null` 无默认值的列（如 `created_at`、`content_hash`）。
- **权限与守护**：建库时设置 0o600 文件权限与 0o700 父目录；打开既有库先校验 `application_id` 与 `user_version`，不匹配即整库重置（DROP 重建），因此**不要**把别的东西写进这个库文件。

## 6. 测试与联调

```sh
npm run check
npm run test    # 39 例
npm run build
npm run demo    # 末行 demo OK
npm run smoke   # 需本机 dsh 0.1.7-rc.2 与模型凭据
```

- 单测分布：`schema` 3（TRIGGER 双索引一致、索引建立、文件库幂等 reopen）、`knowledge` 8、`hooks` 12、`writepolicy` 8、`memory` 6、`exposure` 2（apply 前暴露面未就绪 / apply 后 bundle 可写入与检索）。
- `npm run smoke` 的判定口径是**确定性证据**：引导 profile `dsh-toolset-knowledge-base`（`link:` 挂载、缺 `dist/` 自动构建）→ `dsh --version` 必须等于 0.1.7-rc.2 → 低压缩阈值 overlay 强制触发 compaction + 任务强制 fs write 产生真实 meta → 断言库文件存在且 schema 指纹匹配（`application_id = 0x4b4e4f57`、`user_version = 1`）与 `[tool/meta]`/`shadowedRange` 摄取行（不依赖宿主 logger 输出）→ dist 产物 put / search（EN 词干 + CJK LIKE）/ touch / evict 往返。真实载荷缺失时经 dist hooks 注入合成事件兜底；失败保留临时目录并打印路径。
