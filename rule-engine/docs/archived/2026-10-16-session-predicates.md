# 内置谓词 `session-fresh` / `session-resumed`（接取条目：rule-engine/docs/BACKLOG.md「内置谓词层加 `session-fresh` / `session-resumed`（配置可按「是否恢复」筛选）」）

状态：关闭　　开启：2026-10-16　　关闭：2026-10-16
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

让**配置面**能区分「全新会话」与「从记录恢复 / 重载的会话」：在匹配条件层新增两个内置谓词 `session-fresh` / `session-resumed`，规则配置、持久化规则与 `rule_add` 工具面直接可用，无需写消费者代码。

## 调研

来源：2026-10-16 用户问询（「rule-engine 能区分全新会话和重启重新加载的会话吗」→「在哪一层可以灵活处理, 只需要能够在配置里提供这个功能」）与代码复核。

1. 触发面：`session-start` 映射宿主 `session/created`（含恢复）——`src/engine.ts:869-877`（`sessionCreated` → `#dispatch("session-start", …)`），监听侧 `src/main.ts:222-227` 只过滤子代理会话；`directWrite: session-start` 刻意跳过记录判重，故恢复会话会再注入一次（`README.md:73`）。
2. 现有节点共 10 个（`src/types.ts:16-26`），没有 `session-restart` 一类插入点；宿主 context 事件只有 `session/created` / `session/event` / `session/flush` / `session/disposed`（`docs/host/DSH-CTX-API.md:32`），没有独立的恢复事件。
3. 宿主判据：`session/created` 的载荷是 Session 实例，`session.seq` = 事件日志长度（`dsh-session/lib/index.js:1401-1403`，`get seq()`），`inheritedEventCount` = fork 继承前缀长度；宿主自己的 `dsh-session-projection/lib/index.js:53-54` 就用 `session.seq !== 0` 判「已有历史」。
4. 谓词面现状：`src/match.ts:17-26` 的 `PREDICATES: Record<PredicateName, (text: string) => boolean>`，仅吃文本；`CompiledMatcher.match(text, source)` 有两个调用点 `src/engine.ts:429`（`evaluate` 干跑）与 `:702`（规则判定），其中只有后者能拿到会话状态；`rule_add` 的 `predicates` enum 由 `predicateNames()` 派生（`src/tools.ts:51`），新增谓词自动可见。
5. 零改动替代：`dedupeInRecord: 1` + 不把 `session-start` 放进 `directWrite`（`README.md:72-73`）已能实现「重载不重复注入」，但它按「记录里是否已有本注入」判断且 fail-open；本谓词面向需要**精确区分**或差异化文案的场景。

## 决策

1. 落在哪一层
   - a. **内置谓词层**（`predicates`）：加两个谓词，配置 / 规则 / 工具面自动可用
   - b. 新增触发节点（如 `session-restart`）
   - c. 消费者层（写代码读 `ctx.event`）
   - **选定 a**（用户 2026-10-16 裁定「可以, 按照这个走标准流程实现」）：不改触发面语义、不改消费者注册契约，配置即可用；b 会引入与 `session-start` 重叠的节点并牵动尺度对齐表，c 不满足「在配置里提供」。
2. 谓词语义与判定时机
   - a. 每次现读 `session.seq`（动态值）
   - b. **首次见到会话时判定一次并记住**（会话级稳定事实）
   - **选定 b**：`seq` 是事件日志长度，会随事件增长 —— 现读会让同一会话内「fresh」在 `session-start` 之后立刻变假；记一次才符合「本会话是否为恢复而来」的语义。
3. 判定判据
   - a. `seq > 0`
   - b. `seq > 0 || inheritedEventCount > 0`
   - **选定 b**：fork / 种子继承型会话（`inheritedEventCount > 0`）同样属于「非全新」，归入 `session-resumed`。
4. 命名
   - a. `session-fresh` / `session-resumed`
   - b. `session-new` / `session-reloaded`
   - **选定 a**：与既有谓词命名风格（小写连字符、描述性质）一致，且「resumed」与宿主恢复语义同词。

## 规划

计划改动文件清单：

| 文件 | 改动 |
| --- | --- |
| `rule-engine/src/types.ts` | `PredicateName` 加两名；`MatchContext`；`ConsumerContext` 继承之 |
| `rule-engine/src/match.ts` | `PREDICATES` 签名加 ctx；`CompiledMatcher.match(text, source, ctx?)` |
| `rule-engine/src/engine.ts` | `SessionState.resumed` + 首次判定；规则判定传 ctx；`handle` / `sessionCreated` 传 session |
| `rule-engine/tests/match.test.ts` | 两谓词的纯函数语义与缺省 ctx、`predicateNames()` |
| `rule-engine/tests/sessionPredicates.test.ts` | 新建：引擎侧 9 例（恢复 / 全新 / fork / 会话内稳定 / 消费者 / 兜底） |
| `rule-engine/README.md` | 谓词表补两名 +「会话谓词」小节 + 消费者 ctx + 配置示例 + 用例数 |
| `rule-engine/docs/BACKLOG.md` | 条目状态（进行中 → 关闭时清理） |
| `rule-engine/docs/implementation/2026-10-16-session-predicates.md` | 本追踪文档 → 关闭后移入 `archived/` |

明确不做：新增触发节点；改 `session-start` 语义或 `directWrite` 行为；消费者注册契约变化；TUI 侧改动。

## 实现记录

- 2026-10-16：建档并标〔进行中〕；四项决策落定（谓词层 + 会话级稳定 + `seq`/`inheritedEventCount` 判据 + 命名）。
- 2026-10-16：`src/match.ts` —— `PREDICATES` 改 `(text, ctx)`（既有 4 个谓词忽略 ctx），新增 `session-fresh` / `session-resumed`；`match(text, source, ctx?)` 第三参缺省 `FRESH_CONTEXT = { resumed: false }`。
- 2026-10-16：`src/types.ts` —— `PredicateName` 加两名（带语义注释）、新增 `MatchContext`、`ConsumerContext extends MatchContext`（消费者 `decide` 的 ctx 可直接作为匹配器第三参）。
- 2026-10-16：`src/engine.ts` —— `SessionState.resumed`；`#session(sessionId, session?)` 仅在**首次**创建时按 `isResumedSession(session)`（`seq > 0 || inheritedEventCount > 0`，结构面读取、属性抛错按 fresh）判定并记住；`handle` 各分支与 `sessionCreated` 把宿主 session 传入（兼作「插件后挂载」兜底）；规则判定传 `{ resumed: state.resumed }`。
- 2026-10-16：测试 —— `tests/match.test.ts` 补谓词真值与缺省 ctx、`predicateNames()`；新建 `tests/sessionPredicates.test.ts`（9 例：恢复 / 全新 / fork / 会话内稳定 / 消费者路径 / 错过 `session/created` 的兜底 / 二次 `sessionCreated` 不重判 / 缺省与 getter 抛错兜底 / 干跑口径）。
- 2026-10-16：`README.md` 补谓词表两名、「会话谓词」小节（判据 / 判定时机 / 会话内稳定 / 与 `dedupeInRecord: 1` 的分工）、消费者 ctx 说明、配置示例 `resumed-notice`、用例数 140 → 151。

## 偏差

1. **`evaluate()` 干跑路径不传 ctx**：原计划「两处 `matcher.match` 调用点都传 ctx」中的 `src/engine.ts:429` 属 `evaluate()`（`EvaluateInput` 只有 `text` / `source`、无 `sessionId`），拿不到会话状态 → 该处走缺省 `{ resumed: false }`，即干跑与 `rule_test` 一律按「全新会话」口径判定（代码注释、README、用例⑨固定该行为）；真正带会话的规则判定路径（`#collectRules`）按决策传 `{ resumed: state.resumed }`。
2. **`ConsumerContext` 增只读字段 `resumed`**（继承 `MatchContext`）：规格外的小增量，为满足「消费者路径同样生效」的验收；`registerConsumer` 入参 / `decide(context)` 形状与既有消费者代码均未变。
3. **`sessionCreated` 第二参更名 `event` → `session`**（类型仍 `unknown`，`src/main.ts` 位置传参兼容）——语义更准确；未改 `main.ts`（不在允许清单，且无需改）。
4. **引擎侧用例落新建文件** `tests/sessionPredicates.test.ts`（规格二选一），`tests/engine.test.ts` 未动，缩小 diff。
5. **规格外防御**：`seq` / `inheritedEventCount` 属性读取抛错时按 fresh 兜底、不向宿主派发抛错（有用例覆盖，无未覆盖分支）。
6. **未做**：`npm run build` 与真机验证留到主线收尾（本文件「测试与证据」记录主线补跑结果）；恢复出来的**空**会话（`seq === 0` 且无继承）按判据仍算 `session-fresh`，未实机构造该形态。

## 测试与证据

- `npm --prefix rule-engine run check`（`tsc -p tsconfig.json --noEmit`）：0 错误。
- `npm --prefix rule-engine test`：`ℹ tests 151 / pass 151 / fail 0`（改动前基线 140 例，+11）。
- 覆盖率（`node --experimental-transform-types --experimental-test-coverage --test 'tests/*.test.ts'`）：`all files` 行 **100.00** / 分支 96.96 / 函数 97.90（改动前 100.00 / 96.91 / 97.84 —— 不回退）；`match.ts` 100.00 / 100.00 / 100.00。
- 反向验证（把 `resumed: isResumedSession(session)` 改成恒 `false`）：6 例转红 —— `✖ 恢复会话（seq > 0）…`、`✖ fork 形态…`、`✖ 会话内稳定…`、`✖ 消费者路径…`、`✖ 错过 session/created…`、`✖ 已有会话不覆盖…`（`pass 145 / fail 6`）；恢复后 `pass 151 / fail 0`。
- 改动范围：`git status --porcelain` 仅 `rule-engine/` 内路径（README / BACKLOG / `src/{engine,match,types}.ts` / `tests/match.test.ts` + 新建 `tests/sessionPredicates.test.ts` 与追踪文档），无 `src/*.js` 等产物。

## 收尾

- 回写：`rule-engine/README.md`（谓词表 +「会话谓词」小节 + 消费者 ctx + 配置示例 + 用例数）；`docs/BACKLOG.md`（条目移除 + 关闭记录）。
- 归档：本文件移入 `rule-engine/docs/archived/2026-10-16-session-predicates.md`。
- 遗留：真机验证（`dsh --profile fff` 重启后看 `session-resumed` 规则的注入行为）与「恢复出来的空会话」形态未验。
