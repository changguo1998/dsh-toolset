# output-compress 接入 memory-base 作用域句柄（接取条目：`docs/BACKLOG.md`「`output-compress` 接入 memory-base 作用域句柄（`promote` 取消后的 I→S 推送路径重定）」）

状态：完成（2026-10-18）　　开启：2026-10-17　　关闭：2026-10-18
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
轮次：调研 + 决策（2026-10-17，主检出 `main`）→ 实现 + 文档（`feat/output-compress` worktree）→ 收尾（2026-10-18）。

## 目标

把 `output-compress` 与 memory-base 的接口从「`registerKind` + `promote` 提升链」改成「注册分类拿作用域句柄、自己决定推什么」—— 即 memory-base 重设后的新写入面；同时把 `promote` 消失后必然失效的那条推送路径重定，并订正两边文档里描述旧「共库直写」安排的段落。

## 调研

来源：`output-compress/src/index.ts`、`src/hooks.ts`、`src/digest-db.ts`、`docs/DESIGN.md`、`README.md`、`tests/**`、`cordis.patch.yml`；`memory-base/docs/implementation/2026-10-17-slim-and-storage-surfaces.md`；本机 profile（只读）。**调研推翻了条目正文的一处前提**，见第 7 条。

01. **本包自持 `digest.db`，不直写 memory-base 的库**（关键纠正）：`src/digest-db.ts:1-17` 的文件头写明「自持索引库 digest.db（设计 §3.1 I 层契约，决策 D60 修订）：指纹 `0x44494745`（'DIGE'）+ `user_version` 1；表 `digests` 一张 + FTS5」；落点为 `config.sessionDir` 下的 `<sessionDir>/digest.db`（`digest-db.ts:369-372`、`src/index.ts:127-129`），**打开前 `existsSync` 且不 `mkdir`**，缺目录即 `skipped.sessionDirMissing`。库内自管 100 MB 上限与六类形态闸（`deny-patterns.ts`）。

02. **与 memory-base 的耦合只有两处**：`registerKind({kind: DIGEST_KIND})`（`DIGEST_KIND = "digest"`，`src/index.ts:35`、调用点 `:142`）与 `promote(items)`（`src/hooks.ts:31-33`、`:54-55`、`:332-340`、`:388-398`）。两者都以可选依赖形态声明（`?:`），缺失不报错。

03. **`promote` 只用于 `is_error` 的 digest**：`hooks.ts:4` 注释「`is_error` 行经 promote 服务面推 I→S 候选（决策 D62）」；`pushDigest` 在 `promote` 不存在时直接 `return`（`:338-339`），digest 行保持未推（`none`），等 `promotePending()`（`:367`）在巩固时重推；`promotePending` 另外做一次「候选容量自查」。

04. **memory-base 重设后这两处的命运**：`promote` 整条取消（`promote.ts` 删除）→ I→S 推送路径必然失效（调用恒早退，`promotePending` 永远推不成功）；`registerKind` 改为返回**写入作用域句柄** `MemoryScope = {kind, writableTiers, put, forget}`，`KindSpec` 收到 `{kind, table?, writableTiers?, preWrite?}`。

05. **配置面**：本包现行配置键为 `sessionDir` / `minBytes` / `maxSourceBytes`（`src/index.ts:37-46`），**没有 `dbPath`**（本仓内 `dbPath` 只剩 `docs/DESIGN.md:40` 的一处旧表述与测试里的局部变量名）。

06. **本机 profile 的配置与代码不匹配**（新发现，仓库外）：`~/.dsh/profiles/fff/cordis.patch.yml:39-42` 给 output-compress 配的是 `dbPath: … memory-base/memory.db`（与 memory-base 同一个库路径），而代码读的是 `sessionDir` —— 于是 `sessionDir` 为 `undefined` → `resolveSessionDigestPath` 返回 `null` → **本机 digest 管线整条跳过**（`skipped.sessionDirMissing`），即本包的核心能力在这台机器上当前是关的。**2026-10-17 已按用户指示修复**：profile 该行改为 `sessionDir: !!js dshHomePath('output-compress')`（原键保留为注释说明），并创建落点目录 `~/.dsh/output-compress/`（`drwx------`；插件按设计不自建目录）；见决策项 8 与「测试与证据」。**2026-10-17 后续裁定**：这属**过渡形态** —— 用户同日裁定把 `digest.db` 改回「每会话一个文件」（经 `session-paths` 服务推导），故该 profile 行在本包代码改完后要删掉；见决策项 9。

07. **条目正文的一处前提不成立**：项目级条目原文写「直接对同一个 `dbPath` 插 `sources` / `chunks`，靠 `category = "output-compress"` 与 `target = "output-compress"` 标记归属（`memory-base/README.md:112`）」—— 这是**旧安排的描述**：代码已在 D60 改成自持 `digest.db`，本包根本不写 memory-base 的行，因此「语义列被删导致行归属丢失」这个问题**不存在**。据此本任务把条目标题与正文一并订正（见「规划」）。

08. **文档漂移（两侧都在描述旧安排）**：`memory-base/README.md:112` 仍写「与 `output-compress` 共库直写（同一 `dbPath`）」；`memory-base/README.md:141-142` 的「未完成」清单仍把「`output-compress` 自持 `digest.db`」列为未做（其实已做）；`output-compress/docs/DESIGN.md:40`「与 memory-base 的通信面是**同一个 SQLite 文件**」与 `:62`「`category`/`target` 固定为 `output-compress`，检索时按此过滤」同样过期。

09. **测试面**：5 个文件 1158 行 —— `hooks.test.ts`（679，管线端到端，含 `digestRows`/`countDigests` 直读库）、`digest-db.test.ts`（182，自持库与形态闸）、`summary.test.ts`（151）、`trigger.test.ts`（88）、`deny-parity.test.ts`（58，与 memory-base 的形态模式对拍）。与本次改动直接相关的是 `hooks.test.ts` 里围绕 `promote` 的用例（推成功 / 推失败 / `promotePending` 重推 / 容量自查）。

10. **本文与 memory-base 任务的分工**：memory-base 侧的 README / DESIGN 订正归它自己的任务（其「规划」已列「按新定位重写 README / DESIGN」，含订正 `:141-142`）；本任务只订正 output-compress 自己的 `docs/DESIGN.md` 与 `README.md`。

11. **同一面墙 memory-base 也会撞上**（跨任务发现）：宿主未暴露「会话目录」读取面（`memory-base/src/router.ts:10-11`），`sessionDirFor` 约定拼接函数存在但**全仓无人调用**（`router.ts:70-79`，只有定义与文档）。memory-base 现行靠 `if (tierConfig.sessionDir === undefined) paths.session = dbPath`（`memory-base/src/index.ts:346`）兜底；而重设去掉了 `dbPath`、层级又恒开启 → **S 层将没有可推导的落点**，除非给出会话目录。宿主侧的编码实现在 `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`（`encodeSegment:853-865` / `projectKey:875-894` / `projectDir:902-905` / `sessionDir:912-914`，均不导出；`projectKey` 会把路径包成 `--…--` 并对非白名单字符做 `~XXXX` 转义，所以 `router.ts:70-79` 那份复刻算出来的目录并不存在）。**用户 2026-10-17 裁定**：新建 `session-paths` 插件复刻宿主函数供其他插件共用 （项目级条目已在 `docs/BACKLOG.md` 登记）；本条的两处受影响项随之为：决策项 2 的 `session` 层经该服务取目录，以及决策项 8 的 `digest.db` 落点将来可改回「每会话一个文件」（本轮已按 `~/.dsh/output-compress/` 修好，不返工）。

## 决策

决策项 1　I→S 推送路径怎么重定（`promote` 已不存在）

- a) 去掉推送：`is_error` 的 digest 只留在自持 `digest.db`，不再进 memory-base
- b) **自持推送**：注册 `digest` 分类拿句柄，由本包自己判据、用句柄 `put` 写入 memory-base
- c) 保留对 `promote` 的调用（已不可行 —— 方法随 `promote.ts` 一并删除）

**选定 b**。理由：a 会丢掉「错误摘要可被检索」这条既有能力（DESIGN §6 的召回口径正是靠知识库 FTS，模型拿到命中后用 `read` 定位回 spill 文件）；c 不可行；b 恰好是 memory-base 新定位要的形态 —— 提升链取消后，「哪些内容值得入库」这份判断本来就该由产出方自己持有，本包又已经握有判据（`is_error`）与自己的闸（六类形态模式）。
影响面：`src/hooks.ts`（`pushDigest` / `promotePending` 改为走句柄）、`src/index.ts`（拿句柄并保存）、`tests/hooks.test.ts`。

决策项 2　写入哪一层、`writableTiers` 怎么声明

- a) **`session` 层**，`writableTiers: ["session"]`
- b) `project` 层，`writableTiers: ["project"]`
- c) 两层都声明，按 digest 类型分流

**选定 a**。理由：digest 是「本次会话里某次工具输出的摘要」，与 spill 文件同寿命；`session` 层的库落在 `<会话目录>/session.db`，与本包自持的 `digest.db` 同处一个目录，**不会额外在项目里建 `.dsh/`**。原先 I→S 的语义也正是「会话层」。将来若要跨会话保留，把 `writableTiers` 加上 `project` 并改一次 `tier` 即可（一行）。b 的代价是在每个项目里建 `.dsh/`，c 目前没有第二种 digest 类型可分流。**前置**：`session` 层要被 memory-base 认下来，前提是它能推导出会话目录 —— 而宿主未暴露该读取面（调研 11）；若 memory-base 侧最终判定「S 层不可用」，本条改选 b（写 `project` 层）即可，改动只是 `writableTiers` 与 `tier` 两个值。

决策项 3　缺 memory-base / 缺句柄时的降级

- a) 沿用现行「永不抛错」口径：降级为 `skipped` + 计数
- b) a + **启动时一次性明确日志**（「memory-base 未挂载 → digest 只留本地，不入知识库」）
- c) b + 在工具回执里提示

**选定 b**。理由：条目验收明确要求「缺 memory-base 时有明确提示，不静默」；a 的现状正是被诟病的那点（digest 行停在 `none` 且无任何提醒）。c 会改动工具回执文案，而 digest 管线多数不发生在工具回执链路上（有 spill 通知即推），收益不明确，留到需要时再说。

决策项 4　`registerKind` 的 spec 与 `preWrite`

- a) **`{kind: "digest", writableTiers: ["session"]}`**，不声明 `preWrite`
- b) 另加 `preWrite`，把本包的六类形态闸再挂一层到 memory-base 侧
- c) 换 kind 名（如 `output_digest`）

**选定 a**。理由：库核心已有隐私闸（凭据 / 私钥形态命中整条拒绝），本包自己写 `digest.db` 前也过 `deny-patterns.ts` 六类形态；再挂 `preWrite` 属重复，且会把本包的规则语义漏进 memory-base。c 的改名会让已有 `digest` 语义（`DIGEST_KIND`）与设计文档里的命名分叉，无收益。

决策项 5　`promotePending()` 的去留

- a) **保留方法名与语义，但把「重推」实现改为「用句柄重试未写成功的 digest」**，去掉候选容量自查
- b) 整个删掉（连巩固重推一起放弃）
- c) 保留原样（不可行 —— 依赖 `promote`）

**选定 a**。理由：重试语义本身有价值（写入失败 / 当时没句柄 / 当时没挂 memory-base），只是载体从「候选队列」换成「本包自己的未推标记」；候选容量自查是 memory-base 候选表的配套，随该表消失。

~~决策项 6　自持 `digest.db` 与旧数据~~（**2026-10-17 撤销**：两条都是「不做改动」、无可执行取舍；落点与上限归决策项 9，旧数据归既有口径「不迁移直接删」，其唯一有信息量的一句「表结构与指纹不变（`0x44494745` / `user_version 1`）」已并入决策项 9。）

决策项 7　文档订正范围

- a) **本任务订正 `output-compress/docs/DESIGN.md` §5 与 §6 的旧口径 + `README.md` 的依赖与边界表述**；memory-base 侧（`README.md:112` / `:141-142`）归 memory-base 任务的 README / DESIGN 重写范围
- b) 本任务连 memory-base 的文档一并订正（跨模块，超出范围）
- c) 都不改（留错）

**选定 a**。理由：memory-base 的 README / DESIGN 本来就在它自己任务的「计划改动文件清单」里（按新定位重写），本任务插进去会破坏「计划外文件一律不改」；而 output-compress 自己的两份文档属本任务范围。

决策项 8　本机 profile 的废键（`dbPath`）怎么处置

- a) 只记进本文件「遗留项」，由用户自行改
- b) **本任务顺手改 profile**：把 output-compress 的 `dbPath` 换成 `sessionDir`（仓库外文件，需用户明确批准）
- c) 另立一条 BACKLOG 条目交其他 agent

~~**选定 a + 请示**~~ → **改选 b（用户 2026-10-17 裁定：「条目内容增加任务，修复这个问题」）**。原理由（当时不选 b）：profile 是仓库外文件，全局规则要求「项目目录之外要改动先取得明确要求」。

**选定 b 的落地（2026-10-17 已完成）**：① `~/.dsh/profiles/fff/cordis.patch.yml` 里 output-compress 的 `dbPath: … memory-base/memory.db` 换成 `sessionDir: !!js dshHomePath('output-compress')`（原键写成注释留痕），仍是「一个键、显式路径」，不动代码、也不改插件「解析不到就告警 + 跳过、不静默换路径」的既有口径（D60-b）；② 创建落点目录 `~/.dsh/output-compress/`（0700）—— 沿用其他插件各自占 `~/.dsh/<包名>/` 的格局。

- 落点口径：`digest.db` = `~/.dsh/output-compress/digest.db`，**全机一个文件**（不是每会话一个）；会话维度由表内 `session_id` 承担（去重键本就是 `(session_id, content_hash)`）。若要改成按项目或按会话分文件，把该键换成 `dshHomePath('sessions', …)` 形态即可，属后续可选调整。
- 键名与语义的偏差（`sessionDir` 实际含义是「digest 落点目录」）记为实现阶段的改名候选，本轮不动（改名要同步 README / DESIGN / 代码三处）。

决策项 9　`digest.db` 落点：改回「每会话一个文件」（用户 2026-10-17 裁定，取代决策项 8 的过渡形态）

- **表与指纹不变**：`digests` 表结构与库指纹 `0x44494745` / `user_version 1` 都不动（原决策项 6 唯一有效的一句，随其撤销并入本条）；变的只是文件数量与位置（每会话一个文件）与随之而来的「100 MB 上限是每会话每文件」。
- **机制**（2026-10-17 第二轮订正口径）：`hooks` 在 `session/event` 的会话视图里拿 `session.id`（`src/hooks.ts:161-162`），经新包 `session-paths` 的服务 `sessionPaths.sessionDirFor(sessionId)` 推导落点（同步；取 `header.cwd` 收在 `session-paths` 内部，**本包不再自己读 `header.cwd`** —— 见 memory-base 决策项 11 选 d）；服务缺失或会话取不到 → 沿用 `skipped.session-dir-missing` + 计数，不静默换路径。`cwd` 缺失不再是降级条件：那一刻按宿主的 `_no-cwd` 桶落点。
- **配置键退为覆盖**：`sessionDir` 配了就优先用它；故 profile 里那行在本改动落地时删掉（现在先留着，否则代码改完前管线会变回全跳过）。
- **前置**：`session-paths` 尚未落地（条目在项目级 `docs/BACKLOG.md`「新增 `session-paths` 插件：复刻宿主的会话目录编码，供其他插件共用」），本项排在该包之后。
- **附带后果**：digest 从此只在本会话可见（跨会话检索不再覆盖未推送的 digest；`is_error` 摘要经句柄进 memory-base 那条路不受影响）；`digest.db` 的 100 MB 上限变成每会话每文件。

## 规划

### 实现前冻结的接口（消费方按此写）

**上游两处的确切调用**（memory-base 重设后的新面 + `session-paths`）：

```ts
// ① 取写入句柄（apply 时一次并缓存；缺面 → 记一次性日志后不再试）
const scope = memory.registerKind({ kind: "digest", writableTiers: ["session"] });

// ② 推 is_error 摘要（hooks 的 pushDigest）
await scope.put({
  content,                     // renderSummaryRecord 的概要
  tier: "session",
  sessionId,                   // 本会话 id（S 层落点由 memory-base 自算，见其决策项 11）
  project,                     // cwd 或项目名
  title: `output-compress ${tool} ${sessionId.slice(0, 8)}#${seq ?? "n"}`,
  source: { kind: "tool_result", ref: `digest:${sessionId}:${id}`, label: tool },
});

// ③ digest.db 落点（决策项 9）
const dir = sessionPaths.sessionDirFor(sessionId);   // <会话目录>；同步，内部自己取 cwd
const digestDbPath = join(dir, "digest.db");
```

**七条口径**：

1. `put` 的 `tier` 固定 `session`，`writableTiers` 只声明 `session`；越权层由 memory-base 抛错（属编程错误，不应发生）。
2. `sessionId` 必给（S 层写入必需）；取不到会话 id → 不写、记 `skipped`。
3. 内容先过本包既有 `deny-patterns` 闸，再入库（两道闸都要过）。
4. `digest.db` 落点：配置 `sessionDir` 退为**显式覆盖**（配了优先）；缺省经 `sessionDirFor(sessionId)` 推导（同步）；取不到（服务缺失 / 会话取不到 / 抛错）→ `skipped.session-dir-missing` + 计数，**不静默换路径**。
5. `promotePending()` 保留名字，语义改为「重试**可重试的**未写成功 digest」，去掉候选容量自查；幂等（同一 digest 不重复写）。**三种结果分档（2026-10-17 第二轮接口核对后冻结，对齐 memory-base 的错误形态）**：① `put` 成功 → 记「已推」；② `put` 返回 `PutResult.skipped`（内容级：隐私闸命中 / `preWrite` 拒）→ 记 `skipped.<reason>` + 计数 + 一次明确日志，**标「不重试」**（重试也不会通过，否则是无限重试）；③ `put` 抛错（参数 / 权限级：越权层、未注册 kind、写 S 层拿不到 `sessionDir`）→ 记 `skipped.error` + 计数 + 一次日志，同样**不重试**（属编程错误，不应发生）。只有「句柄缺失 / 当时没挂 memory-base」这类**能力缺失**才进「未推」集合、由 `promotePending` 重试。
6. 与 memory-base / `session-paths` 都是**可选依赖**：缺面 → 降级 + 一次性日志，**永不向调用方抛错**（`pushDigest` 全程 try/catch 包住 `put`，抛错按第 5 条的 ③ 归档，不让异常冒到 `session/event` 钩子外）。
7. 不再有任何 `promote` / `candidates.*` 调用（memory-base 已删这些面）。

**前置**：memory-base 重设（提供句柄）与 `session-paths`（提供 `sessionDirFor`）落地之后；未落地时本包按可选依赖缺失降级（决策项 3b）。

**仓库外两处已执行**（2026-10-17，用户裁定一并修）：`~/.dsh/profiles/fff/cordis.patch.yml` 的 `dbPath` 废键换成 `sessionDir`；新建 `~/.dsh/output-compress/`（0700）作为过渡落点。

实现阶段（两包前置落地后执行；决策已审定）改动文件清单：

- `output-compress/src/hooks.ts`：`pushDigest` 改为「句柄可用 → `put({tier: "session", sessionId, content, title, importance, source})`，不可用 → 记 `skipped` + 未推标记」（`sessionId` 是 S 层的必需参数，不能省，见冻结接口 ②）；`promotePending` 改为重试未推 digest，去掉候选容量自查；删 `PromoteServiceLike` 与 `MemoryPromoteLike.promote`
- `output-compress/src/index.ts`：`apply` 时 `registerKind({kind: DIGEST_KIND, writableTiers: ["session"]})` 并存下返回的句柄；缺 memory-base 时打一次性明确日志；类型声明随 `MemoryScope` 更新
- `output-compress/docs/DESIGN.md`：§5「写入」改写为「自持 `digest.db` + 经句柄向 memory-base 推 `is_error` 摘要」；§6 的 `category`/`target` 归属口径改为「按 `kind: digest` 归属」
- `output-compress/README.md`：能力段与边界段同步（依赖面、句柄、缺面时的行为、`sessionDir` 落点）
- `output-compress/src/hooks.ts`（决策项 9）：会话视图改用 `sessionPaths.sessionDirFor(sessionId)` 推导 `digest.db` 落点（**不自己读 `header.cwd`**）；`src/index.ts` 同步配置语义（`sessionDir` 退为覆盖）
- `~/.dsh/profiles/fff/cordis.patch.yml`（**仓库外**）：决策项 9 落地时删掉本包那行 `sessionDir`（现为过渡覆盖）
- `output-compress/tests/hooks.test.ts`：围绕 `promote` 的用例改写为「句柄 `put` 成功 / 句柄缺失 → 明确降级 / `PutResult.skipped` 与 `put` 抛错 → 记 `skipped.<reason>` 或 `skipped.error` 且不重试 / `promotePending` 只重试能力缺失项」；其余文件按需微调

明确不做：不改自持 `digest.db` 的指纹、表结构与 100 MB 上限（决策项 6）；不声明 `preWrite`、不改 kind 名（决策项 4）；不动 memory-base 的文档与代码（决策项 7）；不动 TUI；profile 的那行已改（决策项 8）、其删除属决策项 9 的落地动作；不新增模型侧工具（本包的 digest 召回已由 memory-base 新增的全局只读查询与 `memory_query` 覆盖）。

### 任务拆分（5 步，每步带中间验证）

1. **取句柄与降级**（`src/index.ts`）—— `registerKind({kind: DIGEST_KIND, writableTiers: ["session"]})` + 句柄缓存 + 缺面一次性日志；类型声明随 `MemoryScope` 更新。验证：假 memory 服务的单测（有句柄 / 无句柄两态）+ 该包 `check`。
2. **推送改造**（`src/hooks.ts` 的 `pushDigest`）—— `promote(items)` → `scope.put(...)`，仍仅 `is_error` digest；删 `PromoteServiceLike` 与 `MemoryPromoteLike.promote`。验证：单测断言 `put` 入参形状（tier / sessionId / source.ref / title）。
3. **`promotePending` 重写** —— 扫「未写成功的 digest」重试，幂等，去掉候选容量自查。验证：四例 —— 能力缺失（首次无句柄）→ 第二次成功，计数正确；`PutResult.skipped`（内容级）→ 记 `skipped.<reason>` 且**不再重试**；`put` 抛错 → 记 `skipped.error` 且不重试；重复调用不双写。
4. **落点改推导**（`src/hooks.ts` + `src/index.ts`）—— 会话视图里本就有 `session.id`（`src/hooks.ts:161-162`），改调同步的 `sessionDirFor(sessionId)`，**不再自己读 `header.cwd`**；`sessionDir` 配置退为覆盖。验证：四例（服务可用 → 落在会话目录 / 服务缺 → `skipped.session-dir-missing` / 会话取不到 → 同上降级 / 配置覆盖优先）。
5. **文档与真机**（`docs/DESIGN.md` §5/§6 + `README.md`）—— 去掉共库直写与 `promote` 记述，写清句柄、落点与新降级口径。验证：该包 `test` 全绿 + 根三件套 + 真机一次。

### 实现阶段的验证口径（怎么跑）

- **单测**：`npm --prefix output-compress run test`（现有 5 个测试文件）；假 memory 与假 `session-paths` 两件可替身。
- **机械**：根 `npm run check` + `npm run build` + `npm run test` 三件全绿。
- **真机**：重启 `dsh --profile fff`，造一次大输出与一次失败命令 → 核对 `<会话目录>/digest.db` 生成、`skipped.session-dir-missing` 不再出现、memory-base 的 `session` 层出现 `kind: "digest"` 的行；**并在此时删掉 profile 里本包那行 `sessionDir`**（过渡覆盖，决策项 9）。
- **不做**：不动 `digest.db` 的表与指纹（决策项 6 已撤销，其有效句并入决策项 9）；不做历史数据迁移（旧的全机 `digest.db` 成孤儿，不迁移直接删）。

### 收尾动作（实现完成时）

- 条目「`output-compress` 接入 memory-base 作用域句柄（`promote` 取消后的 I→S 推送路径重定）」标「完成」并从 `docs/BACKLOG.md` 移除；本文件移入 `docs/archived/`。
- 文档回写：本包 `docs/DESIGN.md` 与 `README.md`（见第 5 步）；根 `README.md` / `README.zh.md` 的能力描述若不涉及依赖面则不动。
- **仓库外**：删掉 profile 里 output-compress 的 `sessionDir` 行（过渡覆盖）—— 需明确要求后执行；删后落点完全由 `sessionDirFor` 推导。
- 前置顺序：本条排在 memory-base 重设与 `session-paths` 之后；两者未落地时本包保持「可选依赖缺失」的降级态（不报错、不阻塞自身功能）。
- 旧数据：`~/.dsh/output-compress/digest.db`（全机一个文件时期的残留）按「不迁移直接删」口径成为孤儿，由用户择时清理。

## 实现记录

实现轮（2026-10-18，`feat/output-compress` worktree，三次提交）：

1. `2aca3ec` **feat(output-compress): 推送改走 memory-base 作用域句柄并按会话落 digest.db**
   - `src/hooks.ts`：新增句柄接口 `MemoryScopeLike` / `ScopePutInputLike` / `PutResultLike` / `SessionPathsLike`（`:57`、`:65`）与三档结果 `DigestPushResult`（`:71`）；配置项改 `digestDbPath?: string | null`（显式覆盖 / 不可用 / 未配置三态）+ `scope` / `getScope` / `sessionPaths`（`:101-105`）；每会话连接表 + `closeDatabases()`（`:230`、`:234`，上限 32）；`resolveDigestPath(sessionId)`（`:387`）；`ensureDigestDb(path)`（`:419`）；`putDigestRow`（`:470`，成功 / 内容级 `skipped` / 抛错 / 能力缺失四路归一为三档）；`recordPushState`（`:522`）；`pushDigest`（`:542`）；`promotePending`（`:565`，只重试 `push_state='none'`、每库 ≤20、去掉候选容量自查）；`pendingPushCount`（`:605`）；`databasesForSweep`（`:620`）；`logOnce`（`:637`）。
   - `src/index.ts`：`MemoryServiceLike`（`:69`）、`resolveSessionPaths`（`:129`）、`resolveMemoryScope`（`:145`，校验返回值带 `put`，非同步形态降级，`:162-165`）；落点覆盖解析（`:188`）、惰性句柄 + 一次性告警（`:205`）、hooks 组装（`:222`）、bundle 增 `pendingPushCount`（`:252`）。
   - `tests/hooks.test.ts`：句柄 `put` 入参形状 `:418`、缺面 `:464`、内容级拒写 `:492`、抛错 `:520`、重推幂等 `:550`、回查补推 `:579`、覆盖缺失 `:611`、每会话一文件 `:627`、非同步句柄 `:665`、推导落点 `:688`、推导失败 `:714`、覆盖优先 `:751`；假 memory 改记 `registerKind` / `put`（去掉 `promote`）。
2. `9d2967b` **docs(output-compress): 订正写入面与落点口径（句柄 / 每会话 digest.db）** —— `docs/DESIGN.md` §1 表行、§5 拆为 5.1 本地索引库 / 5.2 经句柄写 memory-base、§6 归属口径改 `kind` / `tier` / `source.ref` 并补「召回分两处」、§7 两种缺面降级、§8 依赖面表述；`README.md` 能力段、配置表（删 `kbRetryDelays` / `project` 两行陈旧字段）、示例、架构注、测试计数。
3. `e331073` **test(output-compress): 补每会话落点与同步句柄形态用例** —— 两例新用例 + `index.ts` 的同步句柄校验 + README 计数（55 → 57）。

与「规划」清单的差异：连接由「单连接」改为「每会话连接表」（决策项 9 的必然结果）；`promotePending` 的扫描范围限定为**本进程已打开的会话库**（+ 显式覆盖路径），因为每会话落点无法在启动时枚举。

## 偏差

1. **`put` 未传 `project`**：冻结片段（「规划」的 ②）列了 `project`，实现未传 —— `session-paths` 只给目录、取 `cwd` 在其内部，本包手里没有可靠的项目键；S 层不需要它（memory-base 决策项 11 选 d：句柄只收 `tier` + `sessionId`）。
2. **`put` 多传 `importance`**：按 DESIGN 旧语义取 `isError ? 4 : 2`；`importance` 属 `ScopePutInput` 合法字段（clamp 1..5），冻结片段未列但未越界。
3. **`sessionDir` 键名与语义仍有偏差**：实际含义是「digest.db 显式覆盖目录」，未改名（改名要同改 README / DESIGN / 代码三处，留作可选清理）。
4. **归档位置**：本条条目在项目级 `docs/BACKLOG.md`，按 AGENTS.md 分层（跨模块条目归项目级）归档到 `docs/archived/`，与同批 `session-paths` / `auto-approve` 一致；未落 `output-compress/docs/archived/`（该模块此前无此目录，且与条目所在层割裂）。
5. **收尾指令的「本模块 docs/archived/」**：按第 4 条执行并在此记明；如确需放模块目录，移动文件 + 改 BACKLOG 注记一行即可。

## 测试与证据

### 实现轮（2026-10-18）

- `npm --prefix output-compress run check`（`tsc --noEmit`）：通过（格式化后复跑，exit 0）。
- `npm --prefix output-compress test`：实现轮跑到 55 例全绿（句柄改造后的全部用例）。新增的 2 例（每会话一文件 / 非同步句柄）**只写了未在本地跑** —— 随后主会话的全量 `npm run test`（29 包）连同这两例一起通过，结论以该次为准。
- 静态计数：57 例（trigger 9 / summary 9 / digest-db 7 / deny-parity 2 / hooks 30）。
- 未跑：`smoke/smoke.mjs`（需 dsh CLI 与模型凭据，且脚本仍按旧口径配 `dbPath`）；真机未验证。

### 决策轮证据（2026-10-17，历史留存）

本轮为决策轮，未改代码，故未跑 `check` / `build` / `test`；调研阶段的事实证据：

- `sed -n '1,40p' output-compress/src/digest-db.ts`：自持库指纹 `0x44494745`、表 `digests`、落点 `sessionDir`、`existsSync` 不 `mkdir`、100 MB 自管上限。
- `grep -n "promote|registerKind|pushDigest|DIGEST_KIND|memory" output-compress/src/hooks.ts`：`promote` 只在 `pushDigest`（`:332-340`）与 `promotePending`（`:388-398`）出现，且都在 `is_error` 分支之后。
- `grep -rn "dbPath" output-compress/`：源码与配置里没有 `dbPath`，只有 `docs/DESIGN.md:40` 的旧表述与测试局部变量名。
- `grep -n -A5 "output-compress|memory-base" ~/.dsh/profiles/fff/cordis.patch.yml`（只读）：修复前 `:39-42` 给 output-compress 配的是 `dbPath`（废键），未配 `sessionDir`。
- **配置修复的验证（2026-10-17，实读）**：`sed -n '36,48p' ~/.dsh/profiles/fff/cordis.patch.yml` 显示该行已是 `sessionDir: !!js dshHomePath('output-compress')` 且带说明注释；`ls -ld ~/.dsh/output-compress` → `drwx------ 2 guochang guochang`。未跑 yaml 解析、未跑真机。
- 未核实：修复**之前**那套「整条跳过」是从配置与代码判读推出的结论，未跑真机；修复**之后**的效果同样未跑真机（要验证需重启一次 `dsh --profile fff`，在会话里产生一次大输出，看计数里 `skipped.sessionDirMissing` 是否消失、`~/.dsh/output-compress/digest.db` 是否出现）。

## 收尾

- **用户审定（2026-10-17）**：决策项 1 · 2 · 3 · 4 · 5 · 7「这些都没有问题」，决策项 9 随之视作通过；决策项 6 已撤销；决策项 8 已裁定并执行 —— 全部落定。
- **条目关闭（2026-10-18）**：项目级条目「`output-compress` 接入 memory-base 作用域句柄」标完成、从 §2 正文与「实现顺序」表清理（编号未重排，留待下次整理）；本文件移入 `docs/archived/`。
- **回写**：`output-compress/docs/DESIGN.md` §1 / §5 / §6 / §7 / §8 与 `README.md` 已按新写入面改写；根 `README.md` / `README.zh.md` 的 output-compress 行同步为「自持每会话 `digest.db` + `is_error` 经句柄入 memory-base」；`docs/ROADMAP.md` 不含本包相关表述，未改。
- **遗留（已登记为项目级条目 15）**：① 真机验证（`<会话目录>/digest.db` 生成、`skipped.session-dir-missing` 消失、memory-base 的 `kind: "digest"` 行可检索）；② `smoke/smoke.mjs` 按新口径重写（删 `dbPath`、改断言）；③ 删本机 profile 里过渡的 `sessionDir` 行（仓库外）。
- **其他遗留**：`~/.dsh/output-compress/digest.db`（全机一个文件时期的残留）成孤儿，按「不迁移直接删」由用户择时清理；memory-base 侧两处文档漂移归其自身任务的重写。
