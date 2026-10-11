# 恢复的历史用户块全 `?`：live 分支回合边界补不全（接取条目：`TUI/docs/BACKLOG.md` 的〈恢复出的历史用户块全部显示 `?`（事件源缺回合边界时补不全）〉）

状态：进行中　　开启：2026-10-12
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

重启（`-c` / `/restart`）后恢复出来的历史用户块按该回合 `turn/end` 的 reason 显示 `✓` / `✗` / `■`，不再一律 `?`；已修复的回合不因边界事件缺失而退化。

## 调研（2026-10-11 真机复核 + 日志探针）

用户报告：重启后**新回合正常**、**重启前的历史用户块全是 `?`**。

用真机日志（`~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/*/session.v4.jsonl.zstd`，zstd 解开后喂给 `dist` 里的 `normalizeHistoryMessages`）做三段探针：

| 探针 | 结果 |
| --- | --- |
| 纯恢复链路（`normalizeHistoryMessages` → `surfaceToBuffer` → `sectionsFromBuffer`） | **不丢终态**：旧会话 8 条用户块 5 条带终态；当前会话 325 条里 250 条（239 ✓ / 2 ✗ / 9 ■） |
| 同一份日志**去掉 `turn/start` + `turn/end`** | **325 / 325 全 `?`** |
| 同一份日志去掉边界后**只并回 `turn/end`**（旧口径） | 边界与正文顺序错乱时归属仍错 |

→ 触发条件是「恢复时读到的事件源缺回合边界」。定位到 `adapter/dsh.ts` 的 `doReadSessionSurface` —— 同一个函数里两条分支口径不一致：

| 分支 | 旧实现 | 结论 |
| --- | --- | --- |
| surface 分支（`readSurface` 折叠面，宿主**明确不含**回合边界） | 缺 `turn/end` 时从 `readSession` 并回**两类边界**（`turn/start` + `turn/end`）且**按 `seq` 排序**（注释记录真机教训：追加到末尾 → 51 个用户块全变 turn 1） | ✓ 正确 |
| live 分支（`opts.sessions.get(id)`） | 只在「**一条** `turn/end` 都没有」时才补；补的时候**只补 `turn/end`**；**追加到事件尾部**（不排序）；读失败 `catch {}` 静默 | ✗ 三处缺一不可 |

内存 store 的边界覆盖可能是**部分**的（旧回合缺、新回合有）→ 旧判据不成立、不补 → 旧回合用户块拿不到收尾原因 → 全 `?`。

## 规划改动文件清单

- `TUI/src/app/adapter/dsh.ts`：live 分支改为「引用回合的边界覆盖不全 → 从 `readSession` 按 `seq` 并回 `turn/start` + `turn/end`」。
- `TUI/tests/adapter.dsh.test.ts`：新增两条回归用例（整段缺边界 / 部分覆盖）。
- 本文档 + `TUI/docs/BACKLOG.md`（条目状态）。

## 实现记录

### 修法（`adapter/dsh.ts`）

1. 抽出 `withTurnBoundaries(id, base)` 一个补齐函数，**live 分支与 surface 分支共用**（原来两处各写一遍，判据与补齐面还各不相同）：`base` 缺回合边界时，从完整日志（`readSession`）并回 **`turn/start` + `turn/end` 两类**（前者给回合号、后者给收尾原因，缺任一都拿不到终态）。
1. 判据「边界不完整」= ① 一条 `turn/end` 都没有；② 有 `user/message` 没带回合号（等 `turn/start` 回填）或它引用的回合没有收尾；③ 用户块由 `agent/inbox/spliced` 承载（内存会话形态，取不到号）。
1. 合入时按 `seq` 去重（`base` 优先）后**整体按 `seq` 归位**——追加到末尾会让边界排在正文之后，处理用户消息时回合号还没推进，回填会把多条用户块判到同一个回合（真机实测：51 个用户块全变 turn 1）；`base` 一条数字 `seq` 都没有时退回追加（不假排序）。
1. 正文仍用 `base`（live 保最新 / surface 保持既有口径），只动边界事件。**读失败不再静默**：原样返回 `base` + 一条 `warn` notice（否则画面只剩「全 `?`」，无法归因）。
1. `listSessions` 的标题 / 空会话探针改走 `readSessionSurface(id, { boundaries: false })`：那里只要正文，不必为每个活跃 live 会话多读一次完整日志（真机日志 13800 事件）。

**未做（记录为遗留）**：恢复路径「符号落给该回合**最后一个**用户消息」与实时路径「落给本世代该节**第一个**未定态用户块」的不对称未动（已记 BACKLOG 同条目）；两源 `seq` 编号体系不一致时同回合可能出现两条边界（多幂等，未处理）。

## 测试与证据

- 新增用例见 `TUI/tests/adapter.dsh.test.ts`（5 条，名字均含「回合边界并回」）：整段缺 `turn/start` + `turn/end`、只缺旧回合（部分覆盖）、持久源不可读给 warn notice、spliced 承载用户块、live 无数字 `seq`。

- **反向验证**：`git stash push -- src/app/adapter/dsh.ts` 后跑最初两条 → **pass 107 / fail 2**（两条全红）；恢复改动 → 全绿。审阅另用探针实测：把「并两类但追加不排序」塞回去 →〈部分覆盖〉那条变红（排序被守住）。

- 随口径更新一条既有断言与用例名：live 分支补读的是**完整日志**（`readSession`）而非折叠面（`readSurface`），`tests/adapter.dsh.test.ts:2119` 的 `readCalls` 断言由 `surface:live-1` 改为 `session:live-1`；〈surface 缺回合边界〉一条改了名字（现在并回两类边界，不再只并 `turn/end`）。

- **验收数字**：TUI 全量 `npm test` **1466 / 1466**（其中 `adapter.dsh.test.ts` 单文件 200 / 200）；`npm run check` 退出码 0（0 条 TS 错）；`npm run build` 退出码 0（0 条 TS 错）。

- **全仓**：`npm test` 退出码 0（21 包全 OK，TUI 1466 / 0 失败）——含 notice 与审阅收敛后的最终一轮。

- **真机日志端到端复现与对照**（探针 `TUI/tmp/probe-real-restore.mjs`，未入库）：把当前会话的真实日志（`tmp/new.log`，13800 事件）喂给**真实适配器** `createRealDshAdapter`（`dist` 构建产物），并伪造两种「内存 store 缺边界」形态：

  | live store 形态 | 改前（旧口径） | 改后 |
  | --- | --- | --- |
  | `partial`：只保留最后 5 个回合的边界（真机形态） | **320 / 325 用户块无终态**（1 ■ + 4 ✓）→ 画面几乎全 `?` | **250 带终态**（239 ✓ / 2 ✗ / 9 ■），与完整日志基线一致 |
  | `none`：边界一个都不保留 | 250 带终态（旧判据恰好命中） | 250 带终态 |

  → `partial` 一行**精确复现了用户看到的「重启前的都是 `?`、重启后正常」**：内存 store 里新回合有边界、旧回合没有，旧判据「一条 `turn/end` 都没有」不成立 → 不补 → 旧回合用户块全 `?`。改后与完整日志基线逐项一致。

- **待补**：真机重启复核（本修法要解决的正是该现象）——通过后才提交（仓库规则：build → 人工确认 → 提交）。

## 审阅记录

**自审（2026-10-12，逐行读 diff）**：

1. 空 live（resume 入列竞态）不受影响：没有用户消息 → `incomplete = false` → 不补读 → `messages` 为空 → 仍走下面的 persisted 回退（既有用例〈live store 空事件〉保持绿）。
1. 去重与排序：`seen` 只取 live 的 seq → 持久源同 seq 的边界被排除（live 优先）；排序用 `seqOf`（缺号落 `MAX_SAFE_INTEGER`），`Array.prototype.sort` 稳定 → 同号保持 live 在前。
1. 触发面变宽是有意的：live store 里 `user/message` **本来就不带 `turn`**（宿主先落消息、再发 `turn/start`，见条目 27），故「有未带号的消息」几乎恒成立 → 每次 `readSessionSurface` 多读一次完整日志。合并只增边界事件、同 `seq` 一律 `base` 优先，不缺不误——用一次读换鲁棒。
1. 有意的简化：不再先试 `readSurface`（宿主明确不对 live 会话做 surface fold，且折叠面**不含回合边界**）——直接读完整日志；宿主没有 `readSession` 时整段跳过（与旧行为一致）。

### 外部审阅（子代理，只读；2026-10-12）

范围：`git diff TUI/src/app/adapter/dsh.ts` + 两条新用例 + 自跑 `adapter.dsh.test.ts`。结论：修法方向正确（真机形态有效），主要问题是 diff 冗余、触发面代价、测试守不住边界情形。逐条处置：

| 审阅意见 | 处置 |
| --- | --- |
| [中] `listSessions` 探针（`dsh.ts` 的 `readMessages` → `doReadSessionSurface`）为活跃 live 会话多读一次完整日志；自审「`listSessions` 不经过本函数」不成立 | ✓ 已改：探针传 `{ boundaries: false }` |
| [低-中] `base` 无数字 `seq` 时 `seqOf` 回退方向错 → 修法静默退化为「不排序」 | ✓ 已改：无数字 `seq` 时退回追加（不假排序），并补用例 |
| [低] 判据忽略 `agent/inbox/spliced` 承载的用户块 | ✓ 已改：判据加第 ③ 条 + 补用例 |
| [低] surface 分支仍旧窄判据、失败仍静默 | ✓ 已改：两分支合并到 `withTurnBoundaries`，失败统一给 notice |
| [低] 非数字 `seq` 的持久源边界永不去重 | △ 已知：走到「追加」路径时重复边界多幂等，未额外处理（与上一条同因） |
| [低] 用例〈整段缺边界〉不守排序；去重 / 无 `seq` / spliced 三类零覆盖 | ✓ 已补 2 条（spliced、无 `seq`）；排序由〈部分覆盖〉那条守住（审阅实测：并两类但不排序 → 该条变红） |

## 收尾

- **实现**：`b534298`（`withTurnBoundaries` 抽出 + live/surface 两分支共用；判据加 `agent/inbox/spliced`；无数字 `seq` 退回追加；读失败给 warn notice；`listSessions` 探针传 `{ boundaries: false }`）。
- **验收对照**：
  1. 「恢复出来的历史用户块按 `turn/end` 的 reason 显示 `✓` / `✗` / `■`」✓ —— 真机日志（13800 事件）端到端探针：`partial` 形态由「320 / 325 无终态」变为「250 带终态」（239 ✓ / 2 ✗ / 9 ■），与完整日志基线逐项一致；用户 2026-10-12 真机重启后复核「其他都正常」（恢复的历史块符号正常）。
  1. 「全量测试绿 + check 干净 + build 通过」✓ —— TUI **1466 / 1466**（`adapter.dsh.test.ts` 单文件 200 / 200）、全仓 `npm test` 退出码 0（21 包全 OK）、`npm run check` / `npm run build` 各 0 条 TS 错。
- **遗留（另记）**：① 恢复路径按「该回合**最后一个**用户消息」落符号、实时路径按「本世代该节**第一个**未定态用户块」——两者不对称，注入块排人工输入之后时会拿走符号（用户真机另见一例：`sleep 30` 那条指令的回合以 `aborted / reason: user` 收尾，恢复路径能拿到 `■`，实时路径的符号被同世代后续注入块拿走 → 显示 `?`）；② 两源 `seq` 编号不一致时同回合可能出现两条边界（多幂等）。
- **归档**：本文件移入 `TUI/docs/archived/`；`TUI/docs/BACKLOG.md` 移除该条。
