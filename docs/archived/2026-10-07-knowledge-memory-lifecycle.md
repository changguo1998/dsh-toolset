# 重新设计长期记忆（知识库 / 持久记忆）模块逻辑（接取条目：docs/BACKLOG.md「重新设计长期记忆（知识库 / 持久记忆）模块逻辑」）

状态：关闭（设计定稿并经四轮独立复审）　　开启：2026-10-07　　关闭：2026-10-08
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
