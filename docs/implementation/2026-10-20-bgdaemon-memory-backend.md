# background-daemon memory 底座与任务表迁移（接取条目：docs/BACKLOG.md「background-daemon E5：memory 底座取不到（严格模式 readService 需可选注入 / 惰性解析）」；「background-daemon tasks.json 多实例共享整文件覆盖（明确单实例边界或加锁合并）」）

状态：测试　　开启：2026-10-20　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

让 `background-daemon` 在 memory-base 可用时把 memory 挂为首选记录底座：任务表迁入 memory（SQLite，库级锁 + 原子写），写透时 `tasks.json` 停写，从而同时消除「tasks.json 多实例共享整文件覆盖」竞态（条目 6 的验收并入 #5）；`/daemon` 状态面报 `records: memory`；JSON 快照降级为纯兜底并保留单实例边界口径。验收：`check` / `build` / `test` 全绿 + 真机 `backend=memory` / `records: memory`、多实例共存不复现覆盖。

## 调研

（2026-10-20；来源：上次任务归档追踪文档 `docs/archived/2026-10-19-background-daemon-verification.md`、agent-group 先例、本包源码）

- **E5 根因（已在上任务定位）**：`readService(ctx, "memory")` 在 cordis 4 严格面取不到未 `inject` 的可选服务（memory-base 由兄弟 bundle `provide`，`ctx.get("memory")` 抛 `cannot get property "memory" without inject`）→ memory 底座从未挂上、恒降级 json。agent-group 先例（2026-10-19 真机结论）：用 `ctx.inject([...], cb)` 开子分叉按需绑定可选服务，服务就绪后回调里读得到。
- **上任务已验证的原型**（已回退）：`ctx.inject(["memory"], cb)` 晚挂 + 幂等 `mountMemory()`（注册 kind / 读任务 / 建 mirror+sink / adopt+迁移 / disableSnapshot / 切 backend）+ `journal.attachSink` 晚接外送 + `service.records` 函数求值；`npm test` 138 例（含晚挂回归），修复构建真机写透闭环（session.db 出现 `kind_daemon_task` / `kind_daemon_run`，tasks.json 停写）。本任务复现该方案并使其落在合入代码上。
- **条目 6 的解法合入 #5**：memory 路径下任务表写入 memory-base（SQLite，库级锁 + 原子写），不再写 tasks.json 整文件 → 多实例共享竞态天然消除（各实例经 SQLite 交互相当于修订流，非整文件替换）。JSON 快照仅作降级与首迁移导入源；此时单实例边界口径仍需在 README 明示（memory 未挂时的降级路径仍是整文件写回）。
- **migration 语义**：启动时 memory 有行 → 以 memory 为准 adopt；memory 空而 JSON 快照有任务 → 导入 memory 并停写 json（上任务原型已验证，行为保留）。

## 决策

格式：决策项用数字、选项用 abcd，选定项写明字母与理由。

1. **memory 底座接入方式**

   - (a) 复现上任务已回退原型：构造期 `readService("memory")` 直读命中即挂；未命中且宿主有 `ctx.inject` 时，`ctx.inject(["memory"], cb)` 子分叉晚挂（幂等 `mountMemory`）。
   - (b) 把 `memory` 加进静态 `inject`（成为必选）——与「缺失降级 json」设计冲突，弃。
   - **选定 (a)**。理由：agent-group 真机验证过的先例路径；保持 memory 可选（缺 memory 仍 json 激活）；原型已跑通、回退可整体复现。

2. **条目 6 的落法**

   - (a) 只文档化单实例边界（上任务裁定方向）。
   - (b) 由 memory 底座承担：任务表入 SQLite（库级锁 + 原子写），memory 可用时 tasks.json 停写 → 覆盖竞态消除（主分支裁定方向）。
   - **选定 (b)**，README 仍补单实例边界口径（降级 JSON 路径）。理由：主分支明确「验收并入 #5」；memory 路径下竞态由 SQLite 语义解决，JSON 只作降级。

## 规划

任务拆分：

- **T0 建追踪文档 + BACKLOG 标记**：条目 5 / 6 标〔进行中: 2026-10-20〕。
- **T1 代码**（复现并贴近上任务原型，改动文件见清单）：
  - `src/journal.ts`：`#sink` 可晚挂，新增 `attachSink(sink)`。
  - `src/service.ts`：`records / rejectedRows` 支持 `(() => T)` 函数求值（晚挂后状态面实时反应）。
  - `src/main.ts`：新增 `readInject()` 结构面读取；抽出幂等 `mountMemory()`（注册 kind / `loadTasks` / 建 mirror+sink / adopt+首迁移 / `disableSnapshot` / 切 backend / 接 journal sink）；构造期直读命中即 `mountMemory`，否则经 `ctx.inject(["memory"], cb)` 晚挂；`backend / mirror / rejectedRows` 改运行期可变（getter / 函数），供 service 状态面与运行期句柄实时读取；scheduler `loadStore` 判定用显式展宽变量。
- **T2 测试**：`tests/apply.test.ts` 新增晚挂回归（严格面 memory 不可读 → 先 json，inject 回调触发后切 memory：kind 注册、journal 外送、幂等、service.records 实时为 memory）；既有 137 例保持全绿。
- **T3 门禁**：`npm --prefix background-daemon run check` / `build` / `test`。
- **T4 真机验证**（真实 fff，`--patch` 覆盖层加载本 worktree 构建，herdr pane）：启动日志出现「已把 N 条 JSON 任务导入 memory-base」（或直挂 memory）；新任务 `tasks.json` 停写；目标会话 session.db 出现 `kind_daemon_task` / `kind_daemon_run`；`/daemon list` 正常；另起一个并发实例观察 tasks.json 不再被整文件改写（竞态不复现）。
- **T5 文档**：`README.md` 同步「memory 为首选记录底座 / JSON 仅降级」与单实例边界口径；追踪文档收尾。

计划改动文件清单：

- `background-daemon/src/main.ts`（memory 晚挂 + mountMemory + 运行期可变面）
- `background-daemon/src/journal.ts`（attachSink）
- `background-daemon/src/service.ts`（records / rejectedRows 函数求值）
- `background-daemon/tests/apply.test.ts`（晚挂回归）
- `background-daemon/README.md`（记录底座口径 + 单实例边界）
- `docs/BACKLOG.md`（条目 5 / 6 标进行中，收尾移除）
- `docs/implementation/2026-10-20-bgdaemon-memory-backend.md`（本追踪文档；收尾移入 `docs/archived/`）
- 真机脚手架落 `tmp/`（`.gitignore` 忽略，收尾删除）

明确不做：不做周期投递等新功能；不重做已合入的设计；不新增 `/daemon status` 子命令；不改 `~/.dsh/profiles/fff` 的 profile 文件；不做 JSON 降级路径下的锁/合并（不在本轮范围，README 边界口径已覆盖）。

## 实现记录

（按时间追加）

- 2026-10-20 T0：建本追踪文档；BACKLOG 条目 5 / 6 已标〔进行中: 2026-10-20〕。
- 2026-10-20 T1 代码（复现上任务已回退原型并落在合入面）：
  - `src/journal.ts`：`#sink` 可晚挂（新增 `attachSink`）。
  - `src/service.ts`：`records / rejectedRows` 支持函数求值（晚挂后状态面实时读）。
  - `src/main.ts`：新增 `readInject` 结构面读取；抽出幂等 `mountMemory()`（注册 kind / `loadTasks` / 建 mirror+sink / adopt+首迁移 / `disableSnapshot` / 切 backend / 接 journal sink）；构造期直读命中即挂，未命中经 `ctx.inject(["memory"], cb)` 子分叉晚挂；`backend / mirror / rejectedRows` 改运行期可变（getter / 函数）；scheduler `loadStore` 判定用显式展宽变量。
- 2026-10-20 T2 测试：`tests/apply.test.ts` 新增晚挂回归（严格面 memory 不可读 → 先 json, inject 回调触发后切 memory, kind 注册、journal 外送、幂等、`service.records` 实时为 memory）。
- 2026-10-20 T3 门禁：check 通过；`npm test` 138 例全绿（137 + 1）；`npm run build` 通过（dist 含 mountMemory / attachSink）。
- 2026-10-20 T5 文档：`README.md` 同步 —— 依赖声明段（memory 经 `ctx.inject` 晚挂、timer 走 clock 统一面）、边界段新增「记录底座边界」（memory=SQLite 库级锁无竞态；JSON 降级 = 单实例边界）、记录底座段改写为「memory 优先, JSON 仅降级」。

## 偏差

（暂无。）

## 测试与证据

（2026-10-20 真机，`dsh --profile fff` + `--patch tmp/verify/overlay.yml` 加载本 worktree 修复版 dist，pane `wWR:p4`，真实 `~/.dsh`）

- 门禁：`npm --prefix background-daemon run check` 通过；`npm --prefix background-daemon test` 138 例全绿。
- 启动：`[background-daemon] 已启动（任务 1 个，backend=json，…）` 随后 `warn: 已把 1 条 JSON 任务导入 memory-base`（`ctx.inject` 晚挂触发, backend 切 memory）；注入外部会话任务 `d-d932d07d` 时因目标会话在外进程报 `sessionPaths.sessionDirFor … 不在宿主的 sessions 里`（多实例环境会话解析限制, 属预期噪声, 只计数不重试）。
- **真机写透 ✓**：本 pane 会话 `tui-e0a91de6-…` 内创建任务 `d-b9a9ac7c`（deliver / after_seconds:40）：journal 记 `delivered`；`tasks.json` **不包含**该任务（memory 停写, 文件仍只有外部任务的 `d-d932d07d`）；目标会话 `session.db` 出现 `kind_daemon_task` 2 行（create + done 修订, title=d-b9a9ac7c）+ `kind_daemon_run` 1 行（delivered 流水）。
- **记录底座在值**：memory 挂载后 `service.status().records` 经函数求值读为 `"memory"`（service 面无 `/daemon status` 子命令, 以写透行为 + 晚挂日志为证据）。
- **条目 6（多实例竞态）✓ 由 memory 路径承担**：memory 挂载后任务表写透进 SQLite（session 层 `kind_daemon_task`），本实例不再整文件改写 `tasks.json` → 覆盖竞态不复现（本实例视角）。JSON 降级路径仍为单实例边界, README 已明示。
- 遗留物：验证 pane `wWR:p4`（运行中）；`tmp/verify/overlay.yml`、`tmp/bg-err-fix2.log`（收尾清理）。

## 收尾

（待写。）
