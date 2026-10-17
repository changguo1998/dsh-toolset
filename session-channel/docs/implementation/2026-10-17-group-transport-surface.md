# 群组编排所需的传输面：服务面核对 + 别名持久性与自动别名分配（接取条目：`session-channel/docs/BACKLOG.md`「补群组编排（agent-group）所需的传输面：服务面核对 + 别名持久性」；「自动别名分配在词表耗尽后静默失效」）

状态：决策（2026-10-17）　　开启：2026-10-17　　关闭：未关闭
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮范围：调研 + 决策，不写实现代码（用户 2026-10-17 指示：在本会话内开工三个模块条目、不开新 worktree、做完决策后停下等审阅）。工作区：主检出 `main`。

## 目标

为群组编排插件（`agent-group`）落定传输面口径：出一份对着代码核过的服务面核对表（「投递指令」「收取回报」两个操作各对应哪个方法及其参数 / 返回），并把别名的自动分配时机与持久性从「设计推断」落成有代码依据的结论。按用户 2026-10-17 裁定，本任务还包含**修自动别名的分配**：扩容词表 + 给自动别名加 4 位哈希后缀（见决策项 4），故同时接取缺陷条目「自动别名分配在词表耗尽后静默失效」。

## 调研

来源：`docs/implementation/2026-10-16-peer-group-protocol-design.md`（S2 / S3 / S5）、`session-channel/src/**`、`session-channel/README.md`、`session-channel/docs/DESIGN.md`、`session-channel/docs/archived/2026-10-01-auto-alias.md`、`session-channel/tests/**`；只读源码 + 只读 `redis-cli`（`SCAN` / `TTL` / `GET`）+ 宿主包类型声明实读。未运行测试、未改文件。

01. **设计要什么**（设计 `:116`「传输接入 `src/transport/`：`inject` session-channel 服务面，封装「投递指令」与「收取回报」两个操作；服务面方法名以实现前核对为准」）：配套决策项 1 选「三条腿全走 session-channel，任务表自带 TTL 与懒超时、显式回传优先」、决策项 14 选「每连接一条未结指令、结算懒判定」、决策项 16 定回报信封为「成功 / 失败 / 受阻 + 正文 + 成因，不解析正文」、决策项 20 把广播推到二期。
02. **服务面全量 16 方法**（`src/index.ts:1514-1541`；键清单 `SERVICE_FACE_METHODS` `:1459-1477`）：`peers` `:423`、`send` `:434`、`inbox` `:449`、`aliasSet` `:466`、`aliasList` `:481`、`aliasClear` `:507`、`status` `:529`、`kvSet` / `kvGet` / `kvList` / `kvDelete` `:534` / `:552` / `:571` / `:586`、`delegate` `:603`、`taskStatus` `:693`、`taskList` `:724`、`taskCancel` `:760`、`taskResult` `:788`。
03. **两个操作均无缺口**：投递指令 = `delegate({from?, to, text, timeoutSec?, ttlSec?, waitMs?})`（`:603`，参数 `types.ts:181-194`）→ `{ok, task, messageId, delivered, target}`（`:676-682`），`task.id` 即指令 id，注入正文形如 `TASK <id>: <正文>`（`src/tasks.ts:62-69`）；收取回报 = 主方 `taskStatus(taskId)`（`:693`，返回整个 `TaskRecord`，含 `status` / `result` / `resultSource` / `error`，`types.ts:145-178`，且**读取时懒判定超时**并回报给委托方）或批量 `taskList({sessionId?, status?, limit?})`（`:724`）；从方回报口 = `taskResult({taskId, text, failed?, error?})`（`:788`，`resultSource:"tool"` 优先于轮末 `turn/end` 自动回收 `:879-921`）。`send` / `inbox` 是同一通道更裸的形态（无 id 归属、无超时）。
04. **唯一对不位处**：设计决策项 16 的「受阻」在 `TaskStatus` 里没有对应值（只有 `pending / running / done / failed / canceled / timeout`，`types.ts:145-146`）。
05. **别名唯一性与写入规则**（`src/broker.ts:158-196`）：字符集与保留字校验 `:164-177`（`keys.ts:43`、`:100-110`）；占用冲突 → `alias_taken` + `holder`，`force` 可覆盖 `:178-186`；「一会话一别名」靠写入前先清自身旧名 `:187`，再 `set` 新名 `:188`（**未核实**：这两步非原子，无 Lua / MULTI，同会话并发两次 set 理论上可留下两个别名）。
06. **目标唯一命中是硬约束**（`src/broker.ts:381-395`、`:401-443`）：寻址序 sessionId 精确 → 别名 → `cwd:<绝对路径>`；0 命中 `target_offline`（`:415-420`）、多命中 `target_ambiguous`（`:421-426`）；**别名存在 ≠ 可寻址** —— `resolveTarget` 只在在线对端里找（须 alive 键在 TTL 内且 pid 存活，`:89-92`），离线直接报错、不排队（`README.md:103`）。
07. **自动别名的生成时机（纠正设计推断）**：全仓唯一生成点是 `src/index.ts:360-378` 的 `#autoAlias`，触发点是 `noteSession` 的**首见分支**（`:409-419`；会话已跟踪则 `:391-395` 早退），而 `noteSession` 由 `host.on("session/event")` 驱动（`:318-321`）。故真实时机 = **「本进程首次观察到该会话的 `session/event`」** —— 既不是设计 S3 推断的「首次用到才生成」，也不是 `docs/archived/2026-10-01-auto-alias.md:19` 写的「等价启动即生成」。前缀由 `aliasPrefixFor` 决定（`src/alias-words.ts:172-184`：`header.origin === "subagent"` 或 `delegationDepth > 0` → `sub-`，否则 `ui-`）。`DESIGN.md:95`「会话跟踪上限 32；`session/event` 未覆盖的会话不会被跟踪」是同一件事的现行表述。
08. **持久性成立（有代码依据）**：别名键 `dsh:session-channel:alias:<alias>`（`src/keys.ts:28-31`）**无 TTL**（实测 `TTL` = `-1`），值即 sessionId；Redis 实例 `appendonly yes`（`README.md:33`）；宿主 resume 复用持久化会话 id 作为活会话身份（`@deepseek-ai/dsh-agent` 类型声明 `lib/types/index.d.ts:110-111`、`dsh-agent-loop/lib/index.js:1928`、`:1935`；本机 TUI `TUI/src/app/adapter/dsh.ts:4178` → `:4196-4200` 的 `agents.resume({resumeSessionId: id})`，id 取自会话列表 `TUI/src/app/index.ts:4247`、`:4299`）。同 id 会话再次出现时 `#autoAlias` 因「已有别名」跳过（`index.ts:364`）→ **名字不漂移**。故 S5 第 2 项「别名修补尚未落地」是伪命题：持久性本就成立，真问题是覆盖率（第 9 条）。
09. **自动别名的覆盖率缺陷（实测，比设计推断严重）**：别名表 295 条 = 自动 294（`ui-*` 146 + `sub-*` 148）+ 显式 1（`docs`）；词表 `AUTO_ALIAS_WORDS` 共 148 词（`src/alias-words.ts` 表末）→ **`sub-` 命名空间已 100% 占满**（新子代理永远拿不到自动别名），`ui-` 占 146/148。`#autoAlias` 只在首见时试一次、冲突重试上限 `AUTO_ALIAS_TRIES = 8`（`alias-words.ts:166`）、耗尽后**静默返回**（`index.ts:366-377`，无日志）。实测 11 个在线会话中**只有 1 个**有别名 → 自动别名事实上已不可依赖。
10. **文档层级**：`README.md:20` 只列方法名；`:65-76` 的服务面表只到「方法 + 一句语义」（仅 `delegate` `:74` 与 `taskResult` `:76` 给了字段形状，`send` / `inbox` / `peers` / `alias*` / `kv*` 都没有参数与返回类型）→ 正是核对表的落点。寻址口径见 `README.md:12`、`:103`、`:105` 与 `DESIGN.md:20`、`:40`。**别名生成时机与持久性在 README 与 DESIGN 里都没有表述**（grep 无命中），只在 `docs/archived/2026-10-01-auto-alias.md:19`、`:21` 有历史口径。
11. **测试面与牵连**：7 个测试文件 + `helpers.ts`（`README.md:122` 写「47 例」，静态计数约 49 —— 本轮未运行核实）。新增或删除服务面方法必牵 `tests/apply.test.ts:225`（D5 守卫的两处 `deepEqual`：`SERVICE_FACE_METHODS` ↔ `provide` 键 ↔ `SessionChannelService.prototype` 公开方法，`internalOnly` 白名单 `:240`）与 `:55`；别名生成时机 / 词表改动牵 `tests/alias.test.ts:186`（词表规模与字符集）、`:231`（取词）、`:247`（首见生成）、`tests/service.test.ts:296`（来源标签别名优先）；键 TTL / 清理改动牵 `alias.test.ts:68`、`:88`、`:100`、`:114`、`:130`、`:162`、`:173` 与 `broker.test.ts:106`。用例数变动要同步 `README.md:122`。
12. **两条下游硬约束**：从方成员会话必须**也挂着 session-channel**（注入由目标进程自己的 reader 循环完成，`DESIGN.md:51`）；目标必须在线（`README.md:103`，离线不排队）。

## 决策

决策项 1　服务面是否有真实缺口

- a) 判定无缺口：`agent-group` 侧写薄封装（投递 → `delegate`、收取 → `taskStatus`），只补 `README.md` 的核对表
- b) 新增语义化方法 `dispatchInstruction` / `collectReport`（内部转调）
- c) 本期不加方法，只登记二期的 `broadcast`

**选定 a**。理由：`delegate` 自带 TTL、懒超时与显式回传优先，正合设计决策项 1 与 14（调研 3）；b 与既有方法重复，还要动 `SERVICE_FACE_METHODS` 与 D5 守卫用例（调研 11），+0.5 天只换来词面更直；c 不满足本条「出一份核对表」的要求，广播按设计决策项 20 本来就属二期。

决策项 2　「受阻」怎么承载（设计决策项 16 要求三态信封）

- a) 给 `TaskStatus` 加 `blocked`
- b) 约定 `failed: true` + `error: "blocked: …"` 前缀
- c) 通道不规定语义：`failed` 位表达「是否算失败」，「成功 / 失败 / 受阻」三态由 `agent-group` 在结果正文里自描述

**选定 c**。理由：回报信封是 `agent-group` 的协议面（设计 `:81`「本包只给逐条回报……不解析正文」），通道只负责搬运；把 `blocked` 塞进 `TaskStatus` 会改状态机、任务表用例与跨包契约（调研 4、11），而收益只是一个机器可读判别位 —— 若 `agent-group` 确需判别位，应放在结果正文里，而不是扩状态机。b 可作为 `agent-group` 侧的约定备选，本轮不定。

决策项 3　别名持久性：核对结论

- a) 判定「恢复后不变」成立，不做代码改动，只把口径写进 README / DESIGN
- b) 仍要加代码强化持久性
- c) 判定不保证，登记口径收缩为 sessionId

**选定 a，但口径要写全**。理由：调研 8 给出三条代码依据（键与 sessionId 绑定且无 TTL、宿主 resume 复用同一 sessionId、同 id 再见时跳过重命名），持久性本就成立 —— 设计 S5 第 2 项的前提不成立，不必写代码。c 也不必要（别名确实稳定，只是可能压根没分配）。

决策项 4　自动别名的覆盖率缺陷怎么处置

- a) 本任务不修：只在 README / DESIGN 写明「自动别名不保证分配成功」，并把 `agent-group` 的登记口径收缩为「sessionId + 显式 `alias set`」；分配器缺陷另立条目
- b) **本任务一并修**：扩容词表 + 给自动别名加 4 位哈希后缀
- c) 本任务只把「静默失败」改为可见（日志或 `status()` 暴露），其余另立

~~**选定 a**~~（已由用户 2026-10-17 裁定取代）。原理由：修分配器属行为变更，牵 `src/alias-words.ts`、`#autoAlias` 与 3 处用例（调研 11），且要一并复核 2026-10-01 的既有裁定（词表 ≤8 字符不缩减）。

**选定 b（用户 2026-10-17 裁定：更新词表 + 别名后缀加 4 位哈希 / 随机字符串）**，机制落定如下：

- **词表扩容**：`AUTO_ALIAS_WORDS` 由 148 词扩到 **≥ 256 词**，保持既有约束（≤8 字符、ASCII 字母、不与保留字冲突、无重复；2026-10-01 的「词表不缩减」裁定继续守，只增不减）。
- **命名规则**：自动别名改为 `<前缀><词>-<4 位 hex>`，例 `ui-otter-3f9a`（总长 ≤ 16，仍在 `[A-Za-z0-9_-]{1,32}` 校验内）。
- **后缀取确定性哈希而非随机串**：4 位 hex = `sha256(sessionId)` 前 4 位。两者在唯一性上等价（容量 148 × 65536 × 2 量级，词表耗尽问题消失），但确定性后缀对同一个 sessionId **可复现**，便于排障，也为将来做「别名可重建」留门（当前仍以别名表为准，键无 TTL 已保证恢复后同名，见决策项 3）。
- **重试循环保留**：`AUTO_ALIAS_TRIES = 8` 与 `alias_taken` 判定不动，作为安全网；另加一行 `console.warn`，真走到耗尽时不再完全静默（这一项是在 b 之上顺手补的可见性，若不要请说）。
- **既有别名不动**：本机 295 条旧格式别名（无后缀）原样保留，不重命名、不回收。
- **一处目视核对**：别名长了 4 个字符（`ui-iris` → `ui-otter-3f9a`），实现时在真机看一眼 TUI 状态列的显示是否被挤（不改 TUI 代码）。
- **条目归属**：缺陷条目「自动别名分配在词表耗尽后静默失效」由本任务一并接取（标〔进行中〕），不再交其他 agent。

决策项 5　核对表落到哪一层，`peers()` 是否补 `alias` 字段

- a) `README.md:65-76` 的服务面表补「参数 → 返回」列，并新增一节「群组编排用法与成员寻址口径」；`peers()` 不动（`aliasList()` 已能给 `{alias, sessionId, online}` 的关联）
- b) 同 a，并给 `peers()` 加 `alias` 字段
- c) 另写一份独立文档

**选定 a**。理由：核对表的读者是 `agent-group` 的实现者，放在服务面表旁查找成本最低；b 改的是跨包契约（`PeerInfo` 加字段要同步 `types.ts` 与用例），只省一次 `aliasList` 关联；c 会与 README 的服务面清单形成两份来源。

决策项 6　两条下游硬约束写在哪

- a) 写进 README 新增的「群组编排用法」一节
- b) 只写在 `agent-group` 侧

**选定 a**。理由：调研 12 的两条是通道自身的性质（从方进程必须也挂本插件；目标必须在线、离线不排队），写在通道文档里才不会随消费方的实现漂移。

## 规划

本轮（调研 + 决策）改动文件清单：

- `session-channel/docs/BACKLOG.md`（本条目标〔进行中: 2026-10-17〕；追加缺陷区条目「自动别名分配在词表耗尽后静默失效」）
- `session-channel/docs/implementation/2026-10-17-group-transport-surface.md`（本文件）

实现阶段（待用户审定本轮决策后执行）改动文件清单：

- `session-channel/src/alias-words.ts`：`AUTO_ALIAS_WORDS` 扩到 ≥ 256 词（守既有约束）；新增后缀生成（`sha256(sessionId)` 前 4 位 hex）；`pickAutoAlias` 改为拼 `<前缀><词>-<hex4>`
- `session-channel/src/index.ts`：`#autoAlias` 改用新命名规则（传入 sessionId 以算后缀）；重试耗尽时补一行 `console.warn`
- `session-channel/README.md`：服务面表 `:65-76` 补「参数 → 返回」；新增「群组编排用法与成员寻址口径」一节（含调研 12 的两条硬约束与决策项 2 的三态承载口径）；`边界与限制` 的别名条 `:105` 补自动别名口径（生成时机、无 TTL、恢复后不变、新命名规则与 4 位后缀）；用例数 `:122`
- `session-channel/docs/DESIGN.md`：`:40`（寻址与 `setAlias` 流程）与 `:95`（会话跟踪）旁补生成时机与持久性口径；`:85` 服务面键集合处标注核对表所在
- `session-channel/tests/`：新增用例钉住 —— 别名与 sessionId 绑定且键无 TTL、同 sessionId 再次出现不重命名、`delegate` → `taskStatus` 往返（含懒超时结算与 `resultSource` 优先级）；更新 `tests/alias.test.ts` 的词表规模 / 约束 / 取名（含后缀）用例与 `tests/service.test.ts` 的来源标签用例；按需更新 `README.md:122` 的例数

明确不做：不新增服务面方法（决策项 1）；不改 `TaskStatus` 与任务状态机（决策项 2）；**修自动别名只改命名规则与词表** —— 不动 `alias:<名>` 的键位与「无 TTL」语义、不改 `setAlias` 的唯一性判定与 `force` 覆盖、不重命名 / 不回收既有 295 条旧别名（决策项 4）；不加 `broadcast`（设计决策项 20 属二期）；不动 TUI 与 `agent-group` 侧代码。

## 实现记录

（本轮为决策轮，未进入实现；待用户审定决策后按「规划」的清单执行。）

## 偏差

无（本轮只做调研与决策，未承诺实现动作）。

## 测试与证据

本轮为决策轮，未改代码，故未跑 `check` / `build` / `test`；调研阶段的事实证据：

- 只读 `redis-cli`：`SCAN` 别名键得 295 条（`ui-*` 146 / `sub-*` 148 / 显式 `docs` 1）；`TTL dsh:session-channel:alias:sub-weevil` = `-1`（无 TTL）；在线键 11 个，其中仅 1 个会话有别名。
- 实读宿主包类型与实现：`@deepseek-ai/dsh-agent/lib/types/index.d.ts:110-111`、`dsh-agent-loop/lib/index.js:1928` / `:1935`（resume 复用 `resumeSessionId` 作为活会话 id）→ 支撑调研 8。
- 未运行 `npm run test`：`README.md:122` 的「47 例」与静态计数（约 49）的差额留到实现阶段核实。
- 未核实项：`setAlias` 的「清自身旧名 + 写新名」并发原子性（只做源码判读，未做并发测试）；宿主是否存在「会话创建」类事件（若要做确定性时机分配才需要，本轮决策不依赖它）。

## 收尾

- 本轮不归档：两个条目（「补群组编排（agent-group）所需的传输面：服务面核对 + 别名持久性」与「自动别名分配在词表耗尽后静默失效」）均保持〔进行中: 2026-10-17〕，本文件留在 `session-channel/docs/implementation/`，等用户审定决策后进入实现。
- 回写文档：本轮无（实现阶段才动 `README.md` / `DESIGN.md`）。
- 遗留项：缺陷条目「自动别名分配在词表耗尽后静默失效」已按用户 2026-10-17 裁定由本任务**一并接取**（实现阶段随决策项 4 一起做），不再交其他 agent；`agent-group` 侧需同步「登记目标用 sessionId 或显式别名，不依赖自动别名」这条口径（属该包实现时的事）；实现阶段需真机目视一次别名变长后的 TUI 状态列显示。
