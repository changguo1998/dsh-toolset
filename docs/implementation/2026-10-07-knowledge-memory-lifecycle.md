# 重新设计长期记忆（知识库 / 持久记忆）模块逻辑（接取条目：docs/BACKLOG.md「重新设计长期记忆（知识库 / 持久记忆）模块逻辑」）

状态：进行中（设计已定稿；实施阶段进行中，见文末「实施阶段」）　　开启：2026-10-07　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

以「记忆生命周期」为主线重梳 `knowledge-base`（含与 `output-compress` 的共库面），定稿 `knowledge-base/docs/DESIGN.md`。必须回答五个问题（对应条目正文的归入项）：

1. **写入面**：谁写 / 走哪条路 / 闸门放在哪一层（现状：闸门挂在调用方事件钩子，库核心 `put()` 无过滤，`output-compress` 直写完全不过闸）。
1. **分区与作用域**：`project` / `target` / `session_id` 的语义与检索隔离（现状：`project` 未配置，全库只有 `default`）。
1. **容量与淘汰**：预算 / 降级 / 硬淘汰 / 存量回扫（现状：`maxTokensPerProject` 缺省 0，库 601 MB 只增不减）。
1. **检索面**：双 FTS5 / fuzzy / 与官方 `session-query-sqlite` 的分工。
1. **共库契约**：与 `output-compress` 的写入与淘汰契约。

验收（条目原文）：`knowledge-base/docs/DESIGN.md` 修订定稿并**经用户确认**；由它拆出的实施条目各自可独立验收。

## 调研

来源：① 子代理只读代码侦察（`knowledge-base/src/*.ts`、`output-compress/src/kb-write.ts` + 宿主安装包 `@deepseek-ai/dsh-session`）；② 真库只读实测（`node:sqlite` `{readOnly:true}`，2026-10-08 03:45-03:48，库在活跃写入，计数会漂移）；③ 两包 `README.md` / `knowledge-base/docs/DESIGN.md`；④ `docs/archived/2026-10-05-kb-shared-write-parity.md`（前次调研，含 2026-10-05 库实测）。

### A. 写入路径全集（INSERT 只存在于两处：`knowledge.ts:254,273`、`kb-write.ts:202,218`）

| 路径 | 入口 | 三段闸门（`rules.ts`） | `budget.ts` 守卫 | 计入 `hooks.stats` |
| --- | --- | --- | --- | --- |
| SessionHooks | `hooks.ts:293 handle()` → `:308 kb.put()` | 是（类型 `:301`、内容 `:304`） | 是（`:325`，仅 `maxTokens>0`） | 是（`:318,321,332,333,338`） |
| WritePolicy.writeBack | `writepolicy.ts:73` → `:78` | 否 | 否 | 否 |
| WritePolicy.backfill | `writepolicy.ts:90` → `:96` | 否 | 否 | 否 |
| MemoryService.add | `memory.ts:73` → `:74` | 否 | 否 | 否 |
| ConsolidationService | `consolidate.ts:94 run()` → `:100` | 不 INSERT（只 `setImportance` / `evict` / `compress`） | 是（段 4 `:189`） | 否 |
| SharedKbWriter（output-compress） | `kb-write.ts:183 put()`；调用点 `output-compress/src/hooks.ts:378` | 否 | 否 | 否（自带 logger 计数） |

`kb.put` 在 `src` 内的调用者全集只有 4 处（`writepolicy.ts:78,96`、`hooks.ts:308`、`memory.ts:74`）。`writeBack` / `backfill` / `evictStale` / `promote` 在 `src` 内**无生产调用方**（只有 `demo/main.ts` 与测试），仅经 `bundle.policy` / `bundle.kb` 对外暴露。

### B. 闸门位置

- `rules.ts:48 compileRules()` / `:72 allowsType()` / `:80 checkContent()`；调用点只有 `hooks.ts:259`（构造期编译）、`:301`（类型）、`:304`（内容）——**闸门全部在 hooks**。
- 六类内置拒绝模式 `rules.ts:22-29`（PEM / `sk-` / GitHub token / `AKIA` / `Bearer` / `(password|passwd|pwd|secret|token|api_key) = value`），命中即整条拒绝（`:88-90`），自定义只追加、不能关闭内置（`:58`）。
- `Knowledge.put()`（`knowledge.ts:234-317`）参数 `PutInput`（`:27-37`）**无任何内容 / 类型 / 隐私过滤**；只有 importance clamp（`:236`）、`source.kind` 缺省（`:237`）、分块（`:238`）、去重（源级 `:241-245`、chunk 级 `:269-284`，**去重不区分 project**）。
- `budget.ts:32 enforceBudget()`，调用点只有 `hooks.ts:325` 与 `consolidate.ts:189`；`EVICT_STEP = 10`（`:29`）、`batch` 缺省 50（clamp 1..500）、`compressFirst` 缺省 true。

### C. 分区与作用域

- `project`：配置项 `index.ts:62`（`string | (() => string)`，函数形式在 `hooks.ts:199-200,306-307` 求值），**缺省 `"default"`（`index.ts:136`）**；函数形式下自动巩固退化为静态 `default`（`index.ts:100-101,152-153`）。
- `target`：`MemoryTarget = "user" | "memory" | "project" | "failure"`（`memory.ts:13`）；写直达路径**从不设 target**（`hooks.ts:308-316`）→ 事件条目 target 全 `NULL`；output-compress 恒 `"output-compress"`（`output-compress/src/hooks.ts:369`）。
- `category`：写直达取事件类型（`hooks.ts:169,175`）；output-compress 恒 `"output-compress"`。
- `session_id`：写直达写 `session.id`（`hooks.ts:283,314`），仅溯源、不参与唯一性（`hooks.ts:18-19`）。
- 逐函数 WHERE（**过滤参数几乎全可选，不传即全库**）：

| 函数 | 行号 | project | target |
| --- | --- | --- | --- |
| `kb.search` | `knowledge.ts:145-156,164-168,211-219` | 可选 | 可选 |
| `memory.search` | `memory.ts:119-126` | 可选（透传） | 可选 |
| `promote` | `knowledge.ts:508` | 必填 | 无 |
| `staleCandidates` | `knowledge.ts:360-362` | 必填 | 无 |
| `budgetCandidates` | `knowledge.ts:484-489` | 必填 | 无 |
| `boostCandidates` | `knowledge.ts:415-418` | 必填 | 无 |
| `targetRows` | `knowledge.ts:454-457` | 必填 | 必填非空 |
| `tokenBudgetUsage` | `knowledge.ts:395` | 必填 | 无 |
| 巩固合并分组 | `consolidate.ts:127-137` | 必填（先 `targetRows`） | 组键 |
| `MemoryService.findByText` | `memory.ts:161` | **无 project** | 必填 |
| `MemoryService.replace` | `memory.ts:95-106` | 参数不参与定位（README.md:94） | 靠 `findByText` |

- `GLOBAL_PROJECT = "__global__"`（`memory.ts:16`）只在 `memory.add` 缺 project 时使用（`:75`）；实测库中零行。

### D. 容量与淘汰

- `maxTokensPerProject`：`index.ts:66-67`，缺省 **0 = 不设限**；仅 >0 才传 budget（`index.ts:141-144`），同时作为巩固 `maxTokens`（`:167`）。单位 = 估算 token（1 token ≈ 3 字符，`budget.ts:20`；SQL = `SUM(LENGTH(content)/3) WHERE project = ?`，`knowledge.ts:392-399`）。
- **无任何整库容量上限**：所有容量函数以 `project` 为唯一作用域；因全库 project 只有 `default`，per-project 上限当前等价于整库上限。
- 触发点 `index.ts:151-190`：启动后一次（`onStart` 缺省 true）+ `compaction/end` / `compaction/summary` 后一次（缺省 true）；节流 `minIntervalMs` 缺省 **10 min**（窗口内直接跳过、不排队，`:162`）；失败只 warning。
- TTL 缺省 **30 天**（`consolidate.ts:59`）；`maxImportance` 缺省 **2**（`consolidate.ts:176`、`knowledge.ts:356`、`writepolicy.ts:112`）；巩固 `limit` 缺省 50（clamp 1..500）。
- 实际淘汰能力：只有 `autoConsolidate` 的 TTL 段（每次最多 50 条 TTL 候选）+ 段 4 容量守卫（`maxTokens>0` 才跑，缺省 0 → **不跑**）。**即 `importance >= 3` 的条目永不自动淘汰**（实测 1,419 条）。

### E. 检索面

- `kb.search(opts)`（`knowledge.ts:39-47`）：`query` 必填，`project` / `target` / `category` / `limit`（缺省 10，clamp 1..100）/ `fuzzy` 可选；**无 tokenBudget**（只在 `memory.search` 外壳）。
- FTS 模板 `knowledge.ts:164-168`：`SELECT c.*, bm25(<table>) FROM <table> JOIN chunks c ON c.id = <table>.rowid WHERE <table> MATCH ? [AND 过滤] ORDER BY score LIMIT ?`；表只有 `chunks_fts`（porter）与 `chunks_trigram_fts`（trigram），external content + TRIGGER 同步（`schema.ts:107,110,113-132`）。
- `fuzzy` 才叠 trigram（`:187-198`）；`LIKE` 兜底条件 `:203-206` = `hits.size < limit && (ftsFailed || query 含 CJK)`——**含 CJK 的查询即使 `fuzzy:false` 也走 LIKE**（与 README.md:84 一致），命中 score=0。
- `last_referenced` 刷新：`search` 命中批量 UPDATE（`:226-229`，含 LIKE 兜底）／`touch`（`:320-325`）／`put` 写入置 now（`:296`）／`MemoryService.replace`（`memory.ts:104`）。

### F. 共库面（`output-compress/src/kb-write.ts`）

- `resolveDbPath`（`:31-41`）：显式 config > `OUTPUT_COMPRESS_DB_PATH` > `KNOWLEDGE_DB_PATH` > `~/.dsh/knowledge-base/knowledge.db`（`:40`）。
- 逐列：`sources`（`:202-211`）= kind / label / ref / content_hash / chunk_count / created_at；`chunks`（`:218-246`）= source_id / project / target / category / title / content / content_hash / importance / session_id / last_referenced / created_at，**不写 summary**。
- 取值：importance = isError ? 4 : 2（`output-compress/src/hooks.ts:370`）；target / category 恒 `"output-compress"`（`:368-369`）；`source.kind` 恒 `"tool_result"`（`:373`）；project 来自它自己的 `project` 配置（缺省 `"default"`，`output-compress/src/index.ts:125`）。
- 自有去重：源级 `content_hash + kind`（`:189-193`）、chunk 级 `content_hash`（`:214-216,227-232`），与 knowledge-base 同键；**无内容闸门 / 无容量守卫**。
- 失败处理：指纹（`application_id` / `user_version`）与必备表校验，不符抛 `KbNotMountedError`（`:44,139-170`）；`busy_timeout=2000`（`:138`）；`put` 事务 BEGIN/ROLLBACK（`:194,259`）；上层按 1/2.5/5/10s 退避重试最多 4 次（`output-compress/src/hooks.ts:441-472`）。
- 硬约束（`kb-write.ts:4-5`）：**不引 knowledge-base 的 npm 依赖、不建表**；共享面 = 同一个 SQLite 文件。

### G. 与官方 `session-query-sqlite` 的分工现状

- `ctx.sessionQuery` 由 `session-query-sqlite` 提供（`docs/host/HOST-PACKAGES.md:111-112`；服务缝本身未单独挂载），能力面 = `searchSessions / searchEvents / listEvents / traceSession / readSession / readSurface`。
- `openAt` 选项**两份宿主文档都没有记载**，本仓只有旁证：`docs/ARCHITECTURE-REUSE.md:25,129`（缺省 `openAt: never` 未开启）、`:93`（可用 `openAt: first-search`）。
- 本仓消费方：`TUI/src/app/adapter/dsh.ts`（listSessions / listEvents / readSession / readSurface）、`session-title-cutoff/src/main.ts:230`；`knowledge-base` 不消费它。官方后端另**单独索引会话 cwd**（`dsh-session-query-sqlite/lib/index.js:92-104,127-140`）。
- 分工口径已在两包 README 写明（原始事件 vs 沉淀知识，互不合并结果）；未定的是「是否开启它的 FTS5」——属独立观察项。

### H. 真库实测（2026-10-08 03:45-03:48，只读）

库 = `~/.dsh/knowledge-base/knowledge.db`，`user_version=1`、`application_id=0x4b4e4f57`（指纹与 `kb-write.ts:17-19` 一致）。

| 指标 | 值 |
| --- | --- |
| 文件大小 | 600,711,168 B（≈ 573 MiB；`-wal` 另 8.3 MB） |
| `chunks` / `sources` | 52,786 / 42,728（同分钟内漂移，库在活跃写入） |
| project 分布 | `default` = 全部（distinct = 1） |
| target 分布 | `NULL` 52,169 / `output-compress` 617（**记忆域 user/memory/failure = 0 行**） |
| category 分布 | `tool/result` 51,245 / `output-compress` 617 / `todo/write` 355 / `approval/decided` 254 / `compaction/summary` 210 / `goal/change` 104 / `plan/mode` 2 / `feedback/record` 0 |
| importance 分布 | 2 → 51,367 / 3 → 925 / 4 → 495（**≥3 共 1,420 条不受 TTL 淘汰**） |
| `summary` 非空 | **0**（两条写路径都不写 summary，压缩降级从未跑过） |
| `last_referenced` | 全部 > 0 |
| created_at 区间 | 2026-09-15 00:52 → 2026-10-08 03:47（约 23 天） |
| 空间构成（`dbstat`） | trigram FTS data 365.9 MB（**61%**）/ `chunks` 表 171.9 MB / porter FTS data 52.4 MB / `sources` 5.7 MB / 索引 ~2.4 MB |
| 估算正文 token | 36,627,697（`SUM(LENGTH(content))/3`） |
| 凭据形态存量（按 `rules.ts:22-29` 六条正则精确匹配） | **91 条 chunk**：`key=value` 90 + `sk-` 3（有重叠）；PEM / GitHub / AWS / Bearer 均 0。按 category：`tool/result` 90、`output-compress` 1 |
| 增长速率 | 对比 2026-10-05 实测（533 MB / 49,831 chunks）：**+68 MB、+2,955 chunks / 3 天** ≈ 23 MB/天、985 chunks/天 |

### I. 宿主侧可读性（本轮新增，推翻一个既有假设）

- `session/event` 回调真实签名（`dsh-session/lib/types/index.d.ts:64`）= `(session: Session, event: SessionEvent)`，**第一个参数是完整 Session 实例**（发射点 `lib/index.js:1468` `callbackArgs = [this, event]`）；本仓 `hooks.ts:190-196,281-286` 把它**类型窄化成 `{ id: string }`**，只取 `session.id`。
- 事件载荷 = `{ type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp? }`（`docs/host/DSH-CTX-API.md:52-58`）——**载荷内没有 cwd / project / workspace**。
- `SessionHeader` 字段全集（`dsh-session/lib/types/types.d.ts:58-92`）：`version`(4) / `id` / `createdAt` / **`cwd?`（绝对路径）** / `parentSession?` / `isSeeded` / `origin?` / `delegationDepth?` / `agentPreset?`；`CreateSessionOptions.meta`（`:99-137`）同名字段折进 header（`lib/index.js:1703`，绝对路径校验 `:1044-1046`），**不进事件日志**。
- 进程内读路：`ctx.sessions.get(id).header.cwd`（`types/index.d.ts:447,452`）；`ctx.sessionQuery.listSessions()` 亦带（官方后端已索引）。本仓写入方 `TUI/src/main.ts:404` 传 `meta: { cwd: config?.cwd ?? process.cwd() }`。
- 结论：**cwd 可达，只是 knowledge-base 自己没读**；事件载荷不可达。

### J. 本机 profile 现状（fff）

`~/.dsh/profiles/fff/cordis.patch.yml:24-27`（knowledge-base）与 `:32-35`（output-compress）**各只有一条 `dbPath`**（同一个 `dshHomePath('knowledge-base/knowledge.db')`）；全文件无 `project` / `maxTokensPerProject` / `persistRules` / `autoConsolidate` 配置 → 两条路径全走代码缺省。

### K. `session/disposed` 的真实触发时机（2026-10-08 追问后核实）

- 宿主实现：`session/disposed` 由 `dsh-session/lib/index.js:1767 detachEntered()` 发出，调用点只有一处（`:1749` 的 `detach` 闭包，即 `sessions.enter()` 返回的 detach），语义是「会话从内存 store 移除」（`:1773` `store.delete(entry.id)` 后 `emitDisposed`）。
- `agent` 侧的释放会走到这条路径（`dsh-agent` 持有 `sessions.enter`）；本仓 TUI 退出时 `adapter.dispose()` 释放当前 handle（`TUI/src/main.ts:146,682`）→ 即**TUI 退出会触发 `session/disposed`**。
- 「会话被清理」是另一层：宿主持久化目录（JSONL + 分桶）被删除，属文件系统层面的生命周期；宿主是否提供删除 API 未查实。
- **会话目录核实（2026-10-08，回答「S 库能否放在宿主会话目录」）**：目录布局 = `~/.dsh/sessions/<cwd-转义>/<sessionId>/`，内含 `session.lock` 与 `session.v4.jsonl.zstd`（版本化文件名）。持久化包的 `fs.rm` 调用只针对**临时 / 迁移暂存文件**（`removeTemporary` / `removeCommittedTemporary`），**没有**目录级删除；`dsh-session` 类型与 CLI 里也**找不到「删除会话」的 API / 命令**。→ 结论：可以放，但「宿主删会话 → 目录消失」这条硬删除路径在当前宿主上**不会自动发生**（实际清理只有 7 天兜底或用户手动删目录），且「第三方文件与宿主文件同目录共存」未获宿主承诺。
- **当时的歧义（已解决）**：旧稿 §3.2 曾写「`session/disposed` 即清 S」，与「resume 保留会话记忆」冲突——该口径**已被 D4 取代**（dispose 只做提升收尾、不清数据）。

### 结论（设计必须处理的六条硬事实）

1. **闸门是调用方自觉**：三条 `kb.put` 路径（`writeBack` / `backfill` / `memory.add`）与 output-compress 的独立写入器都不过闸；库核心没有任何过滤点。
1. **分区事实上不存在**：库内 project 恒 `default`（profile 未配），target 只被 output-compress 占用；检索面 project / target 过滤全是可选参数，不传即全库——隔离既没写入侧基础，也没有查询侧默认。
1. **容量事实上不存在**：`maxTokensPerProject` 缺省 0、无整库上限；唯一自动淘汰是 TTL+importance≤2 的每轮 50 条，落后于 ~985 chunks/天的写入速率（库 3 天 +68 MB）。
1. **容量口径选错了维度**：61% 的空间是 trigram FTS 索引（366 MB），而现有预算是按正文 token 估算（36.6M tokens）——按 token 设限量不到主要成本。
1. **去重键与分区目标冲突**：`content_hash` 全局唯一 → 「A 项目写过的内容在 B 项目检索不到」，这是隔离落地时必须一并裁定的点。
1. **存量治理无路径**：91 条闸门上线前的凭据形态条目（含 output-compress 直写的 1 条）没有任何按规则回扫存量行的代码；`importance≥3` 的 1,420 条也不受任何自动淘汰。

## 决策

> 整理口径（2026-10-08）：按主题分组，编号 `Dn` **仅供阅读、本轮重编**（不用于外部引用；`DESIGN.md` 不引用编号）；已作废的决策移入末节「已作废」。

### 0. 用户给定的设计原则（2026-10-08）

1. 每个生命周期阶段有对应的库；2. 逐步概括提升层级；3. 层级越高，写入标准越严格。

「生命周期」指 **作用域**（会话 → 项目 → 用户，即这条记忆为谁服务、该活多久），**不是**时间长度或成熟度。

### 1. 生命周期与分层

| 条 | 决策 | 理由 / 备选 |
| --- | --- | --- |
| D1 | **分层模型**：S 会话 `session.db` / P 项目 `project.db` / U 用户 `user.db` 三个记忆库 + I 索引 `digest.db`（非记忆层）；T0 原始归宿主 | 按作用域分库同时给出寿命与写入标准；备选「按时间 TTL 分层」只解决「旧的删掉」，解决不了跨作用域串 |
| D2 | **命名与职责**：`knowledge-base` → `memory-base`（目录 / 包名 / 服务键 `ctx.get('memory')`），只做存储 + 基础管理（分层 / 路由 / 提升 / 淘汰 / 注册） | 「knowledge」偏功能；内容语义归上层插件（D13） |
| D3 | **存储位置与路由**：S / I → 宿主会话目录（不自建旁路目录）；P → 项目根 `.dsh/`；U → `~/.dsh/memory-base/`；**路由在包内**，调用方只见 `remember` / `search` / `review` | 位置与生命周期对齐；模型侧 / 用户侧不需知道一次会话碰几个文件 |
| D4 | **「会话结束」口径**：`session/disposed`（含 TUI 退出）**不清数据**，只做提升收尾；硬删除 = 宿主删会话目录 + 7 天兜底 | 宿主实测：`disposed` = 会话出内存 store，TUI 退出即触发；若即清会与 resume 冲突 |

### 2. 写入、闸门与提升

| 条 | 决策 | 理由 / 备选 |
| --- | --- | --- |
| D5 | **闸门在属主库核心**（一库一属主）；跨包只经提升接口 + 一份必须一致的隐私常量（带一致性测试） | 现状闸门挂在 `hooks.ts`，换调用方就绕过；备选「只加只读判定服务面」仍是调用方自觉，且 output-compress 依旧写别人的库 |
| D6 | **写入两条路径**：自动路径唯一入口 = S，逐级 S→P→U 且每跳审阅、禁止跳级；**用户明确指令**（`origin: user`）直达 P / U 免审 | 原则 1+3 的落地；高层内容风险高，必须有闸 |
| D7 | **提升判据**：I→S = `isError` 或被命中；S→P = 本会话命中 **或** 决策类事件 **或** 失败教训；P→U = 同一事实跨 ≥2 project **或** 显式确认 | 命中信号可能恒为假（实测 0 次）→ 判据必须带可退化的或分支 |
| D8 | **概括由 LLM 完成**：一次调用产出 title + 结论 + 建议分类；失败不提升、下次巩固重试 | 机械摘要质量不足；不降级混用两种质量 |
| D9 | **审阅形态与留痕**：按条提问（内容 + 依据 + 建议分类）；`reject` / `edit` 都可用（**权限按跳见 D28**） | 越往上越需要人的判断；U 直接影响跨项目行为 |
| D10 | **`origin: user` 必须可证**：除用户直接动作（TUI 命令 / 面板选择）外，必须先向用户提问确认；未提问的转写按自动路径走 | 防止 agent 自标豁免审阅 |
| D11 | **隐私底线跨包一致**：两包各持一份相同的六类形态模式常量 + 跨包一致性测试；profile 自定义模式属扩展面 | 两包不得建 npm 依赖，只能常量同步 |

### 3. 分类

| 条 | 决策 | 理由 / 备选 |
| --- | --- | --- |
| D12 | **分类注册制**：上层插件注册 `kind` + 扩展列 + 可选写入前钩子 + 可选**查询路由规则**；本包只提供基类列，**不限定表名、不硬编码分类名**；未注册拒写；兜底分类名来自配置 | 「偏好」「技能沉淀」等内容与语义归各自插件 |
| D13 | **分类 schema 变更归注册方**：结构 / 扩展列由注册方声明并维护版本，本包只给基类列并执行迁移 | 分类已交给其他插件 |

### 4. 检索、索引与文档

| 条 | 决策 | 理由 / 备选 |
| --- | --- | --- |
| D14 | **检索跨全域**：默认 = 本会话 S + 当前项目 P + 全局 U；跨项目 P **默认不读**，`crossProject` 显式开（候选由宿主会话索引的 distinct `cwd` 派生） | 不做检索隔离；跨项目扫描无全局索引、代价高 |
| D15 | **检索面 = 层 × 分类**：每层内所有已注册分类表都在并集；注册即自动纳入 | 跨全域不仅是不同等级，也包括不同数据表 |
| D16 | **检索前先判分类**：给了 `kind` 只查该类；未给则按各分类的查询路由规则定参与集合（未声明的作通配） | 避免 N 库 × M 表全量扫描（如 skill 查询不拉日志类） |
| D17 | **U 层跨项目可见是设计意图**，不按项目或分类做可见性限制 | U 就是给所有项目看的；敏感内容靠隐私底线与审阅拦在库外 |
| D18 | **文档 vs 记忆：分层优先**——事实 / 约定以文档为权威（记忆只存 `docRef` + 结论 + `docHash`）；偏好 / 经验 / 教训 / 会话态归记忆 | 复制文档会产出过期答案；文档有版本与属主 |
| D19 | **内容索引与内容同层同寿命**：工具输出 → I；**项目文档 → P 库 `doc_index`（不进 S）**；会话临时文本 → S；用户私有文档 → U | 索引不独立成层；文档属 P 级，不因被某次会话读过而降级 |
| D20 | **`doc_index` 状态**：`present` / `stale`（hash 失配）/ `missing`（文件消失）；后两者不自动改写、不自动删除，检索默认不返回 `missing` | 文档是权威，记忆不自作主张 |

### 5. 容量、更新与频率

| 条 | 决策 | 理由 / 备选 |
| --- | --- | --- |
| D21 | **容量与寿命**：寿命由作用域定，容量字节口径兜底（I 100 / S 50 / P 200 MB、U 1 MB 软上限只告警）；按缺口淘汰、不跨层淘汰；降级只对 S 层 | 实测 61% 空间是 trigram 索引，token 估算量不到主要成本 |
| D22 | **不限制单条内容大小**：S / P / U 长度上限与下限**均不设**（D27 统一到全层） | 体积靠提升时的概括 + 逐库容量淘汰控制，不靠入口长度闸 |
| D23 | **更新频率：事件驱动 + 节流**（无常驻调度器）；S 层 5 分钟合并窗口；候选上限 I→S 20 / S→P 20 / P→U 10；巩固 `minIntervalMs` 10 min | 实测 2,284 条/天、163 条/会话、淘汰 0、命中 0 → 「只写不减」需压碎片并给命中判据留退路 |
| D24 | **重新概括按增量**（新增来源 ≥3 或新增命中 ≥3），**不按时间**；不按时间衰减删除 | 没有新输入时重算纯浪费；年龄只用于排序与复核提示 |
| D26 | **更新语义：冲突交用户裁定**——矛盾不自动合并（产出冲突候选 → 按条提问 → 裁定后**两条内容都更新**）；不引入 `supersedes` / `superseded_by`；无冲突的自动改写（合并窗口 / 同类替换 / 重新概括）照旧自动；**删除是独立动作**（下层来源行不受影响，回指链允许悬空）；**无撤销机制**（错了再更新一次） | 用户 2026-10-08 裁定：新旧结论不许并存；删除不传播；回滚以「再更新一次」代替 |
| D29 | **参数与默认值：先用默认，不好用了再改**（逐库容量、排序权重、合并窗口、兜底过期、提升阈值、节流间隔都是配置项） | 用户 2026-10-08：不逐条确认默认值 |
| D30 | **审阅队列积压：默认保留**（不阻塞写入、不自动拒绝、不自动丢弃，候选随所在层寿命淘汰） | 同上，按默认 |

| D27 | **各层都不设长度门槛**（I / S / P / U 一致，上限下限都没有）；唯一形态底线是不接受空内容 | 用户 2026-10-08：S 不加限制，和其他层一样 |
| D28 | **审阅权限按跳定**：I → S 用户不审、由 agent 审；S → P agent 可代批；P → U **必须用户本人** | 用户 2026-10-08 裁定；同时解决 §5 与 §6 的 I → S 口径矛盾 |

### 6. 存量与迁移

| 条 | 决策 | 理由 / 备选 |
| --- | --- | --- |
| D25 | **旧库一律清空**（601 MB / 52,786 行 / 91 条凭据形态）；schema 版本不匹配从「整库重置」改为「迁移或拒绝打开」 | 用户 2026-10-08 裁定；旧数据无法判定归属且含凭据形态条目 |

| D31 | **旧库直接删除、不备份**（不做 `VACUUM INTO`、不留 `.bak`；删除仍由显式调用触发） | 用户 2026-10-08 裁定 |
| D33 | **实现口径补充（第二轮审阅修复轮，2026-10-08）**：① `importance` 缺省 3 **只作淘汰排序与候选优先级**（P 门槛去掉 `importance ≥ 3`，改由「价值证据」承担）；② **U 层不允许兜底分类**（必须显式给已注册分类）；③ 服务面动作枚举补 `registerKind`（分类注册入口）与 `migrate`（存量迁移）；④ I 层新增 `referenced_at`（回查引用时间），I→S 判据由「被检索命中」改「被回查引用」；⑤ **I 层的兜底过期与容量由属主 `output-compress` 自管**（巩固链只处理 S / P / U）；⑥ **跨项目证据靠 U 行 `projects` 累积**（每项目一票，达 ≥2 标为跨项目事实并优先提审），不需要跨项目读 P；⑦ P→U 两条分支**都只产候选，落地必须用户本人批**；⑧ 新增 §12 #12「文档索引落地」实施条目 | 第二轮独立复审（1 FAIL + 16 新发现）后的修复 |
| D34 | **实现口径补充（第三轮审阅修复轮，2026-10-08）**：① **候选（含冲突候选）写在目标层库的候选区**（`promotion_state != null`，不算落地、不参与检索），跨项目 `projects` 累积发生在这条 U 候选行上；② I 层字段补 `is_error`（写入时落库）与 `referenced_at` 的**刷新执行者**（属主自己的索引检索 / 回读入口）；③ I → S 的触发与重试**全在属主侧**（push + 属主巩固时重推），本包不主动读 I；④ 存量回扫限定 S / P / U（I 归属主）；⑤ `doc_index` 的 FTS **只索引章节标题与摘要行**；⑥ 删掉 S 层 `doc_index` 行（会话临时文本按普通记忆条目落 S 分类表）；⑦「同一事实」判据统一引用 §3.4；⑧ 基类列补 `conflict_with`，计数补 `conflicts`；⑨ `crossProject` 仅用户可开。**更正（第四轮）**：① 的「候选区（`promotion_state != null`）」与 ⑧ 的「基类列补 `conflict_with`」已被 D35 取代——候选改为**独立 `candidates` 表**，候选字段不入基类列 | 第三轮独立复审（17/17 修复 PASS + 19 条新发现，B1–B18）后的修复 |
| D35 | **契约级修正（第四轮复审修复轮，2026-10-08）**：① **幂等键改 `(target_tier + kind + fact_key)`**，`fact_key` = 来源内容按 §3.4 归一化后的哈希——同一事实从不同项目推上来落**同一候选行**（`projects` 各记一票）；② `candidates` 字段补 `fact_key` / `content_hash`；③ **候选入队即过分类闸门**（`kind` 未注册 / U 候选落兜底 → 不入队），避免「落地才失败」的死候选；④ **冲突候选不受代批**（`conflict_with != null` 一律用户裁定），`decision` 四值 = `accept-new` / `keep-old` / `merge` / `edit`；⑤ `resolveConflict` 分两条路径（有下层来源行 → 三步事务；用户直写冲突 → 只更新两条 + 清候选）；⑥ 候选寿命与丢弃统一（随库寿命 + `candidates` 表容量先清最旧）；⑦ §0 例外补「同层无冲突改写直接改正式行」；⑧ 服务面补 `forget` / `listCandidates`；⑨ §12 #4 补「接 `ctx.llm` 面」与不可用契约、#7 补「巩固时重推未成功候选」、#12 验收去掉「会话文本落 S」残影；⑩ §13 观察项补 LLM 面 | 第四轮快速复审（19 项 18 PASS + 8 条自洽问题，B3/B5 为契约级）后的修复 |

### 7. 观察项（不裁定）

- trigram 是否只在 P 层保留（已定）→ 是否进一步退化为可选；
- 官方 `session-query-sqlite` 的 FTS5 是否开启并与 P 层做分工验证；
- U / P 的 system prompt 注入面；
- 记忆的备份 / 导出面（D32：当前不做专门接口，需要时用 SQLite 原生手段）。

### 8. 已作废

| 原条 | 内容 | 作废原因 |
| --- | --- | --- |
| 原 D11 | 固定分类全集 `style` / `convention` / `preference` / `skill` / `experience` / `pitfall` / `fact` / `note` | 被 D12「分类注册制」取代（2026-10-08）：本包不再限定分类名与语义 |
| 原 D14 文案 | 「更新语义五点」曾作为待裁定节 | 已重编入 D26，内容未变 |

## 规划

### 计划改动文件清单

| 文件 | 改动性质 |
| --- | --- |
| `knowledge-base/docs/DESIGN.md` | 设计定稿（本任务主要产物） |
| `knowledge-base/README.md` | 接口 / 配置口径同步（按需：若定稿改变对外口径或新增配置项） |
| `output-compress/README.md` | 共库契约口径同步（按需：若共库写入 / 淘汰边界变更） |
| `docs/BACKLOG.md` | 条目状态（开工标「进行中」；完成时标「完成」并清理） |
| `docs/implementation/2026-10-07-knowledge-memory-lifecycle.md`（关闭后移入 `docs/archived/`） | 本追踪文档 |

### 明确不做

- 不改任何代码：本任务止于设计定稿；实施（闸门下沉 / 分区落地 / 容量上限 / 存量回扫 / 官方分工）由定稿拆出的**新 BACKLOG 条目**承载，各自独立验收。
- 不改 `docs/STATUS.md`（对照文档，由用户择时更新）。
- 不改 `profiles/`、不改 schema（库结构变更属实施，不在本轮）。
- 本轮（调研阶段）不做任何真库写操作：实测一律 `readOnly`。

## 实现记录

> 编号说明：下面历史条目里的 `Dn` 是**当时编号**；2026-10-08 整理决策节时重编为 D1–D33，对应关系以「决策」节为准。

- 2026-10-07：接取条目（`docs/BACKLOG.md` 标「进行中」）；建本追踪文档，写「计划改动文件清单」。
- 2026-10-08：完成调研 —— 子代理只读代码侦察（写入路径全集 / 闸门位置 / 分区 WHERE 表 / 容量与触发点 / 检索面 / 共库逐列 / 官方分工 / 宿主 `session/event` 签名与 `SessionHeader.cwd` / profile 现状）+ 真库只读实测（空间构成、分布、凭据形态 91 条、增长速率）。
- 2026-10-08：用户指示「先不下决定，调研完成就结束」→ 停在调研阶段。
- 2026-10-08：用户给定三条设计原则（一阶段一库 / 逐步概括提升 / 高层写入更严）→ 按原则重做决策（D1-D8，见上）并改写 `knowledge-base/docs/DESIGN.md` 为目标态分层设计（原文件 84 行 → 新 12 节）；本文件同步登记决策。
- 待办：用户确认设计定稿 → 同步 `knowledge-base/README.md` 的设计指向 → 拆实施条目入 `docs/BACKLOG.md` → 入 `docs/archived/` 关闭。
- 2026-10-08：用户回复「要改，但在后续对话中改」+「不提交」→ 本轮到此为止：DESIGN 目标态暂不作为定稿，改动全留工作区（`docs/BACKLOG.md`、`knowledge-base/docs/DESIGN.md`、本文件），README 与条目拆分均未动；下一轮按用户指示修订。
- 2026-10-08（后续对话）：用户澄清「生命周期」= **作用域**（会话 → 项目 → 用户），不是时间长度 → 推翻上一版 T1-T4 时间分层写法，按作用域重写 `knowledge-base/docs/DESIGN.md`（三库 `session.db` / `project.db` / `user.db` + 索引层 `digest.db`，三条提升链 I→S / S→P / P→U），本文件 D1-D8 同步改写。
- 2026-10-08（后续对话）：**第四轮快速复审**（只查上轮改动；19 项 18 PASS + A9 残留 1 处 + 8 条自洽问题，B3 幂等键 vs 跨项目同行、B5 P 层冲突可被 agent 代批为契约级）→ 同批修复：幂等键改 `(target_tier + kind + fact_key)`（同事实跨项目落同一候选行）、`candidates` 补 `fact_key`/`content_hash`、候选入队即过分类闸门、冲突候选不受代批 + `decision` 四值、`resolveConflict` 两条路径、候选寿命与淘汰统一、§0 例外补同层改写、服务面补 `forget`/`listCandidates`、§12 #4/#7/#12 补实施项与去残影、§13 补 LLM 观察项；决策节补 D35 并更正 D34。
- 2026-10-08（后续对话）：用户要求「增加一条 backlog：状态列 Agents 开头的符号增加闪烁」→ 按规范写入 **TUI 模块 BACKLOG**（`TUI/docs/BACKLOG.md` 新条目 2，旧 2/3/4 顺延为 3/4/5，来源行同步；条目内含接取时待裁定 6 点与可复用的现有 `virt-tick` 机制）；本任务不实施该条，交其他 agent。
- 2026-10-08（后续对话）：用户指示「候选可以单独成表」+ 问「其他内容有硬性问题吗」→ ① 候选改为**独立 `candidates` 表**（每库一张，与记忆表分离、不参与检索与容量统计，独立 5 MB/层上限）；② 自查补 4 处硬点：`promote` 契约与幂等键、审阅通过的**单事务转换**（正式写入 + `promoted_to` + 候选清理，失败回滚）、冲突裁定动作 `resolveConflict`、LLM 调用面（`ctx.llm`，不可用即失败）；③ 补边界：`referenced_at` 只统计经索引入口的引用、S 合并窗口是进程内内存态；④ §12 新增 #13 TUI 侧改造（审阅面板 / `/memory` / 服务键消费点）。
- 2026-10-08（后续对话）：**第三轮独立复审**（第二轮 17 项 17/17 PASS；新发现 19 条，含 4 条 §0 与细则硬冲突 B1–B4、4 条可实施性硬伤 B7–B10）→ 同批修复：§0 五条顺序标准补例外与限定（TTL 属寿命 / U 不自动淘汰 / 冲突限 P·U / 索引层例外 / I 不参与检索 / 跨项目默认不读）、候选区机制（B7/B15）、I 层 `is_error` 与 `referenced_at` 刷新执行者（B8/B9）、I→S 触发与重试归属主（B10）、回扫 scope（B11）、doc_index FTS 范围（B12）、`keyLines`/`preview` 定义（B13）、同一事实判据统一（B14）、删 S 层 doc_index（B16）、验收路径（B17）、失败教训判定者（B18）；决策节补 D34。
- 2026-10-08（后续对话）：用户指出「有些细节了，概括为一些简单的标准用来判断顺序」→ DESIGN 前置 **§0 判定标准**（1 条分类标准 + 5 条顺序标准：写入 / 提升 / 检索 / 淘汰 / 审阅 + 2 条底线），并声明「细则与本节冲突时以本节为准」；§1–§13 保持为展开与理由。
- 2026-10-08（后续对话）：**第二轮独立复审**（46/47 修复 PASS + 16 条新发现，含 8 条硬伤：P→U 自动分支不可自足、I→S 命中判据依赖 I 层不存在的字段、I 层兜底过期无执行者、`importance` 缺省 3 使 P 门槛恒真、注册入口无落点、doc_index 无实施条目、`kind` 与 doc_index 互斥、用户直写「冲突替换」措辞等）→ 同批修复：§2.1 注册入口与动作枚举、§3.1 `referenced_at` 与属主自管清理、§3.2 补 I→S 入口、§4 `registerKind`、§5 去 `importance` 门槛 + 兜底分类注册 + `remember` 命名统一、§6 I→S 判据改「被回查引用」+ 跨项目证据靠 `projects` 累积 + P→U 必用户批、§7 `kind` 与 `doc_index` 口径、§8 I 层归属 + 降级跳过范围、§8.1 兜底过期拆 S / I 两行、§12 新增 #12 文档索引落地、§13 U 层禁兜底；决策节补 D33。
- 2026-10-08（后续对话）：用户要求交独立子代理审阅「具体内容是否与设计原则冲突」→ 审阅报告：**冲突 8 / 内部不一致 16 / 缺口 10 / 旧概念残留 13**。全部处理：冲突（S 行残余「最小长度」、「会话结束即清」四处、「机械概括」、§12「失败降级」、P→U「或 agent 确认」、`ctx.get('knowledge')` 三处、固定分类名 `note`/`fact`/`convention`、同层自动改写与审阅的边界）、不一致（P 门槛缺 `importance ≥ 3`、U 门槛 AND/OR 三写法、S 淘汰键、U「500 条」、兜底分类未注册、服务面枚举漏 4 个动作、共享面计数、I→S 概括字段、基类列缺字段、层名字母说明、取舍条数、D1–D32→D32、§K 过期引用、「冲突」三义、compress 未提）、缺口（候选状态持久化、产物字段、`importance` 赋值、兜底过期触发点、`crossProject` 权限、`writeBack`/`backfill` 目标层、事件→kind 注册、`doc_index` 与 kind、U 层 doc_index 范围、I→S 的 LLM 归属）。复审 grep：旧概念残留 0 条（仅「已作废」节与实现记录保留历史字样）。
- 2026-10-08（后续对话）：用户裁定「旧库直接删除、不用备份；其他先用默认，不好用了再改」，并要求更新后重整文档 → DESIGN 增「旧库直接删除不备份 / 默认值可调 / 审阅队列默认保留 / 观察项补备份导出面」，并按「定位 → 分层路由 → 各层契约 → 分类 → 闸门 → 提升审阅 → 检索索引 → 容量频率 → Schema 迁移 → 边界差异」重排为 §1–§13（§ 引用全量同步）；追踪文档决策节收口 D29–D32，删去空的待裁定节。
- 2026-10-08（后续对话）：用户裁定 D27（各层都不设长度门槛，S 与其他层一致）与 D28（审阅按跳：I→S 由 agent 审、S→P agent 可代批、P→U 必须用户本人）→ DESIGN §5 表去掉长度列、审阅列按跳写明，§6 审阅形态与权限改写；决策节 D27 / D28 移入已定，待裁定改为 D29–D32（参数默认值、队列积压行为、旧库清理形态、备份导出面）。
- 2026-10-08（后续对话）：用户裁定 D26 更新语义四点（冲突交用户、裁定后双向更新；删除不传播；无撤销、再更新一次；删除是独立动作）→ DESIGN §6.1 由「待裁定」改为定稿条款，§13 补「删除不传播、回指链允许悬空」，决策节把 D26 移入已定组。
- 2026-10-08：按用户指示整理决策节（按主题分组为 0-9 节、重编号 D1–D33、作废项移入「已作废」、删掉重复的过程描述），本节历史条目保留当时编号。
- 2026-10-08（后续对话）：用户对「还有哪些需要讨论」逐条裁定（D19–D25：LLM 概括 / 审阅按条提问且 P 可代批 U 不可 / `origin: user` 必须提问确认 / U 全局可见是设计意图 / 检索前判分类 / doc_index 状态更新 / 分类 schema 归注册方），并要求核实宿主删会话行为（§K 补：0.2.0-rc.2 无删除入口，硬删除实际只有 7 天兜底）。
- 2026-10-08（后续对话）：用户明确「检索跨全域不仅是不同等级，也包括不同的数据表」→ 新增 D18：检索面 = 层 × 分类，注册即自动纳入并集，`scope` / `kind` 两维收窄（§7 / §4 / §7.2 / §12#3 同步）。
- 2026-10-08（后续对话）：用户指示「逻辑区分（偏好 / 技能沉淀等）的内容由其他插件管理；本包只负责基础，不要限定数据表名称」→ 新增 D17 并整体替换 DESIGN §4 为**分类注册制**（注册 kind + 扩展列；本包只给基类列；不硬编码分类名），§5 分类闸门 / §6 建议分类 / §3.3 / §3.4 / §12#11 / §13 同步改写。
- 2026-10-08（后续对话）：用户问「会话结束是 TUI 退出还是会话被清理」→ 核实宿主事实（`session/disposed` = 会话出内存 store，TUI 退出会触发；§K）→ 用户选定 D16：dispose 仅做提升收尾、不清 S / I，硬删除靠宿主删会话 + 7 天兜底；DESIGN §3.1 / §3.2 / §2.1 / §12#5 同步改写。
- 2026-10-08（后续对话）：用户同意补「文档索引」，并加约束「索引要与被索引内容的生命周期对应；项目文档属 P 级，索引不能放进 S 级」→ 新增 DESIGN §7.2 与 D15：索引建在内容所属层，项目文档索引落 P 库。
- 2026-10-08（后续对话）：用户指示「U 和 P 也不要限制长度」→ §5 闸门表 P / U 的最小长度改「不设」（连下限也去掉），S 层 `minChars` 保留待定。
- 2026-10-08（后续对话）：用户问「新设计里更新部分怎么写的」→ 复述六类更新动作，并列出五个未写缺口（supersede / 更新审阅 / superseded_by / 删除传播 / 回滚）；用户对其中两点答「先等我看现状」「后面继续讨论」→ 记 D14 待裁定，DESIGN 加 §6.1 留白。
- 2026-10-08（后续对话）：用户要求补充「记忆的更新频率」→ 实测（2,284 条/天、163 条/会话、淘汰 0、命中 0）+ 新增 D13 与 DESIGN §8.1：事件驱动 + 节流、合并窗口、提升候选上限、按增量重新概括、命中判据必须可退化。
- 2026-10-08（后续对话）：用户确认「文档 vs 记忆」按**分层优先** → 新增 D12 与 DESIGN §7.1：事实 / 约定以文档为权威（记忆只存 `docRef` + 结论 + `docHash`），偏好 / 经验 / 教训 / 会话态归记忆；失配标 `stale`，不自动改写。
- 2026-10-08（后续对话）：用户提出「文件内不同数据表对应不同逻辑分类（编程风格 / 全局约定 / 算法选择偏好 / 问题处理经验与 skills 等）」→ 新增 D11 与 DESIGN §4：一类一张表、分类跨层同构、按需建表、扩展即加表、分类由审阅定、未知 `kind` 拒写。
- 2026-10-08（后续对话）：用户裁定「其他项目的 P 默认不读、可显式开」→ 默认检索面收敛为本会话 S + 当前项目 P + 全局 U，跨项目走 `crossProject` 开关（候选由宿主会话索引的 cwd 派生）。
- 2026-10-08（后续对话）：用户明确「S 的文件就用 dsh 自己的会话目录，不要 `<dshHome>/memory-base/sessions/`」→ 去掉自建旁路目录与回退分支，改为「随会话目录生灭 + 解析不到即告警」。
- 2026-10-08（后续对话）：用户要求「分层表格中注明层名含义；由 knowledge-base 统一做底层数据路由（模型侧 / 用户侧不感知文件）；存储位置与层级对应（S=会话目录、P=项目根 `.dsh/`、U=`~/.dsh/memory-base/`）；模块改名 `memory-base`」→ 新增 D9 / D10，DESIGN §2 表加存储位置列与层名说明、加 §2.1 数据路由、§12 加改名与存储迁移两条实施条目。
- 2026-10-08（后续对话）：用户补充「逐级 + 审阅只针对自动写入，用户明确指令不受限」→ 增加 `origin: user` 直达路径与判定口径（调用来源标记，agent 不得自标）。
- 2026-10-08（后续对话）：用户指示「搜索可以跨全域，写入只能从会话级逐级提升且提升需要审阅」→ 去掉检索隔离与 `depth` 分层门禁（改跨全域 + 层标签加权），去掉一切直写 P / U 的入口（`memory.add` 也先落 S），提升链每跳加审阅与留痕。
- 2026-10-08（后续对话）：用户指示「不硬性限制写入内容的大小」→ 去掉全部单条长度上限（S / P / U 与 I 的 4 KB），U 层容量改软上限（超限只告警，不拒写不静默删）；控制体积改由提升时的概括与逐库容量淘汰承担。

## 测试与证据

本任务只交付文档（无代码改动），证据 = 调研可核性 + 四轮独立复审 + 逐轮修复的机械校验：

- **调研可核性**：代码事实均为 `文件:行号` 锚点；宿主事实锚点在 `…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/**`（0.2.0-rc.2）；库事实用 `node --experimental-sqlite` 只读查询（`dbstat` 取空间构成、六条拒绝模式逐行匹配只输出计数、不回显内容），写入面操作一次未执行。
- **交叉一致**：2026-10-05 旧实测（533 MB / 49,831 chunks / 91 条）与本轮（601 MB / 52,786 chunks / 91 条）在凭据形态计数上完全一致，增长速率由两者差值给出。
- **独立复审（4 轮，只读子代理）**：第 1 轮 8 冲突 / 16 不一致 / 10 缺口 / 13 残留；第 2 轮 17 项（1 FAIL + 16 新发现）；第 3 轮 19 项（含 4 条 §0 与细则硬冲突）；第 4 轮 19 项中 18 PASS + 8 条自洽问题。**全部修复**。
- **机械校验**：逐轮用脚本对「新文本存在 + 旧文本消失」双向断言——15/15、17/17、19/19、11/11 通过；另做结构校验（§1 恰好 6 条取舍、§5 表列数一致、13 个顶层章节、`minChars` / `ctx.get('knowledge')` / 固定分类名等旧概念 0 残留）。
- **未验证**：设计未实现，任何运行时行为（提升 / 审阅 / 容量 / 迁移）均未实测；文件路径依赖（宿主会话目录、`projectKey(cwd)` 约定）标为「实施时先核实」。

## 收尾

- **回写文档**：`knowledge-base/docs/DESIGN.md`（目标架构定稿：§0 判定标准 + §1–§13，替代原实现描述）；`knowledge-base/README.md`（加「DESIGN 已改为目标架构 + 现状见差异清单」提示）；`output-compress/README.md`（加目标架构提示：本包将自持 `digest.db`、不再共库直写）；`docs/BACKLOG.md`（本条目标「完成」并**清理移除**；§12 差异清单拆为 **13 条实施条目**，含前置/落点/工作量/优先级）。
- **遗留项**：① 13 条实施条目（项目级 BACKLOG §2）交其他 agent；② 观察项 4 条（trigram 是否退为可选、官方 `sessionQuery` 的 FTS5 是否开启、LLM 概括的模型/成本、备份与导出面）；③ 实施时须核实 2 项（宿主是否暴露会话目录路径、`projectKey(cwd)` 目录约定）。
- **归档**：本文件由 `docs/implementation/` 移入 `docs/archived/`（`git mv`）。
- **BACKLOG 清理**：项目级 `docs/BACKLOG.md` 原条目已移除（唯一记录 = 本文件与实施条目）；`TUI/docs/BACKLOG.md` 的「Agents 符号闪烁」是本次会话中用户另提的新条目，与本任务无关，单独提交。
- **提交**：关闭提交为本次变更的**最后一次提交**（见 commit message 引用的本文件路径）。

## 实施阶段（2026-10-08 恢复进行中）

> 设计收尾时条目被误关闭（设计 → 实施未衔接）。用户 2026-10-08 裁定：恢复本文件为进行中，接取 §12 拆出的 13 条实施条目，在**本会话内**完成实现与测试，不开子代理。设计依据 = `knowledge-base/docs/DESIGN.md`（§0 判定标准优先于细则）。

### 本次接取的条目（项目级 `docs/BACKLOG.md` §2，按标题引用）

1. 包改名 `knowledge-base` → `memory-base`
1. 存量清空 + 版本策略改「迁移或拒绝打开」
1. 存量回扫 `rescanDenied()`
1. 分层三库 + 索引层落地
1. 分类注册机制 `registerKind`
1. 存储位置迁移
1. 闸门下沉到库核心
1. `project` 派生链 + 跨全域检索
1. 提升链 I → S → P → U
1. 容量、寿命与清理
1. `output-compress` 自持 `digest.db`
1. 文档索引落地 `doc_index`
1. TUI 侧改造

### 实施顺序（按依赖）

1 / 2 / 3（无前置）→ 4（地基）→ 5 / 6 / 7 / 10 → 8 → 9 → 11 / 12 / 13；每步 `npm run check` + 相关包 `npm run test`。

### 计划改动文件清单（实施）

| 文件 / 目录 | 改动性质 |
| --- | --- |
| `knowledge-base/` → `memory-base/` | 目录改名 + `package.json` / `cordis.patch.yml` / 服务键 / 全仓引用 |
| `memory-base/src/schema.ts`、新 `src/scopes/*`、新 `src/router.ts`、新 `src/migrate.ts` | 三库分层 / 指纹 / 路由 / 位置推导 / 迁移 |
| `memory-base/src/knowledge.ts`、`src/rules.ts` | 闸门下沉到库核心 + `rescanDenied()` |
| 新 `memory-base/src/promote.ts`、`src/consolidate.ts` | 提升链 I→S→P→U + 审阅队列 + 冲突裁定 |
| `memory-base/src/index.ts`、`src/budget.ts`、`src/hooks.ts` | 服务面 / 容量寿命 / `project` 派生链 / 跨全域检索 / `doc_index` |
| `output-compress/src/kb-write.ts`、`src/hooks.ts`、`src/index.ts` | 自持 `digest.db` + 提升 push + 隐私常量一致性 |
| `TUI/src/main.ts`、`TUI/src/app/**` | 审阅面板 / `/memory` 改造 / 服务键消费点 |
| 各包 `README.md`、`scripts/install.sh`、`docs/BACKLOG.md` | 改名与口径同步、条目状态 |
| 本文件 | 实施过程记录（唯一文档落点） |

### 条目明细：分类注册机制（§12 #11）

#### 调研（2026-10-08，只读；子代理逐处侦察 + 本文件复核）

**设计口径**（`memory-base/docs/DESIGN.md`；§0 判定标准优先于细则）：

- §4：注册制——注册方给 `kind` + 扩展列 + 可选写入前钩子 + 可选**查询路由规则**；本包只提供**基类列**；**一类一张表，表名由注册方给出**；未注册 `kind` 拒写并回报；兜底分类由配置声明（缺省 `default`）并在首次启动注册；分类跨层同构；注册即自动进入该层检索并集；**按需建表（空表不建）**；新增分类 = 加表（不迁移既有数据），**改列 / 删表**才走版本迁移（§9）。
- §5：分类闸门在**库核心**；**U 层不允许兜底**；候选入队同样过这道闸。
- §7：检索 = **层 × 分类**；给了 `kind` 只查该分类表，没给则由各分类的**查询路由规则**决定参与集合（规则未声明的分类作通配一起参与）；结果带 `scope` / `project` / `kind` 标签。
- §12 #11 验收：未注册 `kind` 拒写；新增分类不需数据迁移；检索结果带 `kind` 标签；**代码里不出现具体分类名**。

**代码现状（基线：`memory-base` `npm run test` = 80 例全绿；类名是 `KnowledgeService`，`knowledge.ts:163`）**：

- 数据面只有**一张记忆表** `chunks`（`schema.ts:96-111`，STRICT），`sources` 为全局单表（`:85-94`）；双 FTS5 external content + 三支 TRIGGER（`:117-142`）。**没有** `candidates` / `doc_index` / 任何 per-kind 表。
- 表名硬编码的真实影响面（`文件:行号`）：`knowledge.ts` 22 条 SQL（`:202/:217/:227/:250/:264/:316/:319/:368/:378/:382/:404/:408/:453/:469/:488/:502/:507/:523/:543/:566/:582/:612/:635`）、`tiers.ts:230`、`index.ts:297`、`memory.ts:97/:161`；**跨包** `output-compress/src/kb-write.ts:215-238` 直插 `chunks`（第四条写路径、不过任何闸门，归 §12 #7）。
- 基类列**缺 8 项**：`docRef` / `docHash` / `origin` / `promoted_from` / `promoted_to` / `reviewer` / `sources`（来源列表）/ `projects`；存量 `target` / `summary` / `category` 是设计未列的列。
- `category` 出入口：写 `hooks.ts:169/:175`（**事件类型直接当 category**）、`hooks.ts:113/:140`、`memory.ts:77/:102`、`output-compress/src/hooks.ts:368`、`kb-write.ts:238`；读 `knowledge.ts:153/:190-193/:404-429`、`memory.ts:123/:146`、`smoke/smoke.mjs:44-48`。
- 拒绝语义：`PutResult.skipped` 复用 `SkipReason = "empty"|"short"|"pattern"`（`rules.ts:32`）；**三处调用方不判 `skipped`**——`writepolicy.ts:78-79`、`:95-96`（拒写被算成写成功且永不重试）与 `memory.ts:81`（`result.ids[0]!` 空数组直接 TypeError）。
- 装配点四处：`knowledge.ts:172-175`（`{rules?}`）、`memory.ts:67-70`（**不透传 options**）、`tiers.ts:347-348`（已有 `rules` 透传范式）、`index.ts:176`（单库 bundle 路径**连 `rules` 都没传**，既有缺口）。
- 版本策略：`KNOWLEDGE_SCHEMA_VERSION = 1`（`schema.ts:22`）；版本不符**拒绝打开**（`:188-193`）；空库建表只在 `:187` 跑一次；`resetSchema`（`:73-79`）与 `listUserTables`（`:60-67`）都锚在硬编码表名上。
- `sources.kind`（`schema.ts:87`）是**来源种类**（session / manual / …），与本次的分类 `kind` 同名不同义，SQL 别名须显式区分。
- **真机现状**：`~/.dsh/memory-base/memory.db` 6.0 MB 且**正在被写**（2026-10-08 17:46）＝当前跑的是**单库模式**；层库（`user.db` / `project.db` / `session.db`）尚未产生。会话目录约定已由宿主实证（本包子会话落在 `~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/<session-id>/`）。
- 顺带记一笔缺口（**本条目不做**）：§13 写「trigram 只在 P 层保留」，但 `schema.ts:119-121` 给每个层库都建 trigram FTS。

#### 决策（续 D35）

- **D36 分类 = 物理表，`kind` 即表身份**（照 §4）。`registerKind({ kind, table?, columns?, preWrite?, routes? })`：表名由注册方给，缺省按 `kind` 派生（`kind_<归一化>`）；派生规则在代码里，**具体分类名不在代码里**。表名过白名单（`^[a-z][a-z0-9_]{0,62}$`、不撞 `sqlite_*` 与保留名）后才拼串——SQLite 不支持 PRAGMA / 标识符参数绑定（`schema.ts:13` 已注明）。
- **D37 注册表与 DDL 分家**：`KindSpec` / `KindRegistry`（注册、解析表名、列校验、路由判定、兜底名）放 `router.ts`（§12 #11 指定落点，与「层 → 库路径」同属路由职责）；建表与 FTS / TRIGGER 归 `schema.ts`；SQL 归 `knowledge.ts`。
- **D38 兜底分类的表就用既有 `chunks`：不改名、不 bump 版本、不做数据迁移**。理由：① 跨包 `output-compress/src/kb-write.ts:215-238` 直插 `chunks`（属条目 3 的范围），改名会跨包打断；② 真机 `memory.db` 是活跃数据，改名 + 按新表名重建 FTS / TRIGGER 纯风险无收益；③ §9「按迁移链升级」与 §4「加表式迁移」只要求**新增分类不迁移**——新 kind 走 `CREATE TABLE IF NOT EXISTS`（幂等），`user_version` 保持 1，既有 v1 库照常打开（`:188-193` 的拒绝分支不动）。代价：兜底表名与其它 kind 的派生名不同构，写进 README；条目 3 落地（不再直写）后可收口。
- **D39 全局唯一键 = `(kind, id)`**：per-kind 表 id 各自从 1 起，而 `search` 的去重 Map（`knowledge.ts:222-223/:232-234`）与 `put` 的 `existing.get(sha256(chunk))`（`:315-330`）都以**裸 id** 为键 → 不换键会静默吞命中、跨 kind 误判重复。跨表维护动作（`evict` / `compress` / `setImportance` / `touch`）入参由 `id` 改 `{kind, id}`（内部契约，调用方全在本包：`consolidate.ts` / `hooks.ts` / `memory.ts`）。
- **D40 跨表 union 的落法**：无 `kind` 参数的读写（候选 / 淘汰 / 容量 / 回扫 / 压缩 / 计数）改为**遍历注册表逐表跑再归并**；`evict` 里 `sources.chunk_count` 的汇总（`knowledge.ts:382`）与归零清理（`:384`）必须按各表求和，否则 source 被误判归零删除。带 `kind` 的 `search` 只查该表；层内先 union 分类，跨层 union 仍由 `TierSet`（`tiers.ts:284-299`）承担。
- **D41 闸门与钩子**：`kind` 未注册 → `put()` 返回 `skipped: "kind"`（`SkipReason` 扩 `"kind"` / `"hook"`）；未显式给 `kind` 落兜底；**U 层拒兜底**（`tiers.remember` 落 `user` 且未给 `kind` → 拒写）。写前钩子 `preWrite({content, title, project, kind})` 在隐私闸门**之后**、INSERT **之前**，返回 `{ accept, reason?, importance? }`。
- **D42 补上「拒写＝未写」的三个漏判**（D41 让它们从潜伏变成活 bug）：`writepolicy.ts:78-79` / `:95-96` / `memory.ts:81` 先判 `skipped`——拒写不计 `written`、不抛 TypeError、按失败计数回报。
- **D43 「代码里不出现具体分类名」的判定口径**：本包 `src/` 内不出现**分类 kind 的字面量**（兜底名来自配置，缺省 `default`）；`hooks.ts:169/:175` 的事件类型、`memory.ts:13` 的 target 四值、demo 与测试里的 `note` / `preference` / `convention` 属**事件类型与 target 域**，不是注册分类，不计入。落地为一条 grep 断言。

#### 规划：计划改动文件清单（本条目，分三段落地）

**一段（地基，主线）**：

| 文件 | 改动 |
| --- | --- |
| `memory-base/src/router.ts` | `KindSpec` / `KindRegistry` / 表名派生与白名单校验 / 查询路由判定 / 兜底名 |
| `memory-base/src/schema.ts` | `ensureKindTable` / `ensureKindFts` / `listKindTables`（泛化 `resetSchema` 的 DROP 清单）；**版本保持 1** |
| `memory-base/src/knowledge.ts` | `put()` 分类闸门 + `preWrite` 钩子 + 目标表解析（含扩展列）；`kind` 进 `PutInput` / `SearchHit`；`search()` 跨表 union + `(kind, id)` 去重 |
| `memory-base/src/rules.ts` | `SkipReason` 扩 `"kind"` / `"hook"` |
| `memory-base/src/writepolicy.ts`、`src/memory.ts` | 补判 `skipped`（D42）；`memory.ts` 构造透传 options |

**二段（跨表维护并集化，D39 / D40）**：`knowledge.ts` 的 13 个维护方法 + `tiers.ts:230` + `index.ts:297` + `memory.ts:97/:161` 的 id → `{kind, id}` 与逐表归并。

**三段（装配与面）**：`memory-base/src/index.ts`（服务面 `registerKind` + 配置 `defaultKind` + 启动注册兜底 + 单库路径补 `rules` 注入）、`memory-base/src/tiers.ts`（registry 透传 + U 层拒兜底）、`memory-base/README.md`、`docs/BACKLOG.md`、本文件。

**测试**：新增 `memory-base/tests/registry.test.ts`；`schema.test.ts` / `knowledge.test.ts` / `memory.test.ts` / `rescan.test.ts` / `writepolicy.test.ts` / `tiers.test.ts` 随契约调整（既有用例锚在 `chunks` 表名与 `category` 值上，改名与加列必红）。目标 80 → 约 100 例全绿；每段跑 `npm run check` + `npm run test`。

#### 明确不做（本条目边界）

- 不做 `candidates` 表与提升链（条目：提升链 I → S → P → U）；本条目只把**候选入队要过的分类闸门**做成可复用判定。
- 不做 `doc_index`；不做 TUI 侧改造；不做 `output-compress` 自持 `digest.db`——`kb-write.ts` 直插 `chunks` 的现状**保持**到条目 3。
- 不删存量列（`target` / `summary` / `category`）、不 bump schema 版本、不实现 §13「trigram 只在 P 层」、不改 `STATUS.md`（用户择时）。

### 条目明细：文档索引落地 `doc_index`（§12 #12）

#### 调研（2026-10-08，只读）

**设计口径**（`memory-base/docs/DESIGN.md` §7.2 为主、§7.1 / §12 #12 为验收面）：

- **索引不是独立层**：建在被索引内容所属的库里、与该层同寿命——项目文档索引落 **P 库**（会话里读到的文档也一样记 P），用户私有文档索引落 **U 库**；**不建 S 层 `doc_index`**（会话临时文本按普通记忆条目落 S 分类表）。
- **表结构**：`docRef` / 章节标题 / 行范围 / `docHash` / 摘要行 + FTS5（复用既有 FTS5 + TRIGGER 机制）；**FTS 只索引章节标题与摘要行，不索引正文**（正文留在文件里）。
- **解析复用 `md-logic`**：CommonMark 节树已带行范围，拿来切片；`md-map` 锚点 / 引用关系「可选一并入库」。
- **维护挂巩固链**：启动后 + `compaction/end` 后增量扫（`mtime` + `size` + `docHash` 判变），事件驱动不轮询；首次全量扫一次。
- **命中行为**：返回**路径 + 行范围 + 摘要行**，调用方读原文；正文不入库（§1 文档优先，记忆不替文档做副本）。
- **参与检索**：与分类表同属该层检索并集，命中带 `scope` 标签与一个**固定的文档索引标签（标签名由实现定）**；**给了 `kind` 时它默认不参与**（不是注册分类），显式指定该标签才查。
- **状态机**：`present` / `stale`（`docHash` 不一致）/ `missing`（文件消失），与 §7.1 同一套；不自动改写、不自动删除；**检索默认不返回 `missing`**。
- **边界**：只索引配置给该层的 glob；**U 层默认不索引任何 glob**（需显式配置）；一旦索引，其摘要与 U 层其它内容一样对所有项目可见（设计意图非泄漏）。

**现状核查**：

- `memory-base/package.json` 零运行时依赖（仅 devDeps）；`md-logic` 导出 `parseMarkdownDocument`（`src/parse.ts:161`，纯函数、仅依赖 `marked`）——可作为 workspace 运行时依赖接入。
- 既有建表机制（条目 2 落地）：`ensureKindTable` 幂等建表（`IF NOT EXISTS`）+ 分类 FTS + TRIGGER；`doc_index` 列形状与分类表不同，需独立建表函数，但幂等 / 不 bump 版本的「加表式」路径相同。
- 检索并集（条目 2 落地）：`KnowledgeService.search` 遍历 `#existingEntries()`（注册分类表）；`doc_index` 不走 `KindRegistry`，需要在并集面单独并入。
- 巩固链挂点（条目 8/10 落地）：`index.ts` `maybeConsolidate`（启动一次 + `compaction/end`，10 分钟节流）——文档增量扫挂同一链。
- §11 边界表无「禁止依赖 md-logic」条款；「不得建立 npm 依赖」仅是 `output-compress` ↔ `memory-base` 隐私常量的专项约束。

#### 决策（D44–D48）

- **D44 落点与建表**：`doc_index` 表 + 专用 FTS5 影子表（external content，只挂 `section_title` 与 `summary` 两列）+ 写直达 TRIGGER，由 `schema.ts` 新增 `ensureDocIndex(db)` 幂等建（P / U 库 open 时即建——它是每库至多一张的固定索引，不同于分类表「空表不建」的按需语义）。**不 bump 版本**（加表 = 向后兼容，同条目 2 口径）。列：`id` / `doc_ref` / `section_title` / `line_start` / `line_end` / `doc_hash` / `summary` / `status`（`present|stale|missing`）/ `project` / `last_referenced` / `indexed_at`。行粒度 = 一文档一节一行，去重键 = `(doc_ref, line_start)`。
- **D45 解析依赖 md-logic**：`memory-base` 新增 workspace 运行时依赖 `@dsh-toolset/md-logic`，用 `parseMarkdownDocument` 切节。理由：设计明文复用 + 节树行范围现成，自写解析 = 复制 CommonMark 状态机。`md-map` 锚点 / 引用入库是「可选」项 → **本条目不做**（记观察）。
- **D46 检索参与**：`doc_index` **不进** `KindRegistry`（无内容主体、非分类，注册制语义不含它）；检索并集面扩为「已注册分类表 + 本库 `doc_index`（已建即并入）」。固定标签 = 导出常量 `DOC_INDEX_KIND = "doc"`（§7.2「标签名由实现定」）；调用方给 `kind` 时 `doc_index` 默认不参与，显式 `kind: "doc"` 才查它。命中行映射：`title` = 章节标题、`content` = 摘要行、`SearchHit` 增可选 `doc?: { ref: string; lineStart: number; lineEnd: number }`，正文不返回。
- **D47 维护与配置**：增量扫判据 = `mtime` + `size` 粗筛 → `docHash`（sha256 文件级）确认；新文件全量解析、未变跳过；文件消失 → 该文档全部行标 `missing`（不删行）。挂 `maybeConsolidate` 同链（启动 + `compaction/end`，复用既有节流）+ 服务面手动 `scanDocs()`。配置 `docIndex?: { project?: { include?: string[] }, user?: { include?: string[] } }`（glob；**P / U 缺省均空 = 不索引**，显式配置才开，与「不静默建 `.dsh/`」同风格；U 一旦配置即对所有项目可见是设计意图）。
- **D48 状态机**：`present` / `stale` / `missing` 三态只更新 `status` 列，**不自动改写摘要、不自动删行**（§7.1 文档是权威）；检索默认过滤 `missing`；`stale` 照常返回（调用方读原文后自行判断）。

#### 规划：分三段落地

**一段（表 + 扫描器）**：`schema.ts` `ensureDocIndex`（表 + FTS + TRIGGER）；`package.json` 加 `@dsh-toolset/md-logic` 依赖；新 `src/doc-index.ts`（扫描器：glob 展开 → `parseMarkdownDocument` 切节 → 差异写入 + 三态更新；`scanDocs(db, {include, now})` 纯函数入口）；单库与 `TierSet` 的 open 路径接线（P / U 建表）。

**二段（检索 + 巩固链 + 配置）**：`knowledge.ts` `search()` 并集并入 `doc_index`（`kind: "doc"` 语义 + `missing` 过滤 + `SearchHit.doc`）；`index.ts` 配置 `docIndex` + 巩固链挂增量扫 + 服务面 `scanDocs()`；`TierSet.search` 透传。

**三段（收尾）**：README（能力 + 配置表）、BACKLOG 收尾、本文件实施记录；测试补齐（建表幂等 / 扫描差异 / 三态 / 检索并集与 `kind: "doc"` 语义 / `missing` 过滤）。

#### 明确不做（本条目边界）

- 不索引文档正文（FTS 只挂标题与摘要行）；不建 S 层 `doc_index`。
- 不做 `md-map` 锚点 / 引用关系入库（设计「可选」项，记观察）。
- 不做 stale 自动改写 / 自动删除；不做 U 层缺省 glob；不做跨项目 P 库的 doc_index（「其他项目」P 库只读检索面，索引只维护当前项目）。
- 不 bump schema 版本、不改 `STATUS.md`（用户择时）。

### 条目明细：提升链 I → S → P → U（§12 #4）

#### 调研（2026-10-08，只读）

**设计口径**（`memory-base/docs/DESIGN.md` §6 + §6.1 + §3.2/§3.3/§3.4 + §5 门槛表 + §12 #4 验收面）：

- **链路**：提升 = 读下层行产出候选 → 审阅通过 → 上层按上层标准重写为概括 → 过上层闸门 → 入库 → 下层标 `promoted_to`。候选写**目标层 `candidates` 表**（与记忆表分离、不参与检索、不计容量），未过审随库寿命淘汰；**不做跨库事务**。
- **三跳判据与权限**：I → S（属主 push；agent 审，用户不审）；S → P（`session/disposed` 或 `compaction/end` 触发；判据 = 被检索命中过 OR 决策类事件 `plan/mode` / `goal/change` / `approval/decided` OR 失败教训（未注册绑定则该分支不成立）；**agent 可代批**）；P → U（巩固触发；判据 = 同一事实 ≥2 项目 OR 用户确认；**必须用户本人批，agent 的 approve 无效并回报**）。`conflict_with != null` 一律用户裁定。
- **候选表字段**（设计给定）：`id` / `target_tier` / `kind` / `fact_key` / `content_hash` / `title` / `content` / `sources` / `projects` / `promotion_state` / `conflict_with` / `reviewer` / `created_at`。
- **promote 幂等键** =（`target_tier` + `kind` + `fact_key`），`fact_key` = 来源内容按 §3.4 归一化后的哈希；重复 push 更新同一行，跨项目推同一事实落同一行（`projects` 各记一票）。
- **跨项目证据只在本项目内累积**：每个项目的会话只投自己一票，并入同一条 U 候选行的 `projects` 集合，≥2 即「跨项目事实」优先提审——**不需要跨项目读 P**。
- **概括由 LLM 完成**（走宿主 LLM 面）：输入 = 下层候选 + 来源回指，输出 = 上层 title + 结论 + 建议分类；**面不可用 = 调用失败**：不提升、计数、下次巩固重推，**不降级成机械摘要**。
- **审阅通过后的转换（单事务）**：① 用候选内容写上层正式行 → ② 有下层来源行才标 `promoted_to` → ③ 候选标 `approved` 并清理；任一步失败整体回滚。
- **冲突裁定**（§6.1）：矛盾 → 冲突候选（带 `conflict_with`）→ `resolveConflict(id, accept-new | keep-old | merge | edit)`；两条路径（有下层来源行 = 走 ①②③；用户直写冲突 = 只更新两行 + 清理）；把两条内容都更新为一致结论，不留新旧并存；不引入 `supersedes`；适用 P / U 层。
- **验收**（§12 #4）：每跳产出候选、审阅通过才落上层；**无审阅记录不得自动入库**；用户指令直写带 `origin: user`；LLM 面不可用 = 调用失败、失败不提升并计数（不降级）。

**现状核查**：

- **宿主 LLM 面与设计假设不符**：设计写「走宿主 LLM 面（`ctx.llm`）」，但 `docs/host/DSH-CTX-API.md` **没有 `ctx.llm` 服务**（可注入键 = `sessions` / `approval` / `agents` / `userQuestions` / `goals` / `commands` / `tools` / `ruleEngine` / `sessionTitle` 等）。`session-title-cutoff` 声明 `inject: ["llm"]`（`src/main.ts:24`）但实际生成走 **profiles/node_modules 里的官方 helper 包**（`@deepseek-ai/dsh-session-title-llm`，运行时 `createRequire` 加载，失败即降级不注册）——是 title 专用路径，不是通用 LLM 调用面。
- 归一化判据已有实现：`consolidate.ts` 的 `normalize()`（模块私有，需导出后复用，避免第三份拷贝）与 `redundant()`（§3.4「归一化相同或子串占比 ≥ 0.8」的现成实现）；`memory.ts` 的 `findByText` 是裸 LIKE 子串、**不**含 normalize 与占比判据，不构成同判据佐证（初稿表述有误，已修正）。
- 触发点已有挂链：`maybeConsolidate`（启动 + `compaction/end`，条目 8/10 落地）；`session/disposed` 事件在 hooks 事件白名单外，需要新增监听（宿主事件词汇表含 `session/disposed`）。
- 用户直写（`origin: user`）已落地路由（条目 8：`tiers.remember` + U 层禁兜底），但 origin **未持久化**（`tiers.ts` 解构后丢弃、`PutInput` 无该字段）——本条目补列落痕。

#### 决策（D49–D54，含 2026-10-08 子代理审阅修订）

> 审阅裁定：**有条件通过**——7 项必须改全部采纳折入下文（状态机补 `rejected` / `summarized` 闸 / 加列清单补全 / 隐私闸 / `markConflict` / approve 事务落地方式 / candidates 独立上限），并采纳建议项（`redundant()` 子串合并、normalize 导出复用、conflict 全链 user-only、每轮上限、设计两处回写）。

- **D49 候选表**：S / P / U 三库各一张 `candidates` 表，`schema.ts` 新增 `ensureCandidatesTable(db)` 幂等建（三库 open 时建；候选不参与检索 → **无 FTS**；不 bump 版本）。列 = 设计给定 13 字段 + `updated_at` + `reject_reason` + `summarized`（0/1，D51 闸）；`sources` / `projects` / `conflict_with` 存 JSON 文本。`promotion_state` 三态：`pending`（待审）/ `approved`（终态，转换成功即删行）/ `rejected`（**终态留痕**，保留到容量清最旧或库寿命淘汰——正合设计「候选未过审留在表内」）。唯一索引 `(kind, fact_key)`：`rejected` 行占住 fact_key 作**墓碑**——同 fact_key 重推 → 计数 `rejected-duplicate` 不重置（内容变了自然是新 key 新行）；promote() 把唯一冲突翻译成计数而非报错。`listCandidates` 缺省只出 `pending`。
- **D50 promote() 幂等入队**：服务面 `promote(items)`；`fact_key` = sha256(normalize(content))，normalize **从 `consolidate.ts` 导出复用**（trim + 压空白 + 小写）。合并两分支：① `fact_key` 精确命中 pending 行 → 并入；② 同 `(target_tier, kind)` 的 pending 候选内跑 `redundant()`（§3.4「归一化相同**或**短者为长者子串且占比 ≥ 0.8」）——没有②则不同措辞的同一事实各占一行，P→U 的 ≥2 跨项目判据永不触发。并入语义：`projects` 并集、`sources` 合并、`content` / `title` 以最新为准、状态重置 `pending`。**闸门（入队时过）**：`checkContent` 隐私底线（命中 → 拒收 `pattern`，候选表不留未过滤正文）+ kind 未注册拒收（U 层尤其，§5「死候选」防线）。返回每条结果（`queued` / `merged` / `rejected-duplicate` / 拒收原因）。
- **D51 LLM 面可插拔注入（与设计的偏差点）**：**不加** `inject: ["llm"]`——宿主无公开契约（`session-title-cutoff` 声明了同名键且正常加载，但 `llm?: unknown` 声明后从未消费，真实生成走 profiles helper 专用路径；风险是无公开方法面而非加载失败）。改为 bundle 服务面 `setLlmCaller(caller | null)`（caller = `(prompt: string, opts?: {maxTokens?: number}) => Promise<string>`），由宿主侧 wrapper 插件或测试注入；探测宿主 llm 服务实际形态记观察项。
- **D52 概括时点与失败闸（统一 D51）**：**概括在入队时完成**（promote 面即服务面；caller 存在 → 改写候选 `content` 为概括、`summarized = 1`；caller 的输出含建议分类，先于审阅存在，审阅可改——设计 L167 与 L181/L182 的时序表述以此为准，已回写设计）。**转换闸**：`approve` 前置检查——无 caller 且 `summarized = 0` → 拒绝转换、计数 `promotion.skipped: "llm-unavailable"`、候选保持 `pending`（下次巩固重概括）。即：候选可以入队（外部 push 不丢），但**未概括的候选不得落上层**——L180/L182「失败不提升不降级」落在转换步。触发：S → P = `session/disposed` + `compaction/end`；判据 = 被检索命中过（`last_referenced > created_at`）OR 决策类事件来源（`category` ∈ `plan/mode` / `goal/change` / `approval/decided`）OR 失败教训（未注册绑定 → 分支不成立）。P → U = 巩固链扫 `projects` ≥2 的 U 候选（票数在 promote 入队时累积）+ **隐私二次检查**（同一闸）。每轮生产上限：I→S ≤20 / S→P ≤20 / P→U ≤10（§8.1，防审阅疲劳）。
- **D53 加列清单（一次幂等 ALTER 补齐）**：分类基表补 `promoted_to` / `promoted_from` / `origin` / `reviewer` / `reviewed_at` / `projects`（全部可空 TEXT/INTEGER，子代理已在 node:sqlite STRICT 表实测 `ALTER ADD COLUMN` 可空列可行、旧行回读 NULL）——`reviewer` / `reviewed_at` 撑「审阅留痕到上层行」（否则③删候选后唯一审阅记录消失），`projects` 撑 U 行跨项目集合，`promoted_from` 撑回指链，`origin` 撑「用户指令直写带 `origin: user`」验收。`ensureKindTable` 新库直接建进 CREATE + 旧库 `ensureColumn` 幂等补（`pragma_table_info` 探测）；与 §9「改列才走迁移」冲突记**例外**（可空加列与加表同性质，已回写设计 §9），配测试。`tiers.remember` 不再丢弃 origin（透传 `PutInput.origin` 持久化）。
- **D53 审阅动作**：服务面 `listCandidates({tier?, state?})` / `approve(id, {reviewer})` / `reject(id, {reviewer, reason})` / `edit(id, content)` / `markConflict(id, {conflictWith})`。权限：P 候选 reviewer 任意（agent 代批合法）；U 候选、`conflict_with != null` 候选的 **approve / reject / resolveConflict 一律 user-only**（`reviewer === "user"`，标记制信任模型；「user 标记只由用户发起的命令 / TUI 动作生成」记为条目 2 的接口约束）。**approve 落地方式（嵌套事务规避）**：不加外层 BEGIN——① 调 `kb.put()`（自带事务，content_hash 去重使「①成功③失败」可安全重试：重试 approve → put 去重命中 → 继续删候选）→ ③ 删候选行（单语句原子）→ ② 跨库标下层 `promoted_to`（best-effort：失败计数 + 日志；后果 = 下轮触发重扫会重复提审，靠 fact_key 墓碑 / 人工 reject 兜底）。审阅留痕：put 时写 `reviewer` / `reviewed_at` / `origin`（提升行 origin = "auto"？——裁定：提升写入的行 `origin` 落 `"auto"`，直写落 `"user"`，来源标记与路由语义一致）。edit = 改 `content` + 重算 `content_hash` / `fact_key`（新 key 撞 pending 行按 D50 并入），状态保持 `pending`。
- **D54 冲突机制**：`candidates.conflict_with` 存目标层既有行的 `(kind, id)` JSON；**服务面 `markConflict(id, {conflictWith})`** 是把 pending 候选标记为冲突的唯一入口（自动检测依赖 LLM，本条目不做——「直写遇结论矛盾 → 冲突候选」的自动衔接同样移入明确不做）；`resolveConflict(id, decision, {content?})` 双路径按设计 L188（有下层来源行 = 走 ①②③；用户直写冲突 = 只更新两行 + 清理）；`merge` / `edit` 需带 `content`；user-only。

#### 规划：分三段落地

**一段（候选表 + 数据层）**：`schema.ts` `ensureCandidatesTable` + `ensureColumn` 幂等加列（六列）；`consolidate.ts` 导出 `normalize` / `redundant`；新 `src/promote.ts`：`factKeyOf`、`promote(db, registry, items, {rules})` 幂等入队（双分支合并 + 隐私闸 + 墓碑计数）、`listCandidates` / `approveCandidate` / `rejectCandidate` / `editCandidate` / `markConflict` / `resolveConflict`；三库 open 接线；`PutInput.origin` + `tiers.remember` 透传。

**二段（生产 + 触发 + LLM 注入点）**：`src/promote.ts` 增候选生产（S→P 会话扫描判据 + P→U 跨项目提审 + 每轮 ≤20/≤10）；`candidates` 独立上限（每层 5 MB、超限清最旧——pending / conflict / rejected 全计入，§6 L175）；`index.ts` 触发接线（`session/disposed` 监听 + 巩固链）+ `setLlmCaller`（caller 存在时入队改写 + summarized 标记）+ 失败计数与日志；服务面全量挂出（promote / listCandidates / approve / reject / edit / markConflict / resolveConflict / setLlmCaller）。

**三段（收尾）**：README（提升链小节 + 配置）+ 测试补齐（幂等入队与双分支合并 / 墓碑 / 权限与 user-only / 转换闸 summarized / put 去重重试安全 / 冲突双路径 / 触发判据 / 容量上限）+ BACKLOG 收尾。

#### 明确不做（本条目边界）

- 不做 TUI 审阅面板（条目 2：按条提问 / approve / reject / edit 面板化；「user 标记只由用户发起动作生成」的凭据约束落条目 2 接口）。
- 不做 `output-compress` 的 push 改造（条目 3）；本条目只保证服务面 `promote()` 就绪。
- 不做矛盾自动检测与「直写遇结论矛盾 → 冲突候选」的自动衔接（均依赖 LLM 输出；机制 + `markConflict` 服务面先落，人工标记）。
- 不做跨库事务（设计明令；②下层标记为 best-effort + 计数）；不做 `supersedes` / 撤销机制（§6.1）。
- rejected 墓碑被容量清掉后同 fact_key 可重新入队（可接受，容量兜底优先）。
- 不改 `STATUS.md`（用户择时）。

### 实施记录

- 2026-10-08：**条目 1（包改名）完成** —— 目录 `knowledge-base/` → `memory-base/`（`git mv`）；包名 / `cordis.patch.yml` id / 服务键 `ctx.get('memory')` / `MEMORY_DB_PATH` / smoke profile 名 / `scripts/{install,test-parallel}.sh` / `profiles/example` / TUI 消费点 / 全部活跃文档引用一并改（555 个 tracked 文件过 sed）。**保留旧名**：`docs/STATUS.md`（用户择时更新）、`docs/BACKLOG.md` 条目 1 自身、本文件、`*docs/archived/`、根 `archive/`、`docs/host/`（宿主面历史记录）。验证：全仓 `check` 0 error、`build` exit 0、`test` 21 包全绿（memory-base 57）。**待人工**：`~/.dsh/profiles/fff` 的 `link:` 依赖与 patch id 仍是旧名（项目目录外，未擅自改）。
- 2026-10-08：**条目 2（存量清空 + 版本策略）完成** —— `schema.ts` 版本不匹配改「拒绝打开并报错」（不再 `DROP` 重建，GB 级库上等于数据全失）；新增 `src/migrate.ts`：`migrate({dbPath, from:"v1", mode:"drop"})` 删库文件 + `-wal` / `-shm`（幂等；未实现的 from/mode 组合拒绝，避免「调用成功但没做事」）；服务面挂 `migrate`（缺省作用于本 bundle 库路径，不静默删）。+4 用例（schema 版本拒绝 1 / migrate 3）→ 61。
- 2026-10-08：**条目 3（存量回扫）完成** —— `rules.ts` 加 `matchDenyPattern()`（只查隐私拒绝模式，不含空 / 长度闸门）；`KnowledgeService.rescanDenied({project?, apply?, rules?})`：默认只报告（`scanned` / `matched` / `byCategory` / `hits`，命中项只给模式源串 + 分类 + project，**不回显正文**），`apply: true` 才走 `evict`（联动 `sources.chunk_count` 与归零清理）；服务面挂 `rescanDenied`，复用 hooks 已编译规则 → profile 自定义 `denyPatterns` 一并生效。+3 用例 → 64。
- 2026-10-08：**条目 4（分层三库 + 索引层）与条目 6（存储位置迁移）完成** —— 新增 `src/router.ts`（层路径推导：S → 会话目录、P → 项目根 `.dsh/`、U → `~/.dsh/memory-base/`；`sessionDirFor()` 按宿主要约拼接；**解析不到返回 undefined，不静默换路径**）与 `src/tiers.ts`（`TierSet`：三库打开、`search()` 跨层检索、`remember()` 写入路由、`forget()`、`usage()`、`enforceLimits()`）。`schema.ts` 改 `openTierDatabase(path, tier)`：**一库一指纹**（`SESS` / `PROJ` / `USER`），旧 v1 的 `KNOW` 指纹库不会被任何层打开；`application_id` 参数化建库。bundle 增 `config.tiers`（**缺省关闭**，不静默在项目里建 `.dsh/`）、`bundle.tiers` 与服务面 `search` / `remember` / `forget` / `usage` / `enforceLimits`。+10 用例（tiers 6 / bundle-tiers 2 / 其余并入）→ 80。
- 2026-10-08：**条目 7（闸门下沉到库核心）完成** —— `KnowledgeService` 构造收 `rules`，`put()` 内先过 `checkContent`（隐私底线 + profile 扩展），被拒返回 `{ids: [], skipped}` 且不写库；`writeBack` / `backfill` / `memory.add` / `tiers.remember` 全部继承。负向用例：绕过 hooks 直接 `put` 凭据形态被拒、库零行（存量回扫测试改为直插 SQL 模拟闸门上线前的行）。
- 2026-10-08：**条目 8（`project` 派生链 + 跨全域检索）完成** —— `HooksOptions.project` 变可选，派生链 = 显式配置（含函数形式）> 会话 `header.cwd`（`HookHost` 回调补 `header.cwd`，`attach` 透传）> `process.cwd()`；自动巩固的静态作用域改为「显式配置 ?? `process.cwd()`」。检索面：`TierSet.search()` 覆盖已打开层并按 U > 当前 P > 其他 P > S 加权；跨项目 P 只有显式 `tiers.crossProjectRoots` 才打开（`TierSet` 标 `current`）。+3 用例（派生链三态）。
- 2026-10-08：**条目 10（容量、寿命与清理）完成** —— 字节口径 `(page_count − freelist_count) × page_size`（删行不缩文件，不扣空闲页会永远「超限」）；`tiers.enforceLimits()` 按**缺口**淘汰（平均每条字节折算条数，作废现状「每轮固定 50 条」）：S 层先就地降级（只挑 `summary IS NULL` 且 `importance < 5` 的行）再硬淘汰，P 层直接淘汰，**U 层软上限只告警**；巩固触发时顺带执行并记日志。淘汰顺序 `importance → last_referenced → id`。**踩坑**：初版用「字节不再下降」判收敛 → 压缩后页分配在 61K / 69K 间抖动导致死循环（探针实测），改为「候选耗尽」终止 + 轮数安全网。+4 用例。
- 2026-10-08：**本轮到此为止的验证** —— 全仓 `npm run check` 0 error、`npm run build` exit 0、`npm run test` **21 包全绿**（memory-base 3,640 → 80 例）。**未做**：条目 5 / 9 / 11 / 12 / 13（分类注册制 / 提升链与审阅 / `output-compress` 自持 `digest.db` / `doc_index` / TUI 侧改造），按剩余预算与质量优先原则停下，留待后续回合。
- 2026-10-08：**条目 5（分类注册制）决策点提交** `3cf496b`（BACKLOG 标〔进行中〕+ 本节「条目明细」，含调研 / 决策 D36–D43 / 三段规划）。
- 2026-10-08：**条目 5 一段开工（未提交，留工作区）** —— `src/router.ts` 追加注册表：`KindSpec` / `RegisteredKind` / `KindColumn` / `KindVerdict` / `KindWriteInput` / `KindRouteQuery`、`kindTableName()`（`kind_<归一化>` 派生 + 白名单与影子表名拦截）、`FALLBACK_TABLE = "chunks"` 与 `fallbackSpec()`（D38）、`KindRegistry`（`register` 去重与同表互斥 / `resolve` / `fallback` / `pick`＝显式 kind > 事件认领 > 兜底 / `list` / `participants` 按 `routes` 规则）。**尚未接线**：`schema.ts` 建表助手与 `knowledge.ts` 的闸门 / union 未动，故本段是纯新增（无调用方）。验证：`memory-base` `npm run check` 0 error、`npm run test` 80 例仍全绿。下一步（同条目）：`schema.ts` 的 `ensureKindTable` / `ensureKindFts`，再 `knowledge.ts` 接线。
- 2026-10-08：**条目 5 二段完成（三段代码全部写完，未提交，留工作区）** ——
  - **一段（DDL + 闸门 + union）**：`schema.ts` 抽 `ensureSources()` + `ensureKindTable(db, table, columns?)`（基类列 = v1 `chunks` 形状 + 注册方**可空**扩展列；索引 `idx_<table>_project_lr` / `idx_<table>_source`、双 FTS5 影子表、3 个写直达 TRIGGER 全部随表生成，幂等 `IF NOT EXISTS`；`ensureSchema` 改为 `ensureSources + ensureKindTable(chunks)`，索引名与旧 DDL 一致）；`knowledge.ts`：`PutInput.kind` / `SearchOptions.kind` / `SearchHit.kind`、构造收 `{rules?, registry?, allowFallback?}`（缺省自建只含兜底分类的注册表 = v1 兼容），`put()` 三级闸门（隐私 → 分类 `pick` → `preWrite` 钩子，钩子可建议 `importance`）+ 按需建表（`#ensured` 缓存）+ 去重 / INSERT 落该分类物理表，`search()` 改跨已注册分类**并集**（`(kind, id)` 去重键 D39；未建表分类跳过；LIKE 兜底与 `last_referenced` 刷新按表执行）；`rules.ts` `SkipReason` 增 `"kind" | "hook"`。
  - **二段（跨表维护）**：新增 `RowRef = {kind, id}`；`touch` / `evict` / `compress` / `setImportance` 收 `RowRef`（裸 `number` 作 v1 兼容 = 兜底表行）；五个候选方法（eviction / demotion / stale / budget / boost）与 `targetRows` / `promote` 改逐表取数后按同序**合并排序**（跨分类全局优先级，非按表轮流）；`evict` 的 `sources.chunk_count` 聚合**全部分类表**重算（D40，防误删来源）；`rescanDenied` / `tokenBudgetUsage` / `countAll()` 跨表遍历；消费方 `budget.ts` / `writepolicy.ts` 类型直通不改，`consolidate.ts` 合并段收集 `RowRef`（报告仍报裸 id）、`tiers.enforceLimits` 行数统计改 `countAll()`、`tiers.forget` 与服务面 `forget` 收 `(number | RowRef)[]`、`memory.ts` 直写 SQL 改用 `kb.fallbackTable` 插值。
  - **三段（接线 + 配置 + 服务面）**：`KnowledgeConfig.defaultKind`（兜底分类名，缺省 `default`，物理表仍 `chunks`＝D38）；`createKnowledgeBundle` 建共享 `KindRegistry` 传入单库与 `TierSet.open`（`OpenTierSetOptions.registry`）；`openStore` 按 **U 层 `allowFallback: false`**（§5：未显式给已注册 kind 一律拒写）；服务面新增 `registerKind(spec)`（注册后按需建表，同名 / 同表重复抛错）；`index.ts` 导出 `KindRegistry` / `fallbackSpec` 与 `KindColumn` / `KindSpec` / `RegisteredKind` 类型。
  - **顺带修复（D42 同根因）**：`writepolicy.writeBack` / `backfill` 拒写不计 `written` 也不入 `pending`（重试必然再拒）；`memory.add` 空 `ids` 显式抛错（原返回 `{id: undefined}`）；`hooks` 把分类闸拒写计 `skipped.kind`（原误计 dedup）。
  - **测试**：新增 `tests/kinds.test.ts` 11 例（拒写回报 / 按需建表与 kind 标签 / 事件认领 / 钩子拒绝与 importance 建议 / U 层禁兜底 / 跨分类 union 含 CJK LIKE 路径 / 跨表删除 + D40 聚合回归 / **加表不迁移**（旧库重开注册新分类即可写、`user_version` 不动）/ D42 三调用方回归 / 注册表约束 / D43 grep 断言——`src/` 不出现具体分类名）；既有 4 例按新契约修正（`capacity` / `writepolicy` 的候选断言改 `.map(ref => ref.id)`；`tiers` / `bundle-tiers` 的 U 层写入显式 `kind`）。
  - **验证**：全仓 `npm run check` 0 error、`npm run build` exit 0；`memory-base` **91/91**（80 基线 + 11 新增）。
- 2026-10-08：**条目 5（分类注册机制）完成收尾** —— 提交 `3b0b432`（实现，src 10 文件）与 `687dbb2`（测试 11 例 + 4 例适配）；README 同步（能力表 `kind` / `RowRef` / `skipped` 口径 + 新增「分类注册机制」小节 + 配置表 `defaultKind`）；BACKLOG §2 移除已完成条目并按工作量升序重排（新编号 1 TUI / 2 `output-compress` / 3 `doc_index` / 4 提升链，可执行序 3 → 4 → 1 → 2）。与规划的三处偏差：①测试落 `tests/kinds.test.ts`（规划写的 `registry.test.ts`——用例实际覆盖闸门到检索全链，不止注册表）；②`ensureKindFts` / `listKindTables` 并入 `ensureKindTable` 一体生成（FTS / TRIGGER 随表同建，无需独立函数，`resetSchema` 也无需泛化 DROP 清单——它只在空库上运行）；③规划中的「单库路径补 `rules` 注入」**未做**——需把 `SessionHooks` 的规则编译提前并改其构造契约（`kb` 先于 `hooks` 创建，循环依赖），超出本条目验收；现状单库路径仍有内置隐私底线闸，事件路径经 hooks 含 profile 自定义 `denyPatterns`，仅 `writeBack` / `memory.add` / `remember` 三条直写路径在单库模式下缺自定义模式（分层模式无此缺口，`TierSet` 各库已注 `hooks.rules`）。**文档保留**：本文件承载其余未完成条目，不入 `archived/`（全部条目关闭后随文档归档）。
- 2026-10-08：**条目 3（文档索引 `doc_index`）完成** —— 决策点文档按用户裁定与关闭提交合并（未单独提交）。实现三段落地：
  - **一段（表 + 扫描器）**：`schema.ts` 新增 `ensureDocIndex(db)`（`doc_index` 表 + `doc_index_fts` 只挂 `section_title` / `summary` 两列 + ai/ad/au 写直达 TRIGGER + 两个索引；P / U 库 open 时幂等建、S 层不建，不 bump 版本）；`package.json` 新增首个运行时依赖 `@dsh-toolset/md-logic`（`link:../md-logic`，node_modules 符号链接手工建立——npm 对 `link:` 协议报 Unsupported URL Type，与 `md-map` 现状同构）；新 `src/doc-index.ts` 扫描器：glob 展开（node:fs `glob`）→ `parseMarkdownDocument` 切节（节树展平，一节一行；摘要 = 节内首个非空非标题行、剥列表 / 引用标记、≤300 字符）→ 差异写入（文件 hash 变才 DELETE + INSERT）→ 三态更新（文件消失只标 `missing`；**读失败保留旧行不标 missing**——可能暂态）；判变缓存（doc_ref → mtime+size+hash）由调用方持有，mtime+size 命中跳过重哈希；**空 include = 功能关闭 no-op**（不动已有行——配置摘掉 ≠ 全部 missing，实测发现后修正）。
  - **二段（检索 + 接线）**：`knowledge.ts` `search()` 并集并入 `doc_index`（固定标签 `DOC_INDEX_KIND = "doc"`；未给 `kind` 参与并集、显式 `kind: "doc"` 独查、给其他 kind 不参与；`missing` 恒过滤；P 行按项目过滤、U 行 `project = ''` 对所有项目可见；CJK 走 LIKE 兜底同样覆盖；命中带 `SearchHit.doc = {ref, lineStart, lineEnd}` 回指，`importance = 0` 标示非记忆行）；`index.ts` 配置 `docIndex.{project,user}.include`（**缺省均不索引**）+ `maybeConsolidate` 变 async 挂增量扫（与容量兜底同链同节流）+ bundle 增 `scanDocs(only?)` + 服务面挂 `scanDocs`；判变缓存每库一份由 bundle 持有。
  - **三段（收尾）**：README（能力表 `scanDocs` / 检索并集口径 / 新增「文档索引」小节 / 配置表 `docIndex` 行）；本条提交：测试 `552bd3f`（5 例），实现与决策 / 收尾文档按用户裁定合并进关闭提交。
  - **验证**：全仓 `npm run check` 0 error、`npm run build` exit 0；`memory-base` **96/96**（91 基线 + 5 新增）。
- 2026-10-08：**条目 1（提升链 I → S → P → U）完成** —— 决策点经**子代理审阅**（用户 2026-10-08 新流程：决策后子代理审阅、其余检查点直接提交）：裁定**有条件通过**，7 项必须改全部采纳折入 D49-D54（rejected 终态墓碑 + reject_reason；`summarized` 转换闸——未概括且无 caller 不得落上层，保住「失败不提升不降级」；六列幂等 ALTER 补齐（promoted_to / promoted_from / origin / reviewer / reviewed_at / projects，STRICT 表实测可行）；promote 入队隐私闸；markConflict 服务面；approve 无外层事务（put 去重重试安全）；candidates 独立上限 5 MB 清最旧）+ 建议项（redundant 子串合并——P→U ≥2 判据的前提、normalize/redundant 导出复用、conflict 全链 user-only、每轮 ≤20/≤10、设计回写 §6 概括时点与 §9 加列例外、调研「memory.ts 同判据」表述修正）。实施三段：
  - **一段（数据层）**：`schema.ts` `ensureCandidatesTable`（三库各一张，无 FTS，`(kind, fact_key)` 唯一索引）+ `ensureColumn` 幂等加列；新 `src/promote.ts`（`factKeyOf` / `promoteCandidates` 幂等入队 / `listCandidates` / `approveCandidate` / `rejectCandidate` / `editCandidate` / `markConflict` / `resolveConflict`）；`PutInput.origin` 持久化 + `tiers.remember` 透传。提交 `3599730`（代码）+ `3d10d00`（测试 5 例）。
  - **二段（生产 + 接线）**：`promoteSessionToProject`（判据 = 命中过 OR 决策类事件，每轮 ≤20；扫源库写目标库分离）/ `promoteProjectToUser`（importance × 近期引用，每轮 ≤10，跨项目推同事实靠幂等 + 子串合并累积 projects）/ `pruneCandidates` / `markSourcesPromoted`（kind 经注册表解析表名——兜底 default 的表是 chunks）；`index.ts` `setLlmCaller` 可插拔注入 + `bundle.promotion` 门面 + 服务面 `promote` / `candidates.*` / `setLlmCaller` + `session/disposed` 监听（防御式宽化 on 签名）+ compaction 传 sessionId + 巩固链挂 P→U 生产与容量兜底 + approve 后 ② 下层标记。提交 `a296fd8`（代码）+ `70e42c6`（测试）。
  - **三段（收尾）**：README 提升链小节；本记录；BACKLOG 移除条目重排。
  - **验证**：全仓 `npm run check` 0 error、`npm run build` exit 0；`memory-base` **102/102**（96 基线 + 6 promote）。

### 条目明细：TUI 侧改造（§12 #13）

#### 调研（2026-10-08，只读子代理侦察 + 本文件复核）

- **/memory 现状**：无子命令——`TUI/src/app/commands.ts:195,314-318` 注册、`index.ts:2829-2831` 分发、`index.ts:3917-3932` 只读 `adapter.memorySummary` 出 notice。search / add 等是设计规划面未落地。
- **面板基础设施可复用**：QuestionPanel（`QuestionPrompt.ts` + `state.ts:657-679` 题目结构 + `question-transition.ts` 状态机）；**TUI 自主面板先例 = 退出确认**（`index.ts:143-151` 合成 id + 本地结算、不经宿主应答链）；宿主 waterfall 提问是另一条链（`adapter/dsh.ts:2440-2496`）。
- **服务键消费点**：仅 `main.ts:586-588` **急读快照**（插件装载顺序晚于 TUI 时为 undefined——guard/sessionChannel 已改懒读，此处漏改）；`KnowledgeServiceLike` 只有 getSummary/whenReady。
- **--all-projects**：`crossProjectRoots` 是 bundle 启动期定死（`TierSet` 私有不可变）；配置后「其他项目 P」**已自动参与** `tiers.search`。动态运行时开口（运行中追加库）不存在。
- **审阅消费面**：`candidates.{list,approve,reject,edit,markConflict,resolveConflict}` 服务面齐备（条目 1 落地）；approve 有 LLM 概括闸（llm-unavailable 保持 pending，面板需呈现该失败态）。
- **user 凭据**：数据面闸要求 U 候选 / 冲突候选 `reviewer === "user"`；TUI 面板结算函数内写死 `"user"` 即满足「user 标记只由用户发起动作生成」；TUI 现无 agent 自主调 `candidates.*` 的路径。

#### 决策（D55–D59）

- **D55 范围**：本条目 = ① `/memory` 子命令化（缺省概要 / `review` / `search [query] [--all-projects]` / `add <target> <content...>` 走 `remember` 直达并 `origin: "user"`）；② 审阅面板（消费 `candidates.*`）；③ `main.ts` knowledge 懒读改造 + `KnowledgeServiceLike` 扩签名。**--all-projects v1 = 静态版**：crossProjectRoots 配置后其他项目 P 已自动参与检索，命令负责显式标签与未配置提示；**动态运行时开口（运行中追加其他项目库）记观察项**，不在本条目做。
- **D56 面板形态**：复用 QuestionPanel + **exit-confirm 合成 id 模式**（TUI 自主开面板、本地结算、不经宿主应答链）。一候选一题：题干 = `[tier] kind · 标题`（U 候选 / 冲突候选标注「需用户裁定」），detail = content + sources / projects / conflict_with 的 markdown；选项 = 批准 / 拒绝，**edit = 自定义兜底项**（custom 文本即改写内容）。整批 pending 合成多题（`itemIndex` 游标逐条推进）；submit 结算时**逐条**调 `candidates.*`（`reviewer` 在结算函数内写死 `"user"`，不参数化）；单条失败（llm-unavailable / not-found / forbidden）出 notice 回执、不阻塞后续条目。
- **D57 懒读与类型**：`main.ts:586-588` 急读改 getter 懒读（对照 guard/sessionChannel 既有改法）；`KnowledgeServiceLike` 扩 `candidates.{list,approve,reject,edit,markConflict,resolveConflict}` 与 `search`（宽松子集类型，防宿主形状漂移）。
- **D58 面板并发**：宿主 question **优先**——本地面板打开时收到宿主 waterfall 提问 → 宿主覆盖（本地面板作废，重开入口保留）；本地面板想打开时若宿主 question 挂起 → 拒绝打开并 notice「先处理当前提问」。
- **D59 数据漂移兜底**：面板是快照——结算遇 `not-found` / `not-pending`（巩固链 edit 重算 fact_key、容量清最旧）→ notice「该候选已变化，跳过」；队列重开即拉新快照。

#### 决策修订（2026-10-08 子代理审阅：有条件通过，6 项必须改全采纳）

- **D56-a 未答条目跳过**：`buildQuestionAnswers`（question-transition.ts:146-149）对无选项条目回退提交高亮项——结算**绕开默认回退**，直接读 panel.items：无 selected 且无 custom = 跳过并 notice（防「没碰过的候选被批量批准」）。
- **D56-b 冲突候选走裁定不走审批**：`conflict_with != null` 的题选项换 `resolveConflict` 四裁定（keep-old / accept-new / merge / edit）——approve/reject 对冲突候选会留「新旧并存」，违反 §6.1。
- **D55-a `/memory add` 补 kind**：签名 `add <target> [--kind <k>] <content...>`——U 层禁兜底（allowFallback false），user 目标无 kind 必被拒；报错时列出已注册分类。
- **D58-a 宿主覆盖留痕**：覆盖时 notice + 编辑草稿按候选 id 暂存、面板重开恢复（防静默丢编辑）。
- **D58-b 打开态派生化**：审阅面板打开态 = `state.question?.id === 合成 id`（不复制 exitConfirmOpen 只在 finish/cancel 复位的标志陷阱）。
- **D56-c 结算守卫与回执**：结算 in-flight 守卫（禁重开 / 二次 submit，防并发结算同候选）；reject reason 定值 `"panel-rejected"`；verdict 处理补 `not-pending` / `duplicate-fact`。
- **采纳建议**：submit 结算后自动重拉三库 pending 快照 + 汇总 notice（X 成功 / Y 失败 / Z 仍在待审）；`--all-projects` 帮助文案写明「标注非开关」、命中标注来源项目路径（LayeredHit.project）；BACKLOG 补 `/memory replace|remove` 后续条目（remove 是错误 U/P 条目唯一删除路径，forget 面就绪无调用方）；demo mock 补候选样例覆盖面板冒烟；llm-unavailable notice 写明「内容已改写、待下次巩固重概括」。

#### 规划：分三段落地

**一段（接线与子命令）**：`main.ts` 懒读；`adapter/types.ts` 扩签名；`adapter/dsh.ts` 增审阅数据 / 动作方法；`commands.ts` + `index.ts` `/memory` 子命令化（概要 / search --all-projects / add）+ help 同步。

**二段（审阅面板）**：`index.ts` `handleMemoryReview`（三库 list 合并按 created_at 排序）+ 合成 id 面板 + submit/cancel 分支（逐条结算 + reviewer="user" + 失败回执）+ D58 并发守卫 + hints。

**三段（收尾）**：TUI 测试（面板帧断言 + 结算分支）+ README/COMMANDS 文档 + BACKLOG 收尾。

#### 明确不做（本条目边界）

- 不做动态跨项目库开口（运行时追加 otherProjectRoots）——记观察项。
- 不做 I→S 候选的专属呈现（I→S 候选在 S 库 candidates，面板一并列出即可，无特殊化）。
- 不做批量 approve（设计「一次一条逐条处理」）；不做 reviewer 参数化（凭据约束）。
- 不改 memory-base 数据面（消费面已就绪）。
- 2026-10-08：**条目 2（TUI 侧改造）完成** —— 决策点经子代理审阅（有条件通过，6 项必须改全采纳：未答条目跳过 / 冲突候选走 resolveConflict 四裁定 / add 补 kind / 宿主覆盖草稿暂存 / 打开态派生化 / 结算守卫；建议项采纳：submit 后自动重拉快照、--all-projects 标注非开关、`/memory replace|remove` 记 BACKLOG 后续条目候选、llm-unavailable 回执语义）。实施：
  - **一段（接线与子命令）**：`main.ts` knowledge 急读改 getter 惰读；`adapter/types.ts` `KnowledgeServiceLike` 扩 search / remember / candidates.\* + 新 `CandidateRowLike` / `MemoryReviewVerdictLike` / `MemoryCandidatesLike` + `DshAdapter` 增七个 memory 方法（reviewer 写死 "user"）；`app/index.ts` `/memory` 子命令化（缺省概要 / `review [tier]` / `search [--all-projects]` 静态版标注 / `add <tier> [--kind k]`——U 层无 kind 显式拒绝）。提交 `0c46aa8`。
  - **二段（审阅面板）**：合成 id `memory-review` 面板（照 exit-confirm 模式，不经宿主应答链）；一候选一题（普通=批准/拒绝，冲突=裁定四选项，edit=自定义兜底项文本）；结算未答跳过（绕开 `buildQuestionAnswers` 默认回退）+ 单条失败回执不阻塞 + 完成自动重拉快照汇总；宿主 question 优先 + 覆盖时编辑草稿按候选暂存恢复；submit/cancel 本地分支。同上提交。
  - **三段（收尾）**：TUI README `/memory` 行更新；测试 `tests/memory-review.test.ts` 4 例（面板分化 / 未答跳过 / 冲突裁定路由 / add kind 闸）；BACKLOG 移除条目重排（剩 output-compress 自持 digest.db）。测试提交 `b7b907f`。
  - **踩坑**：① dispatch 传入的 `line` 含 `/memory` 前缀（同 /session 口径），子命令解析前需剥离；② adapter 方法解构调用丢 `this`（fake adapter 用实例字段）——统一 `.call(adapter, ...)`；③ 断言受 100 列画布截断影响——测试画布加宽到 120。
  - **验证**：TUI `npm run check` 0 error、`npm run build` exit 0、`npm run test` **1345 全绿**（+4 新例）；memory-base 102/102 不回归。
