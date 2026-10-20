# 取消跨实例传播与到点噪声收敛（接取条目：background-daemon/docs/BACKLOG.md「取消任务后其它已加载实例仍到点触发（取消不跨实例传播）」）

状态：关闭　　开启：2026-10-20　　关闭：2026-10-21
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. `cancel` / `pause` / `resume` 在**所有共享同一状态目录的实例**生效，而不是只改本实例内存副本。
2. 目标会话被删除后，定期任务到点不再每周期刷两条 stderr 告警（TUI 活动区显示为红色 error 行）。
3. 行为边界写进 README，并在单测里锁定。

## 调研

来源：本包源码、memory-base 源码、真机日志（2026-10-20 23:13 现场）。

- **现场**：`~/.dsh/background-daemon/journal.jsonl` 每 10 分钟一条 `d-d932d07d` 的 `skipped`（`no-active-agent`）；`tui-local.jsonl` 同步出现两条 `[background-daemon] warn:`（流水入库失败 / 任务写入 memory-base 失败），原因是 `sessionPaths.sessionDirFor("tui-ac5bf17a-…")` 抛「不在宿主的 sessions 里」——该会话已于 23:07 删除。
- **告警来源**：`records.ts` 的 `createRunSink`（`scope.put` 拒绝 → `流水入库失败`）与 `MemoryTaskMirror.#fail`（`任务写入 memory-base 失败`）。`Journal.append` 与 `TaskStore.update` 每次都触发这两条写透，故每周期各刷一条。tone 判定见 `TUI/src/app/stderr-bridge.ts:44-47`（文案含 `Error:` → error 红）。
- **记忆底座落点**：S 层库按会话解析——`memory-base/src/tiers.ts:111-125` 的 `pathFor("session", sessionId)` 走 `sessionPaths.sessionDirFor`，库文件是 `<会话目录>/session.db`。会话目录被删 = 该会话的 S 层行随之消失，后续任何写都抛「解析会话目录失败」。
- **任务表的两条后端**：memory 可用时任务行是 memory-base 的追加式修订行（`records.ts:345-446`），JSON 快照停写；memory 不可用时是 `tasks.json` 整文件写回（`store.ts`）。`README.md`「边界」节已写明 JSON 降级面向单实例。
- **取消现状**：`/daemon cancel` 与工具 `cancel` 只做 `store.remove`（`commands.ts:216-224`、`tools.ts:164-170`），本进程立即停；其它实例的内存副本不受影响，`arm()` 只重算本进程 timer。
- **暂停 / 恢复现状**：同上，`store.update` 只改本进程副本。

## 决策

**D1 跨实例传播机制**（选项：a 复用 `session-channel` 共享 KV；b 状态目录下的共享控制帐 `control.jsonl`；c 只写文档并降噪）

选定 **b**。理由：控制帐与 `tasks.json` / `journal.jsonl` 同作用域（同一 DSH_HOME 的实例天然共享），不引入新依赖；`session-channel` 是可选服务，缺失时传播会静默失效，不可接受。代价是控制帐只覆盖「共享状态目录」这一层（与任务表一致）。

**D2 生效时机**（选项：a 订阅式事件推送；b 每次 `runDue` 前核对控制帐）

选定 **b**。理由：无额外通道与生命周期管理；核对天然幂等；进程重启后仍按控制帐收敛（控制帐同时充当墓碑）。核对每轮读一个几十字节的小文件，成本可忽略。

**D3 外部控制事件的落点写入**（选项：a 照常写 memory 镜像；b `mirror: false` 只改本地副本）

选定 **b**。理由：权威写入方（执行操作的那个实例）已写过自己的修订行；其它实例再写一份既制造噪声，又会在目标会话已删时失败告警。

**D4 `skipped`（`no-active-agent`）结局的记忆导出**（选项：a 照常导出流水与任务行；b 只写本地 JSONL / 内存，跳过 memory 导出）

选定 **b**。理由：`skipped` 不改变任务语义（状态、`next` 偏移由调度器本地推进），而目标会话很可能已删——导出必然失败并每周期刷 warn。`/daemon log` 与本地 JSONL 仍保留该行，可排障。

**D5 控制帐轮转**（选项：a 定时压缩；b 不轮转）

选定 **b**。理由：只有人工 `cancel` / `pause` / `resume` 写入，量级可忽略；多进程压缩存在竞态（读到旧内容再 rename 会丢并发追加）。

**D6 未被取消、目标会话已删的孤儿任务**（选项：a 本期一并自动清理；b 保持 active 但静默跳过，靠 `cancel` 收敛）

选定 **b**。理由：跨进程无法可靠判定「会话是真被删了，还是在别的进程里活着」——自动清理会误杀仍在其它进程使用的任务。改为：到点静默跳过（不再告警），用户用 `/daemon cancel` 一次，控制帐让所有实例同步清掉。

## 规划

任务拆分：

1. 新增 `src/control.ts`：控制帐（append-only JSONL）+ `apply(store, now)` 幂等收敛。
2. `src/store.ts`：`update` / `remove` 增加 `{ mirror: false }` 选项（跳过写透镜像）。
3. `src/journal.ts`：`append(record, { sink: false })`（跳过流水外送）。
4. `src/scheduler.ts`：`control` 选项 + `runDue` 前核对；`skipped` 结局不导出 memory。
5. `src/commands.ts` / `src/tools.ts`：`cancel` / `pause` / `resume` 成功后写控制帐。
6. `src/main.ts`：解析控制帐路径、装配并暴露到运行期句柄。
7. `src/index.ts`：导出控制帐类型。
8. 测试：新增 `tests/control.test.ts`；补 `scheduler` / `store` / `journal` / `commands` / `tools` / `apply` 用例；`tests/harness.ts` 支持注入控制帐。
9. 文档：`background-daemon/README.md` 边界节（关闭时回写）。

计划改动文件清单：

- `background-daemon/src/control.ts`（新建）
- `background-daemon/src/store.ts`
- `background-daemon/src/journal.ts`
- `background-daemon/src/scheduler.ts`
- `background-daemon/src/commands.ts`
- `background-daemon/src/tools.ts`
- `background-daemon/src/main.ts`
- `background-daemon/src/index.ts`
- `background-daemon/tests/control.test.ts`（新建）
- `background-daemon/tests/harness.ts`
- `background-daemon/tests/scheduler.test.ts`
- `background-daemon/tests/store.test.ts`
- `background-daemon/tests/journal.test.ts`
- `background-daemon/tests/commands.test.ts`
- `background-daemon/tests/tools.test.ts`
- `background-daemon/tests/apply.test.ts`
- `background-daemon/docs/BACKLOG.md`（条目状态）
- 本文件
- `background-daemon/README.md`（关闭时回写）

明确不做：

- 不改任务表的存储形态（不新增 memory-base kind，不重启 JSON 快照）。
- 不做控制帐轮转（D5）。
- 不做孤儿任务自动清理（D6）。
- 不改 TUI 的 tone 判定（`stderr-bridge.ts` 不动）；本任务只减少告警来源。
- 不动 `background-daemon/docs/BACKLOG.md` 第 1 条（默认不开启，另一个条目）。

## 实现记录

- 2026-10-20：新增 `src/control.ts`（`ControlLog`：`append` / `load` / `latest` / `apply`）。`apply` 对每个任务取最后一条事件：`cancel` 删除本地副本、`pause` 置 `paused`、`resume` 置 `active` 并按当前时钟重算周期任务的下次触发；全部走 `mirror: false`（决策 D3）。
- `src/store.ts`：新增 `TaskWriteOptions`（`mirror?: boolean`），`update` / `remove` 支持跳过写透镜像。
- `src/journal.ts`：新增 `JournalAppendOptions`（`sink?: boolean`），`append` 支持跳过 memory-base 外送。
- `src/scheduler.ts`：新增 `ControlApplier` 结构面与 `SchedulerOptions.control`；`runDue` 在算到期集合前调用 `#applyControl`（失败只告警、不拖垮调度）；`#applyOutcome` 对 `skipped` 结局传 `{ sink: false }` / `{ mirror: false }`（决策 D4）。
- `src/commands.ts` / `src/tools.ts`：`pause` / `resume` / `cancel` 成功后写控制帐（`control?.append`；未传 control 时行为不变）。
- `src/main.ts`：新增 `DaemonConfig.controlPath` 与 `resolveControlPath`（缺省与任务表同目录的 `control.jsonl`）；装配期创建 `ControlLog` 并接到调度器、命令面、工具面；运行期句柄暴露 `control` / `controlPath`。
- `src/index.ts`：导出 `ControlLog` 及其类型、`JournalAppendOptions`、`TaskWriteOptions`、`ControlApplier`、`resolveControlPath`。
- `README.md`：路径解析补控制帐；「边界」补两条（跨实例控制帐、`skipped` 不写透）；测试覆盖清单同步。

## 偏差

- 计划里「`skipped` 结局只跳过**流水**外送」在实现时扩到**任务镜像**也跳过：`#applyOutcome` 的 `store.update` 同样会因为目标会话已删而写透失败（现场两条告警中的一条正是它），只跳流水无法收敛噪声。证据：`scheduler.test.ts` 的「skipped：不写透 memory」用例同时断言 `sinks` 与 `saves` 为空。
- 计划的「控制帐轮转」按决策 D5 不做，未产生代码。
- 未做孤儿任务自动清理（决策 D6），属于明确的「不做」而非遗漏；现场任务的收敛路径是 `/daemon cancel`（现在会广播到所有实例）。
- 现场清理：经用户同意, 已用旧构建运行期的 `daemon_task cancel` 删除 `d-d932d07d`（目标会话 23:07 已删）。旧构建不写控制帐, 故其它 fff 实例仍会按旧副本到点触发, 重启后消失。
- 现场残留：`~/.dsh/background-daemon/tasks.json`（23:05 的迁移源快照）仍含 `d-d932d07d`。当前进程是 memory 底座、快照停写, 故取消不影响该文件；下次启动若 memory 里没有任务行, 会按首次迁移把快照导入——新代码下到点静默跳过并在控制帐有取消事件时自动清掉, 否则重启后再取消一次即可写入控制帐永久收敛。该文件在工作区外, 未改。

## 测试与证据

- `npm --prefix background-daemon run check`：通过（tsc --noEmit，0 错误）。
- `npm --prefix background-daemon run build`：通过（`dist/src/control.js` 已生成）。
- 全仓 `npm run check`：通过（30 包）。
- 全仓 `npm run test`：30 包全绿（`background-daemon` 152 例）。
- `npm --prefix background-daemon test`：152 例全绿（新增 9 例：控制帐 5、调度器集成 4；另补 store / journal / commands / tools / apply 各 1 至 2 例）。
- 新增用例清单：
  - `tests/control.test.ts`：append/load/latest、坏行静默跳过、取消（不写透 + 幂等）、暂停与恢复（恢复重算 next）、未知任务不抛。
  - `tests/scheduler.test.ts`：「控制帐：其它实例的取消在到点前收敛」「暂停同样生效」「skipped 不写透 memory」「delivered 照常写透（对照）」。
  - `tests/store.test.ts`：「update/remove：mirror:false 只改内存与快照」。
  - `tests/journal.test.ts`：「append：sink:false 只写本地账本」。
  - `tests/commands.test.ts` / `tests/tools.test.ts`：三个动作各写一条事件；失败的操作不写。
  - `tests/apply.test.ts`：`controlPath` 缺省与覆盖、装配后工具取消写入共享控制帐。
- 真机复验（2026-10-21 00:40 起, 重启后的 `dsh --profile fff`, 新构建）：
  - 取消 `d-d932d07d` 后生成 `~/.dsh/background-daemon/control.jsonl`（61 B，`{"taskId":"d-d932d07d","action":"cancel","at":…}`），证明控制帐写入面在新构建下生效；任务在 store 中消失，重启时从 `tasks.json` 迁移导入的那份也被清掉。
  - 定向验证 D4：新建一次性任务 `d-37fb966d`（`after_seconds 60`, 目标为不存在的会话 `tui-0000…`），到点（`at=1792514697835`）在本地 `journal.jsonl` 记 `skipped / no-active-agent`，`tui-local.jsonl` 该时刻**没有**新增 warn 行（对照 23:13 每次到点两条 error-tone 告警）；验证后已取消该任务。
  - 已知残留（创建路径）：创建指向「memory-base 无法解析的会话」的 S 档任务时，`mirror.save` 仍会弹一条 `任务写入 memory-base 失败`（`ts=1792514637835` 实测）。这是创建期输入/落点问题，不属于本条目「到点噪声」范围，记入收尾遗留。
  - 未做：两个 dsh 进程的取消互见实机联调（单进程只验证了写入面与本地收敛；跨实例收敛由 `control.test.ts` 与 `scheduler.test.ts` 的控制帐用例覆盖）。

## 收尾

- 回写：`background-daemon/README.md`（路径解析补控制帐；「边界」补「取消 / 暂停 / 恢复跨实例生效」与「`skipped` 不写透 memory-base」两条；测试覆盖清单同步）。`DESIGN.md` 不存在（轻量包豁免，见 `AGENTS.md`「结构与约定」），无需回写。
- 条目：`background-daemon/docs/BACKLOG.md` 的「取消任务后其它已加载实例仍到点触发（取消不跨实例传播）」标完成并从清单移除；本文件移入 `docs/archived/`。
- 遗留：
  1. 创建期写透告警（见「测试与证据」最后一条）——按「途中发现新问题」规则新登记为 BACKLOG 条目，交后续接取。
  2. `~/.dsh/background-daemon/tasks.json` 仍保留 `d-d932d07d` 的历史快照（工作区外文件，本次未改）；新构建下即便再被导入，也会在控制帐有取消事件时于首轮收敛清掉。
  3. 两个 dsh 进程的实机联调未做（单元与集成用例覆盖）。
- 临时数据：验证用的一次性任务 `d-37fb966d` 已取消；未留下工作区临时文件。
