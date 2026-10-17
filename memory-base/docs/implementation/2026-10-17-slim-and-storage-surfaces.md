# memory-base 接口重设：分层 / 分类 / 读写 / 查询 / 按扩展隔离（接取条目：`memory-base/docs/BACKLOG.md`「按「只提供分层记忆内容」的新定位瘦身，并补四项纯存储面（指定层写入 / 按 kind 列举 / 真删 / `registerKind` 去留）」）

状态：决策（2026-10-17）　　开启：2026-10-17　　关闭：未关闭
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮范围：调研 + 决策，不写实现代码（用户 2026-10-17 指示：在本会话内开工三个模块条目、不开新 worktree、做完决策后停下等审阅）。工作区：主检出 `main`。

## 目标

按用户 2026-10-17 的口径重设 memory-base 的接口：本包只保留**分层 / 分类 / 读写 / 查询 / 按扩展隔离**五件事，提升链与生命周期面（提升 / 审阅 / 巩固 / 淘汰 / 容量 / 文档索引 / 事件沉淀）取消并移到别的插件。接口形态为「全局面（注册 / 元信息 / 全局只读查询）+ 每个扩展一个写入作用域句柄」，**隔离只落在写侧**（用户 2026-10-17 裁定：读可以全局，只有写需要隔离权限）。

## 调研

来源：`docs/implementation/2026-10-16-preference-analysis-design.md`（R1 与 D16-D20）、`memory-base/src/**`、`memory-base/README.md`、`memory-base/docs/DESIGN.md`、`memory-base/tests/**`、`output-compress/src/**`、`TUI/src/app/**`；实读 + 子代理只读核查（结论均带 `文件:行`）。

01. **裁定来源与新定位**：D16 选「账簿为唯一状态源，memory-base 只存偏好正文」（设计 `:153-155`）；D17 选审阅与回滚自持（`:157-159`）；D18 选「默认写 P、跨 ≥ 2 个项目才提议升 U、U 只走用户显式动作」，并**希望 memory-base 保留 `preWrite` 钩子作硬闸**（`:161-163`）；D19 给出四项最小要求（`:165-167`）；D20 选「先瘦身、偏好随后按新面实现」（`:169-171`）。
02. **服务面现状**：`provide("memory", {...})` 共 19 键（`src/index.ts:779-948`，`export const provide = ["memory"]` 在 `:118`）。`forget` 恒返 0 的原因是可选的 `bundle.tiers` —— `return bundle.tiers?.forget(refs) ?? 0`（`:846-851`），而 `tiers` 只在 `config.tiers.enabled` 时挂上（`:719`）；**底层真删能力已存在**：`KnowledgeService.evict(refs)`（`src/knowledge.ts:636-663`，返回删除条数并联动 `sources.chunk_count`），只是没经服务面透出（`bundle.kb` 不是服务面键）。`setImportance`（`:905-914`）与 `touch`（`:621`）同样存在而未透出。
03. **`origin` 的作用面**：取值 `"auto" | "user"`（`src/knowledge.ts:72`）。全包只被读两处 —— 写入路由判定（`src/tiers.ts:322`：只有 `origin === "user" && tier !== undefined` 才写指定层）与落列留痕（`src/knowledge.ts:576`、`:598`）。**隐私闸不读它**（`knowledge.ts:493-501` 只看内容形态）、**U 层闸也不读它**（分类闸 `:503-513` + `tiers.ts:374` 的 `allowFallback: false` 只要求「显式给已注册 `kind`」）。真正按层判权限的是 `promote.ts:626-631` 的 `reviewerAllowed`（`targetTier === "user"` → `reviewer === "user"`），它随候选队列一起下沉。故取消 `origin: "user"` 要求失去的是「自动路径唯一入口 = S」这条程序化闸与 `origin` 列的留痕语义；隐私闸、分类闸、U 层禁兜底、逐库容量上限都不受影响。
04. **按 kind 列举的实现约束**：分类**不是列**而是物理表身份 —— 表名 `kind_<slug>`（`src/router.ts:147-159`），每层库一张；`sources.kind` 是来源类型（`session|file|url|tool_result|manual`，`src/knowledge.ts:53`），与分类无关。故 `list({kind})` 只能是「`registry.resolve(kind).table` + 存在性判断」，不是 `WHERE kind = ?`。现唯一「列行」的只读面 `targetRows({project, limit})`（`src/knowledge.ts:917-959`）没有 kind 过滤、且 `WHERE project = ? AND target IS NOT NULL`（`:931`），不返回 `title` / `category` / `origin` / `created_at`；`search` 必填 `query`（`:79`）。`target` 列由写入方自由给（`knowledge.ts:589`，`input.target ?? null`），`approveCandidate` 落库不写 `target`（`promote.ts:683-690`）。
05. **候选链是死面**：`approveCandidate` 对 `summarized = 0` 的候选，无 LLM caller 直接返回 `{ok:false, reason:"llm-unavailable"}` 并保持 pending（`src/promote.ts:658-682`，闸在 `:661`），而 `summarized` 只由 `summarizeForCandidate` 产生（`:440-445`）、无 caller 时恒为 0；全仓（排除 `.worktree/`）**没有任何调用方注入 caller**（`setLlmCaller` 只有定义与透传：`src/index.ts:256`、`:714-716`、`:934-937`）→ 现态下候选只能 reject。`promote.ts` 只被 `src/index.ts:69` 一处 import，整文件删除的改动面很小。
06. **`registerKind` 与 `preWrite`**：`KindSpec` / `preWrite` 定义在 `src/router.ts:110-120`，`preWrite` 调用点在 `src/knowledge.ts:514-523`（隐私闸 → 分类闸 → `preWrite` → INSERT），`!hook.accept` → `{ids: [], skipped: "hook"}`，`hook.importance` 参与 clamp（`:525-528`）。注册还带来「按需建表」「自动并入检索并集」（`router.ts:253-259`）。**唯一生产调用方是 `output-compress`**（`output-compress/src/index.ts:142`，可选依赖 `?:`，失败只告警 `:145`）。
07. **`conclusion` 标记不存在**：全仓 `git grep` 只在偏好分析设计 `:143-147`、`:167`、`:254` 命中，且是被划删、**从未实施**的 D15 旧条款 → 瘦身无此项可删（条目里的该措辞来自旧设计表述）。
08. **跨包影响一：TUI 审阅面板依赖候选队列**。`/memory review` 面板与 `/memory add`（写死 `origin: "user"`）走 `candidates.*`：`TUI/src/app/index.ts:4915-4945`、`:5071-5290`（面板）、`TUI/src/app/adapter/dsh.ts:4022-4090`（`memoryCandidates` / `Approve` / `Reject` / `ResolveConflict` / `Edit`）、`TUI/src/app/adapter/types.ts:1389-1460`（类型声明）、`TUI/tests/memory-review.test.ts`（4 例）。删 `candidates` 会同时废掉这条消费链 —— **属 TUI 侧改动，不在本任务范围**（见决策项 7）。
09. **跨包影响二：`output-compress` 的两处可选依赖静默退化**。`promote` 与 `registerKind` 都是 `?:` 调用（`output-compress/src/index.ts:63-67`）：删 `registerKind` → 该包只留告警（`:142-145`）；删 `promote` → `pushDigest` 直接 return（`output-compress/src/hooks.ts:339-340`），digest 行停留在 `none` 且**不会报错、没有测试或文档提醒**。
10. **测试面与牵连**：19 个测试文件、`test(` 计数 103（`memory-base/README.md:133` 写的「80 例」已过期）。牵连清单 —— 删候选链 → `tests/promote.test.ts`（7 例 / 396 行）整文件删（`consolidate.test.ts` 与 `writepolicy.test.ts` 里的 `promoted` / `kb.promote()` 是**同名不同物**：巩固报告字段与 resume 排序，不受影响）；取消 `origin` 要求 → `tests/tiers.test.ts:69-114` 两组断言必须重写、`tests/bundle-tiers.test.ts:36` 复核；`forget` / `targetRows` **当前零测试覆盖**（须新增），`evict` 有回归（`tests/knowledge.test.ts:96-116`、`tests/kinds.test.ts:158-198`）；`tests/kinds.test.ts`（12 例）在保留 `registerKind` 时全部转为回归；`tests/exposure.test.ts` 不走 provide 键，服务面增删不影响它。
11. **文档滞后（本次一并订正）**：`memory-base/README.md:141-142` 的「实施状态」把「分类注册制」「提升链与审阅队列」列为未完成，实际两者代码都已落地；`:133` 的例数过期。`docs/DESIGN.md` 描述目标架构（文件头 `:5` 自述），其 §6 提升链整节与 §4 注册制是本包职责的旧口径。
12. **运行时前置**：本机 profile 只配了 `dbPath`、未配 `tiers`（偏好分析设计 `:28` 的记录；本轮未复读仓库外文件）→ 单库模式下没有层级概念（`src/index.ts:839-844`），分层语义只在开启 `tiers` 时成立。

## 决策

### 范围裁定（2026-10-17，用户口径）

取代本轮早前拟的决策项 1（瘦身范围），也取代本文件原先引用的偏好分析 D19 四项最小要求。

**保留（本包职责，6 项）**

1. **分层**：S / P / U 三库 + 一库一指纹 + 逐层路径路由。**2026-10-17 二次裁定：层级恒开启（不再有 `tiers.enabled` 开关，也没有单库形态），库文件惰性创建**（取代决策项 7 的「缺省关闭」口径）—— 启动只解析路径，首次写到某层时才建 / 打开该库。
2. **分类**：扩展注册制，一类一张物理表（`kind_<slug>`）；**注册是拿到写入句柄的唯一途径**，“未注册拒写”不再是运行期闸门（四次裁定把它去掉）。
3. **读写**：写入按扩展权限隔离（句柄 + `writableTiers`），删除同经句柄；不再要求 `origin: "user"`。
4. **查询**：全局可用 —— 全文检索（FTS5）与按 kind 列举，两者都支持按 kind / 层 / 项目过滤。
5. **按扩展隔离**：**只落在写侧**（用户 2026-10-17 裁定「读可以全局，只有写需要隔离权限」）；见决策项 1 与 3。
6. **模型侧查询工具**：**推翻本包「不注册模型侧工具」的既有定位**（`README.md:7`，用户 2026-10-17 裁定），注册一个跨 kind 的只读查询工具；写侧仍不对模型开放（见决策项 10）。

**取消并移出**

1. **提升链**：`promote` / `candidates.*` / `approveCandidate` / `reviewerAllowed` / LLM 概括闸 / `setLlmCaller` —— `src/promote.ts` 整文件删除（已核只被 `src/index.ts:69` 一处 import）。
2. **生命周期与限制**：`autoConsolidate` 与 `consolidate` / `lastConsolidation`（`src/consolidate.ts`）、`maxTokensPerProject`、淘汰与压缩面（`staleCandidates` / `budgetCandidates` / `boostCandidates` / `compress` / `enforceLimits` / `evictStale`，`src/budget.ts` 同去）。**逐库字节上限的强制也随之下线**（`usage()` 仍可只读报告用量）。
3. **事件沉淀**：`session/event` 自动入库链（`src/hooks.ts`）与 `persistTypes` / `persistRules` / `rescanDenied`。
4. **文档索引**：`doc_index` 与 `scanDocs`（`src/doc-index.ts`）。
5. **重复面**：`bundle.memory`（`src/memory.ts` 的 `MemoryService`）与 `bundle.policy`（`src/writepolicy.ts` 的 `WritePolicy`）。
6. **分类闸与兜底分类**（四次裁定 G1）：运行期的「未注册拒写」与 `defaultKind` 配置项、U 层禁落兜底规则全部去掉 —— 拿不到句柄就写不了，闸门退化为注册期能力；但**库核心的隐私闸与 `preWrite` 钩子保留**。

**2026-10-17 二次裁定：旧数据不迁移、直接删**（回答「`candidates` 表与提升链列是保列免迁移还是走版本迁移」）：

- **不写任何数据迁移路径**。新 schema 直接不带 `candidates` 表与提升链那几列（不再为兼容旧库保留列）。
- 既有旧库不做数据搬家：因格式与指纹 / 版本已变，旧库本就打不开；需要清空时走 `migrate({from: "v1", mode: "drop"})`（删库文件与 `-wal` / `-shm`，不备份、不静默删）或用户自己删文件。本机那个单库 `~/.dsh/memory-base/memory.db` 在新形态下同样不再被打开。
- 随之取消的前置：偏好分析不再需要「落地前在 profile 打开 `tiers`」（层级已恒开启）。

**2026-10-17 三次裁定：层级不加开关**（用户口径「不加开关了，一直开启」）：

- 删掉 `tiers.enabled`；层级**恒开启**，不再有「单库形态」，`dbPath` 与 `MEMORY_DB_PATH` 这个单库落点随之失去意义（也失去 `dbPath: ":memory:"` 的不落盘模式；测试改用临时目录）。
- 层级配置面收敛为路径与项目参数：`dshHome` / ~~`sessionDir`~~（**后被决策项 11 删除**：S 层落点改由本插件自算，不再需要配置项）/ `projectRoot` / `journalMode`；跨项目 P 库（`crossProjectRoots`）已按用户 2026-10-17 裁定去掉（随提升链一并取消）。
- 层不可用时（如拿不到宿主会话目录）不再静默退化为单库，而是写该层直接报错（读则跨可用层取）。

**2026-10-17 四次裁定：去掉冗余与语义列，本包只负责存储**（回答 G1 / G2 / G3，用户口径「本插件只负责存储，逻辑和语义交给上层插件」）：

- **G1 去掉冗余机制**：运行期分类闸（未注册拒写）、兜底分类 `defaultKind` 与「U 层禁落兜底」三条一并去掉（写只能经句柄，而句柄必绑已注册 kind，这三条再无触发路径）；`preWrite` 与隐私闸保留为库核心的存储侧约束。
- **G2 去掉语义列**：`origin` / `summary` / `category` / `target` 四列一并去掉。保留的列为 `id` / `source_id` / `project` / `title` / `content` / `content_hash` / `importance` / `session_id` / `created_at`。
- **G3 表去留**：`candidates` 表与 `doc_index` 表直接删；`sources` / `chunks` 作为**本包自己的存储布局**保留（**订正 2026-10-17 第二轮**：原文写的理由是「`output-compress` 的同库直写依赖它们，见 `README.md:112`」，该前提不成立 —— 该包自持 `digest.db`、改经句柄 `put` 入库，不直写本包的表；保留的实际理由是 `src/knowledge.ts:541-560` 与 `:579` 的本包写入路径仍在用）。
- 连带影响：`ScopePutInput` 不再有 `target`，`list` / `search` 的过滤面也不含它；`output-compress` 原先靠 `category` / `target` 标记行归属的做法随之失去依据 —— 但**已核实它并未真这么写**（自持 `digest.db`，行归属由 `kind: "digest"` 表达），已记在项目级 `docs/BACKLOG.md`「`output-compress` 接入 memory-base 作用域句柄（`promote` 取消后的 I→S 推送路径重定）」里。

**保留不另问**（属「读写」的一部分）：库核心的隐私闸（凭据 / 私钥形态命中整条拒绝）与注册方 `preWrite` 钩子、一库一指纹的守卫。

### 接口设计

决策项 1　按扩展隔离做成哪一档

- a) 只做表级：一类一张表，不对写入加权限
- b) **写入作用域句柄**：`registerKind(spec)` 返回 `MemoryScope`，句柄绑定本扩展的 kind 与可写层；写入与删除只经句柄
- c) 每扩展独立库与配额

**选定 b**。理由：服务面 `ctx.get('memory')` 拿不到调用方身份，写权限只能做成能力式 —— 谁持句柄谁才能写那个 kind；a 挡不住任何扩展改写别人的 kind，等于没有隔离；c 要引入多库与配额管理，与「只保留分层」的定位不成比例。

决策项 2　全局面（`ctx.get('memory')`）保留哪些键

- a) 注册与元信息 + 全局读：`registerKind` / `checkPrivacy` / `getSummary` / `whenReady` / `usage` / `migrate` / `search` / `list`
- b) a 但不给全局 `list`
- c) 不给全局读，读也只经句柄

**选定 a**（依据用户 2026-10-17 裁定「读可以全局」）。全局面**不含任何写入与删除**：`put` / `forget` 只经句柄。`list` 给全局的直接好处是补上原「按 kind 列举」的缺口 —— 它可按 `kind` / 层 / 项目过滤，不给 `kind` 时就是跨 kind 列举（现行 `targetRows` 做不到，见调研 4）。

决策项 3　隔离的边界

- a) **只隔离写**：`put` / `forget` 需句柄，读全部全局可用
- b) 读写都只经句柄

**选定 a**（用户 2026-10-17 裁定）。理由：隔离的机械落点本来就只有写侧（读不改变数据）；代价是任何扩展都能读到别人的 kind —— 单机单用户场景下可接受，且人面 TUI 因此零改造继续 `/memory search`。

决策项 4　句柄的方法与签名

- a) **只给写侧两个方法** `put` / `forget`（读从全局面取，带 `kind` 过滤）
- b) a + 便捷读 `list` / `search`（内部等价于全局读加 kind 过滤）
- c) 按层各开一组写方法

**选定 a**：

```ts
/** 写入作用域句柄（按扩展隔离的唯一机械落点）。 */
interface MemoryScope {
  readonly kind: string;
  readonly writableTiers: readonly Tier[];
  put(input: ScopePutInput): Promise<PutResult>;
  forget(refs: readonly { tier: Tier; ids: readonly (number | string)[] }[]): Promise<number>;
}

interface ScopePutInput {
  content: string;
  tier?: Tier;          // 缺省 "session"；不在 writableTiers 内 → 拒写
  project?: string;
  title?: string;
  importance?: number;  // clamp 1..5，可被 preWrite 建议覆盖
  source?: { kind: string; ref?: string; label?: string };
  sessionId?: string;    // 写 S 层时必需（决策项 11：落点由本插件自算）
}
```

全局读面（决策项 2）：

```ts
list(opts?: { kind?: string; tier?: Tier; project?: string; limit?: number; offset?: number }): Promise<StoreRow[]>;
search(opts: { query: string; kind?: string; tier?: Tier; project?: string; limit?: number; fuzzy?: boolean }): Promise<SearchHit[]>;
```

`StoreRow` / `SearchHit` 都带 `kind` 与 `tier` 标签（跨库跨表合并时必需）。理由：a 让「隔离」的机械面恰好等于写侧，与用户口径一致；b 的便捷读只是语法糖，却会让句柄看起来又成了读权限；c 的方法数翻三倍。`forget` 保留旧名以减少改动面，但语义改为真删并返回删除条数（修掉单库恒返 0 的缺口）。

决策项 5　扩展声明面（`KindSpec`）收到什么

- a) `{ kind, table?, writableTiers?, preWrite? }`
- b) 保留现行全量 `{ kind, table?, columns?, eventTypes?, preWrite?, routes? }`
- c) 只留 `{ kind, preWrite? }`

**选定 a**。理由：`eventTypes` 服务于已被取消的事件沉淀、`routes` 服务于跨分类检索取舍（读已全局，不再需要取舍）、`columns` 声明的扩展列本来就写不进去（INSERT 列固定，偏好分析 R1 已证），三者随本轮取消；`writableTiers`（缺省 `["session"]`）是写侧隔离在层维度的落地 —— 想写 P / U 必须在注册时显式声明，配合 `preWrite` 构成偏好分析 D18 要的硬闸。

决策项 6　分层与 kind 的关系

- a) 句柄绑定 kind，层由每次调用给（一个 kind 在每层各有一张同名表）
- b) 句柄绑定 (kind, tier) 对

**选定 a**。理由：与现行「跨层同构、一类一张表」的结构一致；b 会让同一扩展持多个句柄，且 `forget` 的 `{tier, ids}` 形状也说明层是调用参数而非句柄维度。

决策项 7　单库模式与 `tiers` 缺省

- a) 保持缺省关闭；单库模式下没有层级，`tier` 参数被忽略（写明口径）
- b) 要求必须开 `tiers`

**~~选定 a~~（已由 2026-10-17 二 / 三次裁定取代）**。原理由：`README.md:76` 的既有理由 —— 不静默在项目里建 `.dsh/`、不在家目录建库。
**取代者（2026-10-17 二次裁定）**：层级**缺省开启**，但库文件**惰性创建**（只在实际需要写时才创建） —— 原反对理由（静默建库）由「懒创建」消解，故不再需要「缺省关闭」；同时取消「偏好分析落地前需在 profile 打开 `tiers`」这条前置。
**再取代（2026-10-17 三次裁定）**：连开关也不加 —— 层级**恒开启**，不存在单库形态，`tiers.enabled` 与 `dbPath` 一并去掉（见「范围裁定」的三次裁定）。

决策项 8　瘦身与偏好分析的顺序（沿用 D20）

- a) **先瘦身**，偏好随后按新面实现
- b) 先做偏好（正文自持），瘦身后迁一次

**选定 a**。理由：D20 的三条理由仍成立，且本轮接口重设后偏好分析正是这套写入句柄面的第一个消费方。

决策项 9　TUI 与 `output-compress` 的处置

- a) 本任务只改 memory-base；两条消费链各追加 / 扩写条目交其它 agent
- b) 本任务连消费方一并改（跨模块）

**选定 a**。理由：用户已指示不开新 worktree，跨模块改动会突破范围；两条条目已在「规划」里列出，实现阶段同步回写它们的作用域。

决策项 10　模型侧查询工具的形态（用户 2026-10-17 裁定：推翻「不注册模型侧工具」的定位，提供一个给模型的查询工具）

- a) 单工具 + `action` 分派：`memory_query` 取 `action: "search" | "list"`
- b) 两个工具：`memory_search` + `memory_list`
- c) 每个扩展各暴露只查自己 kind 的工具（原口径）

**选定 a**：

- 工具名 `memory_query`（域在前、动作在后，与 `ast_query` / `hash_edit` / `code_map` 同风格；宿主安装树内无同名工具，仓内只有 `archive/PI-DSH-FEATURE-COMPARISON.md:97` 把 `memory_search` 记作 PI 侧工具名与「缺口」）。
- `action`：`"search"`（缺省，全文检索）/ `"list"`（结构化列举）。
- 参数：`query`（`action=search` 必填）、`kind?`、`tier?`（`"session" | "project" | "user"`，缺省全部层）、`project?`、`limit?`（缺省 10，clamp 1..100，沿用既有 `search` 口径）、`fuzzy?`（仅 search）、`offset?`（仅 list）。
- 输出：带 `kind` 与 `tier` 标签的结构化行（`title?` / `content` / `importance` / `createdAt`），超限截断并在结果里标明；`description` 写清「只读、跨全部扩展、按需收窄 `kind` / `tier` / `project`」的选择成本。
- 安全面：参数里没有文件路径与命令文本，故**不进** `security-guard` 的两张登记表。
  理由：a 与前一日（2026-10-16）herdr-pane 的「单工具 + action」取舍同向（避免工具面膨胀），且 search 与 list 共用同一套过滤参数；b 会把两个近乎同形的 schema 摊成两份；c 与「读全局」的裁定冲突。写侧仍不对模型开放 —— 模型只读，写权限留在各扩展的句柄上，这也让「按扩展隔离」保持可解释。

决策项 11　S 层落点的取得方式（2026-10-17 用户三次追加裁定）

- a) 句柄收 `cwd?`，memory-base 自己经 `session-paths` 推导
- b) ~~句柄收 `sessionDir?`，调用方经 `session-paths` 取好再传~~
- c) ~~句柄只收 `tier` + `sessionId`；memory-base 自己取 cwd 并算路径~~
- d) **句柄只收 `tier` + `sessionId`；`session-paths` 提供 `sessionDirFor(sessionId)` 直接给出目录（取 cwd 也收在它内部）**

**~~选定 b~~ → ~~选定 c~~ → 选定 d**（用户 2026-10-17 依次裁定：先「可以」采纳 b，再「保留 sessionId 作为参数」定为 c，最后问「为什么 `session-paths` 不能给路径，还需要自己算」并裁定「改成按照这个」）。理由：① 落点仍只在一处解析，**会话内一致性由结构保证**；② 调用方与 memory-base **都不碰路径、也都不认识宿主会话服务** —— memory-base 只把 `sessionId` 交给 `sessionPaths.sessionDirFor`，取 cwd（`ctx.sessions.get(id).header.cwd`，`docs/host/DSH-CTX-API.md:22-30`）这一步收在 `session-paths` 内部，宿主布局知识集中在一个包；③ 同一方法对 `output-compress` 的「`digest.db` 每会话一个文件」同样适用（它处理事件时本来就有 `session.id`，`src/hooks.ts:161-162`，不必再读 `header.cwd`）；④ 纯函数三件（`projectKey` / `projectDir` / `sessionDir`）保留，供显式带 cwd 的调用方与对拍测试。

**代价一条**：`session-paths` 从「零依赖纯函数包」变成「纯函数 + 一个依赖宿主 `sessions` 的解析方法」; `sessions` 缺失时该方法按明示例外报错, 纯函数不受影响。

**为什么身份必须显式给**：同进程内插件实例是**共用**的（组合行每进程挂载一次，会话是运行期 `ctx.sessions.create` / `fork` 产生的对象），同一进程里可以同时存在主会话与它委派的子代理会话（基础组合挂的是 `subagent-spawn-in-process` 与 `subagent-fork-in-process`，见 `dsh-base/cordis.patch.yml:352-358` 与 `dsh-subagent-spawn-in-process/README.md:79`），因此没有「当前会话」这种环境量可以替代 `sessionId`。

**降级链（明示例外，不退化、不静默换路径）**：写 S 层而 `sessionId` 缺失 → 报错；`sessionPaths.sessionDirFor(id)` 解析失败（会话取不到 / 宿主 `sessions` 缺失 / `session-paths` 未挂载）→ 报错。配置 `sessionDir` 随之**删除**（要改 sessions 根就改 `session-paths` 的配置，一处生效）。

**同进程多会话的后果（新增口径）**：memory-base 一个实例服务全部会话，S 层必须**按会话惰性打开并缓存**（同一进程可能同时开着主会话与子代理会话的 `session.db`），首次打开写路径日志；缓存策略与上限在实现时定（建议只缓存最近若干个，其余写后关闭）。

## 规划

### 实现前冻结的接口（消费方按此写）

**分层与落点**: `Tier = "session" | "project" | "user"`; S 库 = `<sessionDir>/session.db`（**经 `sessionPaths.sessionDirFor(sessionId)` 解析**, 取 cwd 在 `session-paths` 内部完成, 决策项 11）· P 库 = `<projectRoot>/.dsh/project.db` · U 库 = `<dshHome>/memory-base/user.db`。层级恒开启、无开关、无单库模式; **库惰性创建**（首次写该层才建）; 首次打开某层库把 `tier` 与解析到的路径写日志。

**写入句柄**（`registerKind` 返回）:

```ts
interface MemoryScope {
  readonly kind: string;
  readonly writableTiers: readonly Tier[];
  put(input: ScopePutInput): Promise<PutResult>;
  forget(refs: readonly { tier: Tier; ids: readonly number[] }[]): Promise<number>;
}
interface ScopePutInput {
  content: string;
  tier?: Tier;            // 缺省 "session"
  project?: string;
  title?: string;
  importance?: number;    // clamp 1..5；可被 preWrite 建议覆盖
  source?: SourceRef;
  sessionId?: string;
}
interface PutResult {
  ids: number[];          // 拒写时为空
  sourceId: number;
  created: number;
  skipped?: { reason: string };
}
```

**错误形态**（本轮定型）: 参数级与权限级一律**抛错**（`Error`, 文案带 kind 与 tier）—— 未注册 kind · `tier` 不在 `writableTiers` · 写 S 层但拿不到 `sessionDir`; **内容级闸门不抛错**, 走 `PutResult.skipped`（隐私闸命中 / `preWrite` 拒）。`forget` 真删并返回条数。

**声明面**:

```ts
interface KindSpec {
  kind: string;
  table?: string;
  writableTiers?: readonly Tier[];   // 缺省 ["session"]
  preWrite?(input: KindWriteInput): KindVerdict | Promise<KindVerdict>;
}
interface KindVerdict { accept: boolean; reason?: string; importance?: number }
```

**给消费方的一条提醒（2026-10-17）**：`preWrite` 的入参 `KindWriteInput = {content, title?, project, kind}` **不含 `tier`** —— 需要「按层拦截」的消费方拿不到层，**只能拆 kind**。先例：`preference-analysis` 用 `preference`（`writableTiers: ["project"]`，归纳路径）+ `preference_user`（`writableTiers: ["user"]`，只由用户显式动作调用）两个 kind，让**句柄本身当闸门**；若将来要给 `preWrite` 加 `tier`，仍需另解「同一层里区分归纳还是显式动作」，所以本轮不改 `KindWriteInput`。

**全局面** `ctx.get('memory')` 八键（无写无删）:

```ts
interface MemoryService {
  registerKind(spec: KindSpec): MemoryScope;              // 按需建表，故同步
  checkPrivacy(text: string): string | null;              // 命中返回原因，否则 null
  getSummary(opts?: { kind?: string; tier?: Tier; project?: string }): Promise<SummaryReport>;
  whenReady(): Promise<void>;
  usage(): Promise<{ tier: Tier; path: string; bytes: number }[]>;   // 只报已创建的库；容量三字段随逐库上限取消而删
  migrate(opts: { from: "v1"; mode: "drop" }): Promise<MigrateResult>;  // 无 dbPath（无单库模式）
  list(opts?: { kind?: string; tier?: Tier; project?: string; limit?: number; offset?: number }): Promise<StoreRow[]>;
  search(opts: { query: string; kind?: string; tier?: Tier; project?: string; limit?: number; fuzzy?: boolean }): Promise<SearchHit[]>;
}
interface StoreRow {
  id: number; kind: string; tier: Tier; project: string; title: string | null;
  content: string; importance: number; sourceId: number | null; sessionId: string | null; createdAt: number;
}
interface SearchHit extends Omit<StoreRow, "sourceId" | "sessionId"> { score: number }
```

`StoreRow` 与 `SearchHit` 为本轮新定型: 列集随「删无消费方列与四语义列」收敛, 两类都带 `kind` 与 `tier` 标签。`SummaryReport` / `MigrateResult` 形状沿用现行（本轮不改）。

**模型侧工具** `memory_query`（只读）: `action`（`"search"` 缺省 / `"list"`）· `query`（search 必填）· `kind?` · `tier?` · `project?` · `limit?`（缺省 10, clamp 1..100）· `fuzzy?`（仅 search）· `offset?`（仅 list）; 输出带标签行（`title?` / `content` / `importance` / `createdAt`）, 超限截断并在结果里标明; `description` 写明只读与收窄成本; **不进** `security-guard` 登记表。

**删除面（消费方不要再引用）**: `remember` · 全局 `forget` · `promote` · `candidates.*` · `setLlmCaller` · `consolidate` · `lastConsolidation` · `enforceLimits` · `rescanDenied` · `scanDocs`; `registerKind` 不再返回 `RegisteredKind`（改返回句柄）。

本轮（调研 + 决策 + 接口设计）改动文件清单：

- `memory-base/docs/BACKLOG.md`（本条目：标〔进行中: 2026-10-17〕+ 尾注记录 2026-10-17 的范围重定）
- `memory-base/docs/implementation/2026-10-17-slim-and-storage-surfaces.md`（本文件）
- `TUI/docs/BACKLOG.md`（途中发现：TUI 侧条目）
- `docs/BACKLOG.md`（途中发现：`output-compress` 条目，以及 security-guard 任务追加的一条）

实现阶段（待用户审定本轮设计后执行）改动文件清单：

- `memory-base/src/scope.ts`（新增）：`MemoryScope` 实现 —— 绑定 kind 与 `writableTiers`，把 `put` / `forget` 转发到 `kb` / `tiers`，越权层与未注册 kind 一律拒（带原因）
- `memory-base/src/index.ts`：全局面收到 `registerKind` / `checkPrivacy` / `getSummary` / `whenReady` / `usage` / `migrate` / `list` / `search`（后两者为跨 kind 只读，带 `kind` 过滤）；`registerKind` 返回句柄；删 `remember` / `forget` / `promote` / `candidates.*` / `setLlmCaller` / `consolidate` / `lastConsolidation` / `enforceLimits` / `rescanDenied` / `scanDocs`；**配置面去掉 `tiers.enabled` / `dbPath` / `MEMORY_DB_PATH` / `defaultKind`**（三次裁定：无开关、恒分层、无单库模式；四次裁定 G1：无兜底分类），保留 `dshHome` / `projectRoot` / `journalMode`（`sessionDir` 随决策项 11 一并删除）
- `memory-base/src/tiers.ts`：**层级恒开启 + 库惰性创建**（`TierSet.open` 改为只解析路径、不 `openStore`，首次写到某层时才建 / 打开；`usage()` 只报已创建的库）；**S 层落点经 `sessionPaths.sessionDirFor(sessionId)` 解析（决策项 11），按会话惰性打开并缓存**，首次打开某层库时把解析到的路径写日志；写入路由去掉 `origin` 条件，改为「按 `tier` 直写 + 目标层不可用时抛错」；写入口改为只从句柄进；删逐库容量守卫与跨项目 P 库（`otherProjectRoots` / `crossProjectRoots`，已裁定去掉）
- `memory-base/src/knowledge.ts`：新增按 kind 列举（`listRows`）；删 `touch` / `setImportance` / 淘汰与压缩族（`staleCandidates` / `budgetCandidates` / `boostCandidates` / `compress` / 相关上限）与 `last_referenced` 的维护写点
- `memory-base/src/router.ts`：`KindSpec` 收到 `{ kind, table?, writableTiers?, preWrite? }`；删 `eventTypes` 认领、`routes`、兜底分类与 U 层禁落兜底（G1）；检索并集改为「按 `kind` 过滤的全局读」
- `memory-base/src/schema.ts`：**直接删** `candidates` 表、`doc_index` 表与全部无消费方的列（提升链的 `promoted_to` / `promoted_from` / `reviewer` / `reviewed_at` / `projects`、失去消费方的 `last_referenced`、四语义列 `origin` / `summary` / `category` / `target`），不写数据迁移路径、也不为兼容旧库保列（二次与四次裁定）；保留 `sources` / `chunks` 两表及其 FTS 触发器（**本包自己的来源与分块布局** —— `src/knowledge.ts:541-560` 的写入路径与 `:579` 的分块插入仍在用；**订正 2026-10-17 第二轮**：原文写的保留理由是「`output-compress` 同库直写依赖」，该前提不成立 —— 它自持 `digest.db` 并改经句柄 `put` 入库，不再直写本包的表，见其追踪文档的调研 01/02）；旧库清空走 `migrate({from: "v1", mode: "drop"})`
- `memory-base/src/tools.ts`（新增）：`memory_query` 的工具定义（`parameters` JSON Schema、`output.schema` 与 `render`）、`description` 里的选择成本与只读边界（决策项 10）；在 `src/index.ts` 经 `ctx.tools.register` 注册
- 整文件删除：`src/promote.ts`、`src/hooks.ts`、`src/memory.ts`、`src/writepolicy.ts`、`src/consolidate.ts`、`src/doc-index.ts`、`src/budget.ts`
- `memory-base/tests/`：随各自面下线删 `promote` / `hooks` / `hooks-rules` / `writepolicy` / `memory` / `doc-index` / `consolidate` / `capacity` / `budget` / `rescan` 十个用例文件；改写 `tiers` / `bundle-tiers` / `kinds` / `exposure` / `knowledge`（`kinds.test.ts` 随 G1 删去未注册拒写 / 兜底分类 / U 层禁兜底的断言，保留按需建表与 `preWrite` 两类）；新增用例 —— 写侧：`put` 指定层、`writableTiers` 拒绝越权层、`forget` 真删返回条数、`preWrite` 拒写与建议 `importance`；读侧：`list` 能枚举本 kind 全部行并可按 `kind` / 层 / 项目过滤、`search` 跨 kind 与按 kind 过滤；工具侧：`memory_query` 两种 `action` 各一例 + `limit` clamp 与截断标注 + 无参数缺省行为
- `memory-base/README.md` + `docs/DESIGN.md`：按新定位重写 —— 含订正 `README.md:133` 的例数与 `:141-142` 的实施状态（见调研 11），以及改写 `:7` 「本插件不注册模型侧工具」这句定位表述（决策项 10 已推翻它）

明确不做：不引入多库与配额（决策项 1 选 b 不选 c）；不做事件沉淀与文档索引的替代实现（移出本包，需要时另立条目）；**不做模型侧写工具**（模型只读，写权限留在各扩展的句柄上）；**不写数据迁移路径**（旧表旧列直接删，旧库清空走 `migrate` 的 drop）；不动 TUI 与 `output-compress` 的代码；不改 `docs/STATUS.md`。

**随之需要同步的两条既有条目**（按标题引用，不写 BACKLOG 编号）：

- `docs/BACKLOG.md`「`output-compress` 接入 memory-base 作用域句柄（`promote` 取消后的 I→S 推送路径重定）」—— **2026-10-17 已按用户指示回写两次**：第一次改标题与正文为「注册自己的 kind + 持句柄 `put`」「`promote` 调用点删除或改写」；第二次按 output-compress 任务的调研**订正前提** —— 该包其实自持 `digest.db`（决策 D60），并不直写 memory-base 的行，「语义列被删导致行归属丢失」这个问题不存在，真正的耦合只有 `registerKind` 与 `promote`（只用于 `is_error` digest）。
- `TUI/docs/BACKLOG.md`「处置 `/memory review` 审阅面板与 `candidates` 适配（候选队列下沉后失去数据源）」—— **用户 2026-10-17 指示「暂时先不做」**：本轮不回写、也不改其作用域。**已知后果（有意接受的一段窗口）**：memory-base 重设落地后，TUI 的 `/memory add`（走 `remember`）与 `/memory review`（走 `candidates.*`）会指向已删除的服务面键而失效；`/memory search` 不受影响（全局只读查询保留）。要消除这段窗口，就得把该条目的作用域扩为「`/memory` 全命令面适配新接口」（`add` 需持写入句柄）后再做。

### 任务拆分（7 步, 每步带中间验证）

1. **schema 与迁移**（`src/schema.ts`）—— 删 `candidates` / `doc_index` 两表与无消费方列（提升链四列 + `projects` + `last_referenced` + 四语义列 `origin` / `summary` / `category` / `target`）; 保留 `sources` / `chunks` 与 FTS 触发器; 不写迁移路径, 旧库走 `migrate({from: "v1", mode: "drop"})`。验证: 新建内存库能建全表; schema 相关用例通过。
2. **知识层读写**（`src/knowledge.ts`）—— 新增按 kind 列举 `listRows`（可按层 / 项目过滤）; 删 `touch` / `setImportance` / 淘汰与压缩族 / `last_referenced` 维护写点。验证: 新增读侧用例（枚举本 kind 全部行、按 kind 与层与项目过滤）。
3. **注册表与句柄**（`src/router.ts` + 新增 `src/scope.ts`）—— `KindSpec` 收窄到四项; `registerKind` 改返回句柄; 按需建表; 拒写路径与错误形态（参数级抛错 / 内容级 `skipped`）; `preWrite` 判定链与 `importance` 建议。验证: 写侧用例（`put` 指定层 · `writableTiers` 拒越权层 · `preWrite` 拒写与建议 importance · `forget` 真删返回条数）。
4. **层级与落点**（`src/tiers.ts`）—— 恒开启; `TierSet.open` 只解析路径、不 `openStore`; 首次写某层才开库; **S 层落点经 `sessionPaths.sessionDirFor(sessionId)` 解析**（决策项 11）; **按会话惰性打开并缓存**（同进程多会话）; 首次开库写路径日志; 删逐库容量守卫与跨项目 P 库。验证: `tiers` / `bundle-tiers` 用例改写通过 + 新增三例（未给 `sessionId` 写 S 层即报错 · `sessionDirFor` 解析失败（服务缺失 / 会话取不到）即报错 · **同一进程两个会话并写, 各落各库**）。
5. **服务面与删面**（`src/index.ts` + 删文件）—— 全局面收敛到八键; 删 `remember` / 全局 `forget` / `promote` / `candidates.*` / `setLlmCaller` / `consolidate` / `lastConsolidation` / `enforceLimits` / `rescanDenied` / `scanDocs`; 配置面去掉 `tiers.enabled` / `dbPath` / `MEMORY_DB_PATH` / `defaultKind` / `crossProjectRoots`; 整文件删七个（`promote` / `hooks` / `memory` / `writepolicy` / `consolidate` / `doc-index` / `budget`）, 用例删十个。验证: `npm --prefix memory-base run check` 无残留引用 + 改写后的用例全绿。
6. **模型侧工具**（新增 `src/tools.ts`）—— `memory_query` 的 `parameters` / `output.schema` / `render` 与只读 `description`; 经 `ctx.tools.register` 注册, `ctx.tools` 缺失时告警降级。验证: 工具侧用例（两种 `action` 各一例 + `limit` clamp + 无参数缺省 + 截断标注）。
7. **文档与收口**（`README.md` + `docs/DESIGN.md`）—— 按新定位重写（含例数与实施状态订正、改写「本插件不注册模型侧工具」那句）。验证: 人工对读 + 根三件套全绿。

### 实现阶段的验证口径（怎么跑）

- **单测**: `npm --prefix memory-base run test`（用例文件由 19 收敛到约 12; 新增写侧 / 读侧 / 工具侧三组, 其中写侧含「两会话并写各落各库」与三条降级报错）。
- **机械**: 根 `npm run check` + `npm run build` + `npm run test` 三件全绿; `npm --prefix memory-base run check`。
- **真机**: 重启 `dsh --profile fff`, 观察日志里的层库路径; 让 `output-compress` 推一条 `is_error` 摘要（或手写一次 S 层写）确认 S 库落在会话目录; 跑一次 `memory_query` 看返回与截断标注。
- **旧库**: `~/.dsh/memory-base/memory.db`（约 426 MB）按「旧数据不迁移直接删」处理 —— 新落点不同, 旧文件成为孤儿; **不自动删**（不静默删数据）, 由用户择时清理, 需要时在备份后跑 `migrate({from: "v1", mode: "drop"})`。
- **不做**: 不验数据迁移路径（本轮不写）; 不验模型侧写入（不开放）; 不动 TUI 与 `output-compress` 的代码。

### 收尾动作（实现完成时）

- 条目「按『只提供分层记忆内容』的新定位瘦身，并补四项纯存储面（指定层写入 / 按 kind 列举 / 真删 / `registerKind` 去留）」标「完成」并从 `memory-base/docs/BACKLOG.md` 移除; 本文件移入 `memory-base/docs/archived/`。
- 文档回写: `memory-base/README.md` + `docs/DESIGN.md`（按新定位重写）; 根 `README.md` + `README.zh.md` 的 memory-base 功能段; `docs/STATUS.md` 由用户择时更新, 本任务不动。
- 两条下游条目: `output-compress` 那条已按其任务回写（实现归它自己）; TUI 那条按用户指示**暂不做**, 破损窗口（`/memory add` 与 `/memory review` 失效）已在「规划」末条记明。
- 仓库外: profile 里 memory-base 条目的 `dbPath` 与 `tiers` 行按新配置面清理 —— 属仓库外改动, 实现时取得明确要求后执行。
- 旧库文件（约 426 MB）不静默删, 交用户择时处理。
- ~~**待下一轮回写 `session-paths`**（该包文档现仍只有纯函数三件与 `ensureSessionDir`）: 新增 `sessionDirFor(sessionId)`（内部经宿主 `sessions` 取 cwd）, 见本文件决策项 11 —— 归该包的下一轮修订, 不在本轮。~~ **已于 2026-10-17 第二轮办结**：`session-paths` 的追踪文档已把 `sessionDirFor(sessionId): string` 写进冻结接口（同步、内部经宿主 `sessions` 取 `header.cwd`、缺失或会话取不到即抛、不建目录），并补了边界语义第 5 条、依赖读取方式、任务拆分第 3 步与四态单测；同时把 output-compress 与 auto-approve 文档里「自己读 `header.cwd` 再调 `sessionDir(cwd, id)`」的旧口径改成 `sessionDirFor(sessionId)`。

## 实现记录

（本轮为决策轮，未进入实现；待用户审定决策后按「规划」的清单执行。）

## 偏差

无（本轮只做调研与决策，未承诺实现动作）。

## 测试与证据

本轮为决策轮，未改代码，故未跑 `check` / `build` / `test`；调研阶段的事实证据：

- 子代理只读核查（本包内运行 + 实读），关键实测：`commandKeys` 类结论不适用本包；本包相关的实测为 `forget` 恒返 0 的代码路径、`promote.ts` 仅一处 import、全仓 `setLlmCaller` 只有定义与透传、`output-compress` 两处可选依赖调用点。
- 测试文件与例数：`ls memory-base/tests | wc -l` = 19；`grep -c "^test(" tests/*.ts` 合计 103（对照 `README.md:133` 的「80 例」）。
- `git grep -n conclusion -- ':!.worktree'`：只在偏好分析设计文档命中（调研 7）。
- 未复读仓库外文件：`~/.dsh/profiles/fff/cordis.patch.yml` 的 `tiers` 配置现状沿用偏好分析设计 `:28` 的记录，未二次确认。

## 收尾

- 本轮不归档：条目保持〔进行中: 2026-10-17〕，本文件留在 `memory-base/docs/implementation/`，等用户审定决策后进入实现。
- 回写文档：本轮无（实现阶段才动 `README.md` / `DESIGN.md`）。
- 遗留项：范围已由用户 2026-10-17 重定（见「决策」的范围裁定，含同日二 / 三 / 四次裁定：层级恒开启且库惰性创建、旧数据不迁移直接删、不加层级开关且去掉单库模式、去掉冗余闸门与四语义列），旧的「瘦身范围 a/b/c/d」与「D19 四项」不再作为选项；接口设计（决策项 1 至 10）待用户审定后进入实现。两条途中发现的条目：`output-compress` 那条已按指示回写，TUI 那条按指示**暂时不做**（后果见「规划」末条）。原「偏好分析落地前需在 profile 打开 `tiers`」这条前置随层级恒开启而消失。**跨任务发现（2026-10-17，来自 output-compress 任务的调研 11）**：宿主未暴露「会话目录」读取面（`src/router.ts:10-11`），`sessionDirFor` 约定拼接函数存在但全仓无人调用（`router.ts:70-79`）；现行靠 `if (tierConfig.sessionDir === undefined) paths.session = dbPath`（`src/index.ts:346`）兜底，而本重设去掉了 `dbPath`、又恒开启层级 → **S 层将没有可推导的落点**（不配 `tiers.sessionDir` 就写不进 S 层，按三次裁定是「写该层直接报错」而不是退化）。**补充事实**：那个约定函数本身也算错了 —— `router.ts:70-79` 只做「去前导斜杠 + 分隔符换 `-`」，没有宿主那层 `--…--` 外壳与 `~XXXX` 转义，算出的目录不存在（真目录见 `~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/`）；宿主侧的编码实现在 `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` 的 `encodeSegment:853-865` / `projectKey:875-894` / `projectDir:902-905` / `sessionDir:912-914`，均不导出。
  **用户 2026-10-17 裁定**：新建一个插件复刻宿主函数、供其他插件共用（即在上面的选项里加一条 **e：经新插件 `session-paths` 的服务面取会话目录**，并取代选项 b 的「各自复刻」）。据此本条的 S 层落点改为「经 `sessionPaths.sessionDir(cwd, sessionId)` 推导」；该包未落地之前，S 层按「不可用即明示例外」处理（不退化、不静默）。条目见项目级 `docs/BACKLOG.md`「新增 `session-paths` 插件：复刻宿主的会话目录编码，供其他插件共用」。**该结论已被 2026-10-17 的追加裁定取代三次**（见决策项 11）：先是改为「调用方取好传入」, 最终定为「**`session-paths` 的 `sessionDirFor(sessionId)` 直接给目录**（取 cwd 收在它内部）」。因此本条**仍依赖 `session-paths`、实现顺序仍排在该包之后**; 原先「S 层没有可推导落点」的顾虑由「三条降级报错」与「不动配置 `sessionDir`」收口。
