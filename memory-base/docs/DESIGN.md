# memory-base 设计

> 阅读顺序：§0 定位（先读）→ §1 分层与落点 → §2 分类与句柄 → §3 写面与闸门 → §4 查询面 → §5 删除与用量 → §6 模型侧工具 → §7 Schema 与版本 → §8 失败语义 → §9 与相邻组件的边界 → §10 已知边界 → §11 实现落点与踩坑。

## 0 定位（先读这一节）

本包**只负责存储**，提供五件事：**分层 / 分类 / 读写 / 查询 / 按扩展隔离**（用户 2026-10-17 裁定）。

由此推出三条硬口径，其余设计都从它们推出来：

1. **管理逻辑不在本包**。提升链（`promote` / `candidates` / 审阅 / LLM 概括）、生命周期与容量（淘汰 / 压缩 / 逐库上限 / 自动巩固）、事件沉淀（`session/event` 写直达）、文档索引（`doc_index`）已全部**删除**，需要时由消费插件自建（先例：`preference-analysis` 自持账簿、`output-compress` 自持 `digest.db`）。
2. **隔离只落在写侧**（用户 2026-10-17 裁定「读可以全局，只有写需要隔离权限」）。全局面 `ctx.get("memory")` = **八读 + 三管理写**：`forget` / `update` / `remember` 只处理 **U / P 层**（S 层按会话隔离，一律拒绝），用于用户纠错与直写（2026-10-23 裁定，见 `/memory` 条目）；扩展的业务写入与删除仍只经 `registerKind(spec)` 返回的作用域句柄（`MemoryScope`）。
3. **本包只解释内容形态，不解释语义**。隐私闸与注册方 `preWrite` 是存储侧约束；分类名、分类语义、内容价值都归注册方。代码里不出现具体分类名（`tests/kinds.test.ts` 有一条 grep 断言守住这点）。

## 1 分层与落点

| 层 | 库文件 | 落点 | 指纹（`application_id`） | 典型内容 |
| --- | --- | --- | --- | --- |
| **S** 会话 | `session.db` | `<sessionPaths.sessionDirFor(sessionId)>/session.db` | `0x53455353`（`SESS`） | 本次会话内的要点 |
| **P** 项目 | `project.db` | `<projectRoot>/.dsh/project.db` | `0x50524f4a`（`PROJ`） | 本项目跨会话成立的事实 |
| **U** 用户 | `user.db` | `<dshHome>/memory-base/user.db` | `0x55534552`（`USER`） | 跨项目偏好与习惯 |

不变量：

- **层级恒开启**（2026-10-17 三次裁定）：没有 `tiers.enabled` 开关，也没有单库形态；`dbPath` / `MEMORY_DB_PATH` 随单库模式一并取消。
- **库惰性创建**：`TierSet.open` 只解析落点、**不打开任何库**；首次写到某层才建 / 打开该库。因此「装好了但没用过」不会在项目里留 `.dsh/`、也不在家目录留库。
- **S 层落点按会话解析**：本包不自己拼路径，也不读宿主会话服务——调用 `session-paths` 的 `sessionDirFor(sessionId)`（决策项 11 选 d）。宿主布局知识集中在那一个包里，本包只消费。
- **同进程多会话**：一个 bundle 服务全部会话，S 层按 `(tier, sessionId)` 惰性打开并缓存，主会话与子代理会话各落各库。
- **层不可用是明示例外**：写 S 层却缺 `sessionId`、`session-paths` 未挂载、目录解析失败、库打不开（权限 / 目录被清理）——一律**抛错**，不退化、不静默换路径。读侧相反：跨可用层取，没有的层就是空。

## 2 分类与写入句柄

**一类一张物理表**：表名 `kind_<slug>`（标识符白名单校验），同一 kind 在三层库里各有一张同名同结构的表。分类**不是列**，因此「按 kind 过滤」= 选表，不是 `WHERE kind = ?`。

**注册是拿到写入句柄的唯一途径**（决策项 1 选 b）：

```ts
interface KindSpec {
  kind: string;
  table?: string;                    // 缺省 kind_<slug>
  writableTiers?: readonly Tier[];   // 缺省 ["session"]
  preWrite?(input: KindWriteInput): KindVerdict | Promise<KindVerdict>;
}
```

- `writableTiers` 是**写侧隔离在层维度的落地**：想写 P / U 必须在注册时显式声明；句柄对越权层抛错。
- `preWrite` 是注册方的**内容级硬闸**：在隐私闸之后、INSERT 之前执行，可拒绝（`skipped: "hook"`）或建议 `importance`（clamp 1..5），允许返回 Promise。
- **`preWrite` 的入参不含 `tier`**（口径冻结于 2026-10-17）。需要「按层分别拦截」的消费方**拆 kind**，让 `writableTiers` 与句柄本身当闸门；先例：`preference-analysis` 用 `preference`（`["project"]`，归纳路径）+ `preference_user`（`["user"]`，只由用户显式动作调用）。
- **按需建表**：注册不建表，首次写入该分类时才建（空表不建）；新增分类 = 加表，不需要数据迁移。
- **kind 名由注册方自定，本包不校验、也不维护全量清单**。注册方的现实约束：`kind` 非空、`writableTiers` 在 `Tier` 并集内**且不能为空数组**、表名不撞保留名且不同 kind 不共表、**同 kind / 同表不得重复注册**（不满足即抛错，见 `../src/router.ts` 的 `register` / `normalizeTiers`）。消费方之间 kind 名不撞车只能由注册方单侧保证，文档里出现的 kind 名都只是引用先例。

## 3 写面与闸门

写入路径：句柄 `put(input)` → 参数级 / 权限级校验 → 目标层库（惰性打开）→ 库核心闸门 → 去重 / 分块 / 记账。

**闸门顺序（库核心内，绕不过）**：

1. **隐私底线**：内置六类形态（PEM 私钥、`sk-`、GitHub token、AWS key id、`Bearer …`、`password|token|api_key = value`）+ 配置追加的 `persistRules.denyPatterns`；命中**整条拒绝、不打码**。另有 `persistRules.minChars` 的最小长度闸。
2. **注册方 `preWrite`**：`accept: false` 即拒。
3. 两者都不拦时进入去重与插入。

**去重与分块**：`content_hash` **全局**去重（不按 project 隔离）；单块预算 2000 token（约 6000 字符，1 token ≈ 3 字符的粗估），按 markdown 段落边界切，单段超限按最后一个换行硬切。`sources` 按 `(content_hash, kind)` 复用，`chunk_count` 只按**实际新增**块数累加。

**拒写的两种形态**（这是本包唯一的两种失败风格）：

| 形态 | 触发 | 表现 |
| --- | --- | --- |
| **抛错** | 参数级 / 权限级：`tier` 不合法、`tier` 不在 `writableTiers`、写 S 层缺 `sessionId`、层库不可用 | `Promise` reject，文案带 kind 与 tier |
| **`skipped`** | 内容级：隐私闸命中（`pattern` / `empty` / `short`）、`preWrite` 拒绝（`hook`） | resolve `{ids: [], skipped}`，不落库、不抛 |

**importance**：调用方给（缺省 3），`preWrite` 可覆盖，最终 clamp 1..5。它只是排序提示，本包不据此淘汰任何行。

## 4 查询面

查询是**全局只读**，不分扩展（用户 2026-10-17 裁定「读可以全局」）。两个入口：

- `search({query, kind?, tier?, project?, limit?, fuzzy?, mode?})`：对已注册分类取并集；`mode` 缺省 `bm25`（单词面），取值 `hybrid` 时改为四路 RRF 融合（带权 BM25（title 2 / content 1）+ trigram + LIKE + 词项邻近（共现窗口 ≤ 64 字符，K=60）），分数取负保持「越小越相关」。`bm25` 口径下：`porter` 词干 BM25 为主，`fuzzy: true` 叠加 `trigram` 子串召回；\*\*结果不足 `limit` 且（查询含 CJK 或 FTS 语法错误（如 `-`））\*\*时走 `LIKE` 子串兜底。**跨层合并排序 = 层权重 U > P > S，同层按分数**。
- `list({kind?, tier?, project?, limit?, offset?})`：按 kind 结构化列举（未给 kind = 跨 kind），`created_at` 倒序 + 分页。这是修掉旧「按 kind 列举缺口」的面——旧 `targetRows` 只返回 `target IS NOT NULL` 的行。**U / P 层列举前按需 `openExisting`**（只开既有库、不建库），否则冷启动时列表恒空、管理面无法按 id 寻址；只列 `tier` 时不开另一层。

`search` **没有任何写副作用**：旧口径的 `last_referenced` 刷新已随列删除一并下线（命中即写会让只读查询变成写操作，也让「存储」与「生命周期」纠缠）。

结果行 `StoreRow` 带 `kind` 与 `tier` 标签（跨库跨表合并时必需）：

```ts
interface StoreRow {
  id: number; kind: string; tier: Tier; project: string;
  title: string | null; content: string; importance: number;
  sessionId: string | null; createdAt: number;
}
interface SearchHit extends StoreRow { score: number }   // 分数越小越相关
```

## 5 删除与用量

- **删除只经句柄**：`scope.forget([{tier, ids}])` 真删并**返回删除条数**（旧单库形态恒返 0 的缺口已修）。删除后按**全部已建分类表**重算 `sources.chunk_count`，归零的 source 一并清理——只算本表会把别表的行误判为孤儿并连带删掉来源。
- 删除只作用于**已存在**的库：未创建 / 未打开的层视为无行，不会因为一次删除把库建出来。
- `usage()` 只报**已创建**的库（`{tier, path, bytes}`），字节数直接取文件大小；逐库上限与容量三字段随守卫取消一并删除。

## 6 模型侧工具

**只有一个只读工具 `memory_query`**（决策项 10 选 a：单工具 + `action` 分派；这也推翻了旧定位「本插件不注册模型侧工具」）：`action`、全部参数、输出渲染与安全面见 `README.md`「模型侧工具 `memory_query`」。

## 7 Schema 与版本

- **分类表列集**（2026-10-17 收窄，语义列全删）：`id` / `source_id` / `project` / `title` / `content` / `content_hash` / `importance` / `session_id` / `created_at`，`STRICT` 表；索引 `(project, created_at)` 与 `source_id`。
- **`sources` 表**：本包自己的来源记账（`kind` / `label` / `ref` / `content_hash` / `chunk_count` / `created_at`），全库一份，不分层不分分类。
- **双 FTS5 + TRIGGER**：`<table>_fts`（porter）与 `<table>_trigram_fts`（trigram）以 external content 模式挂靠分类表（免双份存储），INSERT / UPDATE / DELETE 由 TRIGGER 写直达同步（UPDATE = delete 旧行 + insert 新行）。
- **版本号 = 2**：不兼容变更时 +1。打开既有库先校验 `application_id` 与 `user_version`；指纹不符（含旧 v1 单库的 `KNOW`）或版本不符一律**拒绝打开**，不整库重置（GB 级库上等于数据全失）。
- **旧数据不迁移，直接删**（2026-10-17 二次裁定）：新 schema 不带 `candidates` 表、`doc_index` 表与提升链 / 语义列，也不为兼容旧库保列。旧库打不开是预期行为；需要清空时显式调用 `migrate({from: "v1", mode: "drop"})`（删库文件与 `-wal` / `-shm`，不备份、不静默删）。
- **权限**：库文件 `0o600`、父目录 `0o700`；`journal_mode` 缺省 `wal`，可配 `delete` / `truncate` / `persist`。

## 8 失败语义汇总

| 场景 | 行为 |
| --- | --- |
| `session-paths` 未挂载 / 会话目录解析失败 | 写 S 层抛错（读侧跳过该层） |
| 句柄越权层 / `tier` 非法 / S 层缺 `sessionId` | 抛错 |
| 隐私闸命中 / `preWrite` 拒绝 | `PutResult.skipped` |
| 未注册 kind | 句柄拿不到（`registerKind` 抛）；直接调 `KnowledgeService.put` 时 `skipped: "kind"` |
| kind 未建表 | `search` / `list` 返回空（不抛） |
| FTS5 语法错误 | 该次 MATCH 降级，整体检索不失败，仍走 LIKE 兜底 |
| 库指纹 / 版本不符 | 拒绝打开，错误里指明 `migrate` 入口 |
| 宿主缺 `tools` 服务 | 不注册 `memory_query`，只记日志（写入面不受影响） |

## 9 与相邻组件的边界

| 组件 | 边界 |
| --- | --- |
| `session-paths` | 会话目录编码的唯一事实源。本包只调 `sessionDirFor(sessionId)`；未挂载时 S 层写入按明示例外报错，不自己拼路径 |
| `preference-analysis` | 本包的第一个写入句柄消费方：`preference`（`["project"]`）+ `preference_user`（`["user"]`），账簿与归纳逻辑全在它内部 |
| `output-compress` | 自持 `digest.db`，只经句柄 `put` 把 `is_error` 摘要推进本包；不直写本包的表 |
| `security-guard` | 命令 / 文件级防护；本包的隐私闸是**写库前**的最后一道内容闸，两者不重叠 |
| 官方 `session-query-sqlite` | 索引**原始会话事件**；本包索引**沉淀后的知识**。两库独立，`search` 不跨库合并 |
| TUI `/memory` | `search` / `list` / `remove` / `replace` / `add` 均走全局面：读用 `search` / `list`，删改与用户直写用管理面 `forget` / `update` / `remember`（S 层在 TUI 侧前置拒绝） |

## 10 已知边界

- **CJK 召回**：`porter` 按连续串分词（`构建通过` 匹配不到 `构建`），trigram 需 ≥3 字符子串。故「结果不足 `limit` 且（查询含 CJK 或 FTS 语法错误）」时走 `LIKE` 兜底——这是分词器能力边界，不是可调参数。
- **`LIKE` 必须转义** `\` / `%` / `_`，否则用户内容里的 `%` 会变成通配符。
- **去重是全局的**：`content_hash` 不按 project 隔离，跨 project 写入相同内容会复用同一行。
- **管理面 `update` 不重新分块**：就地改单行的内容 / 标题 / 重要度（用于纠错），超长内容按单行存；需要重新分块的场景仍应走「删旧行 + `put`」。
- **token 预算按 1 token ≈ 3 字符估算**（分块上限 2000 token ≈ 6000 字符），非精确分词。
- **隐私边界是形态匹配**：无熵检测、无规则语言；命中即整条拒绝（不打码），因此「正文里混了一段密钥」的整条会被丢弃——宁可丢，不可泄漏。`denyPatterns` 只能追加，不能关闭内置模式。
- **本包不做价值判断**：`importance` 由写入方给，本包不据此淘汰、不做冲突裁定、不做近似替换——这些都需要语义，归上层。
- **删除不传播**：删掉一行不影响其他层或来源记账以外的任何东西（回指链允许悬空，本包也不维护回指）。
- **同进程共享**：一个 bundle 服务全部会话；S 层多库缓存不设上限（按会话数增长，进程退出即释放）。
- 项目根 `.dsh/` 里的 P 库是项目内文件，需要提示用户加进 `.gitignore`（本包不自动改仓库文件）。

## 11 实现落点与踩坑

> 原包根 `IMPLEMENTATION.md` 的有效内容并入本节（2026-10-18），该文件已删除。

| 路径 | 职责 |
| --- | --- |
| `src/schema.ts` | 建表 / 索引 / 双 FTS5 + TRIGGER、schema 版本与应用指纹守护、文件权限 |
| `src/router.ts` | `Tier` 与全量层顺序、`KindSpec` / `KindRegistry`（注册校验与 `writableTiers` 归一）、`kindTableName` |
| `src/scope.ts` | `MemoryScope` 句柄：`put` / `forget`，越权层与参数级抛错、内容级走 `skipped` |
| `src/tiers.ts` | `TierSet`：落点解析、惰性打开、按会话缓存、跨层检索 / 列举、用量 |
| `src/knowledge.ts` | `KnowledgeService`：put / updateRow / search / listRows / evict + 分块 / 去重 / source 联动 |
| `src/rules.ts` | 内容闸门：内置隐私模式 + 追加拒绝模式 + 最小长度；`checkContent` / `matchDenyPattern` |
| `src/tools.ts` | 模型侧只读工具 `memory_query`（参数解析、clamp、截断、渲染） |
| `src/index.ts` | bundle 接入面：`createMemoryBundle` / `createGlobalService` / `apply`、`provide` 与 `inject` |
| `src/migrate.ts` | 旧库显式清理（`from: "v1"` / `mode: "drop"`） |

**装配与生命周期**（`src/index.ts`）：

- `apply(ctx, config)` **同步完成**：`readSessionPaths(ctx)`（`ctx.get("sessionPaths")` 探测）→ `createMemoryBundle({config, sessionPaths})` → `createGlobalService(bundle, config)` → `ctx.provide("memory", 八读 + 三管理写)` → 注册 `memory_query`；没有异步就绪窗口，故 `whenReady()` 恒 resolve。
- `createMemoryBundle` **不打开任何库**，只建 `KindRegistry` 与 `TierSet`（后者只存落点参数）；`ctx.get("sessionPaths")` 只认 `sessionDirFor` 一个方法，形状不符视为未挂载，解析异常统一改写成带 `sessionId` 的文案。
- `inject = ["tools"]`；`ctx.tools` / `ctx.provide` 缺失时只记日志并跳过（写入面不受影响），`sessionPaths` 不写进 `inject`。

**实现期踩坑**（每条都有对应用例或代码依据）：

- **S 层缓存键是 `(tier, sessionId)` 而不是路径**：同一进程两个会话各有一个 `session.db`，按路径做键会让两库互相顶掉；`getSummary()` 在拿不到会话 id 时不列 S 层落点（那一条没有确定路径）。
- **读 / 删走 `openExisting`**（文件不存在返回 `undefined`，绝不建库），写走 `openWritable`（缺库即建）；S 层三步降级（缺 `sessionPaths` → 缺 `sessionId` → 解析抛错）都在建库之前判定。
- **闸门顺序固定**：隐私闸 → 分类解析（未注册 → `skipped: "kind"`）→ `preWrite` → 首次建表 → 去重 / 插入；`put` 是 **async**（`preWrite` 允许 Promise，`await` 后决定 `skipped` / `importance`）。
- **层权重**：`TIER_WEIGHT` = U 3 / P 2 / S 1；`search` 只遍历**已打开**的库（未打开 = 空库，没有行可查），`list` 按 kind 逐库列举后合并、`created_at` 倒序分页；`usage()` 的范围是「已打开的库 + 落点文件已存在的 P / U」，字节数直接 `stat` 文件。
- **分块只对超预算块生效**：段落超限按最后一个换行硬切，换行位置早于半程则按 `maxChars` 字符切。
- **STRICT 表**：所有列显式类型，插入必须提供 `not null` 且无默认值的列（`source_id` / `project` / `content` / `content_hash` / `created_at`）。
- **`forget` 用最近一次写入的 `sessionId` 定位**同一会话库；只对**已打开**的库执行，返回实际删除条数。
- **工具面宽容**：`limit` 非数字回落缺省、非法 `tier` 当没给、`action` 非 `list` 一律按 `search`，`search` 缺 `query` 返回 `error` 值而不抛错；`truncated` 判据是「返回行数达到 `limit`」；`output.render` 对任意值都能出文本（`null` / 数字 / 字符串退化为默认值）。
