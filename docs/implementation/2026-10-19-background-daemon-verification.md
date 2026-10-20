# background-daemon 真机验证（接取条目：docs/BACKLOG.md「background-daemon 真机验证（已挂载，发现 timer 适配缺陷）」）

状态：测试　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

在 `~/.dsh/profiles/fff` 已挂载 `@dsh-toolset/background-daemon` 的前提下，修掉 timer 适配缺陷（`src/scheduler.ts:32` 的 `TimerLike` 按 `schedule(delay, cb)` 读宿主，宿主 `cordis-plugin-timer` 只有 `timeout(cb, delay)`，与设计 D16「用 `ctx.timer` 的 `timeout()`」不符），跑通四条端到端（文本投递 / 命令执行 / 重启恢复 / 无活跃 agent 的 `skipped`）与 `backend=memory` 路径；验收按条目：四条端到端各一次通过，memory-base 可用时 `/daemon` 状态面报 `records: memory`。

## 调研

（2026-10-19；来源：宿主源码 / 本包源码 / git 历史 / 单测 / 真机环境实测）

### 1. 缺陷与根因

- 宿主 `cordis-plugin-timer`（`0.2.0-rc.2` 随装，`fff` 已挂载，`docs/host/HOST-PACKAGES.md:323` / `:457`）的 `TimerService` 只给 `timeout(callback, delay): () => void` 与 `interval(...)`，另有 deprecated 的 `setTimeout` / `setInterval`，**没有 `schedule`**。依据：`~/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis-plugin-timer/lib/types/index.d.ts` 与 `src/index.ts`。
- 本包 `TimerLike` 假设 `schedule(delayMs, callback)`（`background-daemon/src/scheduler.ts:31-34`），调度器在 `arm()` 里调用它（`src/scheduler.ts:199`）；装配层把宿主服务直接当 `TimerLike` 传入（`src/main.ts:216-218`）。宿主服务在场时拿到的是 `timeout` 形状对象，`arm()` 抛 `TypeError: this[#options].timer.schedule is not a function`，与 BACKLOG 记录一致。
- 复现（临时脚本 `tmp/repro.ts`，收尾删除）：假 ctx 的 `timer` 只给 `timeout(cb, delay)`，经 `createDaemonRuntime` 建任务后调 `scheduler.arm()`，输出原文 `arm threw: TypeError: this[#options].timer.schedule is not a function`。
- 引入链：`80ca7ea`（2026-10-18）把 `timer` 从 `inject` 移除、加 `systemTimer()` 兜底，但保留了 `readService<TimerLike>(ctx, "timer")`；提交说明称「宿主 timer 是懒加载服务，激活期取不到」，而真机上 `apply` 期取得到，只是形状不同。
- 单测没拦住：假 ctx 直接塞 `FakeTimer`（实现 `schedule`，`tests/harness.ts:31`；`tests/activation.test.ts:52`、`tests/apply.test.ts:164`），从未走过宿主形状；136 例全绿只证明内部契约自洽，不证明真机可用。

### 2. 已存在的三处口径冲突（决策里收口）

- 设计 D16（`docs/archived/2026-10-15-background-daemon-design.md:254`）：复用宿主 `ctx.timer` 的 `timeout()`，自建只留分段 / 重算 / 补算。
- 同日收尾记录（同文件 `:647`）：定时器最终改为进程内实现、不再依赖宿主 `timer`（`80ca7ea`）。
- `background-daemon/README.md`「依赖声明」段：宿主 `timer` 存在则经 `readService` 作可注入覆盖，否则进程内 `setTimeout`。
- 实现实际是第三种：读宿主服务、按 `schedule` 形状用。本任务须裁定一种并让文档一致。

### 3. 宿主 timer 语义补充（影响设计口径）

- `timeout` 内部是 `this.ctx.effect(...)`，挂在 **TimerService 自己的 ctx**（timer 插件 fiber），不是消费方插件 fiber；因此「插件卸载自动释放」对本包不成立。本包靠 `Scheduler.stop()` / `arm()` 手动 `dispose`，不受影响，但 D16 的这条理由需更正。
- `timeout` 触发前先 `dispose()` 再回调；本包回调里把 `#disposeTimer` 置空，不会二次 dispose，也没有竞态。
- 宿主用裸 `setTimeout`（不 `unref`），与 `systemTimer()`（`unref`）不同；本包 `stop()` 会清 timer，长延迟不会拖住进程退出。

### 4. 真机验证环境（关键约束）

- `fff` 的软链指向**主 worktree**：`~/.dsh/profiles/fff/node_modules/@dsh-toolset/background-daemon -> /home/guochang/Projects/dsh-toolset/background-daemon`（`main` 分支，无本修复）；本任务在 `.worktree/background-daemon`。真机必须显式指向本 worktree 的构建产物。
- 当前沙箱为 workspace-write：`dsh --profile fff --dump-config` 直接报 `EROFS: read-only file system, open '~/.dsh/profiles/fff/cordis.yml'`（`prepareProfile` 每次启动 / dump 都重写该文件）。故真实 profile 的 dsh 进程不能由受沙箱的 bash 直接起。
- `--patch` 覆盖层已实测可用（用 `tmp/home` 克隆 fff 组合后 dump 验证）：`- id: background-daemon` + `disabled: true` 生效（dump 输出 `disabled: true`）；`- insert:` 行写绝对路径会被解析成 `file:///…/background-daemon/dist/src/index.js`，可把本 worktree 构建产物装进真实组合，且无需改 profile 文件。
- `DSH_HOME` 覆盖可行：`--profile <name>` 解析 `$DSH_HOME/profiles/<name>`；克隆 fff 的 `package.json` / `cordis.patch.yml` / `cordis.yml`，再按包名建 `node_modules` 软链即可组同一棵组合树。注意 bundle 解析按包名找 `node_modules`（`@dsh-toolset/tui` 的目录名是 `TUI`，软链名须写包名，否则 bundle 被跳过）。缺口：模型凭据在 `~/.dsh/.credentials.yaml`（provider `tollgate` 的 `apiKeyEnv: TOLLGATE_API_KEY`，当前 shell 未设该变量），跨 home 需软链凭据文件。
- 验收观测面：`/daemon` 只有 list / show / pause / resume / run / cancel / log，**没有 status**；`records: memory` 只能从启动日志 `[background-daemon] 已启动（… backend=memory …）`（`src/main.ts:359-363`）或 `ctx.backgroundDaemon.status()`（`src/service.ts:52-60`）看到；TUI 目前未消费该服务（`grep backgroundDaemon TUI/src` 无命中）。
- `daemon_task` 的 `sessionId` 说明写「缺省取当前会话」，实现只读 `config.defaultSessionId`（`fff` 未配置，缺失时返回 `missing_session`，`src/tools.ts:236-240`），真机创建任务需显式给本会话 id。与本次缺陷无关，记为观察项。

### 5. 基线

- `npm run check` 通过；`npm test` 136 例全通过；`npm run build` 产出 `background-daemon/dist/src/index.js`（64 个导出）。
- worktree 初始无依赖目录，已 `npm install`（3 个 devDependencies，落 `background-daemon/node_modules`，被根 `.gitignore` 忽略）。

## 决策

格式：决策项用数字、选项用 abcd，选定项写明字母与理由。

1. **timer 适配形状**

   - (a) 保留内部 `TimerLike.schedule(delayMs, cb)`，新增宿主适配器 `hostTimer(service)`，把 `timeout(cb, delayMs)` 包成 `schedule`；`main.ts` 先判 `typeof service.timeout === "function"`，不符则回落 `systemTimer()` 并告警。
   - (b) 把内部接口改成宿主形状 `timeout(cb, delay)`，调度器 / 假 timer / 全部测试跟着改。
   - (c) 删掉宿主 timer 读取，只留 `systemTimer()`（落实 `80ca7ea` 的「不再依赖宿主 timer」）。
   - **选定 (a)**。理由：改动最小且修在形状边界；内部 `schedule(delay, cb) → dispose` 正好是条目「新增定时插件（统一 timer 原语）」拟定的统一接口，将来切统一面只换适配器；(b) 把宿主怪形状扩散进调度器与全部假件；(c) 与 D16 正面冲突、丢掉既有注入缝，且要改 README 与设计口径。
   - 附带更正：D16 里「fiber 绑定、插件卸载自动释放」对本包不成立（调研 3），本包继续手动 dispose；README 措辞同步。

2. **回归测试固化点**

   - (a) 新增 `hostTimer()` 适配器用例；把 `activation.test.ts` / `apply.test.ts` 的假 ctx timer 换成宿主形状（只有 `timeout`），并补一条「宿主形状 timer + 建任务 + `arm()` 不抛」的装配回归。
   - (b) 只加适配器用例，其余假件保留 `schedule` 形状。
   - **选定 (a)**。理由：本次事故的根因就是假件与宿主形状不一致；只补适配器用例不能防再犯。

3. **真机验证路线**

   - (a) 真实 `~/.dsh` + `--patch` 覆盖层（禁原行 + insert 本 worktree `dist/src/index.js` 绝对路径），在 herdr pane 里跑 TUI；不改 profile 文件，跑完即弃。
   - (b) 工作区克隆 `DSH_HOME`（复制 fff 的 `package.json` / `cordis.patch.yml` / `cordis.yml`，按包名建软链，凭据文件软链），session 与记录落工作区；偏差是 profile 目录不是 `~/.dsh/profiles/fff`。
   - (c) 先把修复合到 `main`，再按真实 profile 验（与「验证通过才提交」的顺序相反）。
   - (d) 用户手动执行，agent 只给命令清单与判据。
   - **选定 (a)**。理由：组合树、凭据、缓存目录都与实际挂载一致，最贴近验收；覆盖层已实测可用且不改 profile；herdr pane 是仓库既有的 TUI 交互面（`herdr-pane` 插件口径），命令不经 dsh 文件沙箱。若 pane 路线受阻，则以 (b) 兜底并记录偏差。

4. **文档回写**

   - (a) 只改 `background-daemon/README.md`「依赖声明」段（写明按宿主 `timeout(cb, delay)` 适配与回落口径）+ 本追踪文档；归档设计文档不动。
   - (b) 只改代码与追踪文档。
   - (c) 同时改归档设计文档 D16 与收尾记录。
   - **选定 (a)**。理由：README 是模块契约，必须与实际一致；设计文档已归档，改它等于改历史，口径更正记在本追踪文档。

## 规划

任务拆分与验收判据（原规划保留，此处细化）：

- **T1 代码修复**（`src/scheduler.ts` / `src/main.ts` / `src/index.ts`）
  - `scheduler.ts`：新增宿主形状接口 `HostTimerLike { timeout(callback, delayMs): () => void }` 与适配器 `hostTimer(service): TimerLike`；`TimerLike` 注释写明「内部统一面，宿主经 hostTimer 适配」。
  - `main.ts`：`readService<HostTimerLike>(ctx, "timer")` → 有 `timeout` 则 `hostTimer(...)`，无则 `systemTimer()`；服务在场但形状不符时告警 `ctx.timer 形状不符（缺 timeout）…`；`inject` 保持不含 `timer`（可选依赖口径不变）。
  - `index.ts`：导出 `hostTimer` / `HostTimerLike`。
- **T2 测试**（`tests/timer.test.ts` 新增；`tests/harness.ts` 增 `HostTimer` 假件；`tests/activation.test.ts` / `tests/apply.test.ts` 换假 ctx timer 形状）
  - 适配器映射：`schedule(1500, cb)` → 宿主收到 `(cb, 1500)`；返回的 disposer 透传到宿主 disposer；触发回调自证。
  - 装配回归：宿主形状 timer + `store.create` + `scheduler.arm()` 不抛（复现原 TypeError 的同一路径）；形状不符时回落并告警。
  - 既有 136 例保持全绿。
- **T3 门禁**：`npm --prefix background-daemon run check` / `build` / `test`；提交前 `format` 改动文件。
- **T4 真机验证**（脚手架落 `tmp/verify/`，`gitignore` 覆盖，收尾删除）
  - 覆盖层 `tmp/verify/overlay.yml`：`- id: background-daemon` + `disabled: true`；`- insert:` 一行，`name` 指向 `…/.worktree/background-daemon/background-daemon/dist/src/index.js`。
  - 启动：herdr pane 内 `cd <worktree> && dsh --profile fff --patch tmp/verify/overlay.yml`；判据：启动日志 `[background-daemon] 已启动（… backend=memory …）`、无「不可用」告警；`/daemon` 与 `daemon_task` 可用。
  - E1 文本投递：取本会话 `sessionId` → `daemon_task create`（`mode: deliver` / `after_seconds: 60`）→ 到点观察注入的 user 块与模型回应 → `/daemon log` 记 `delivered`。
  - E2 命令执行：`mode: command` / `payload: /daemon list` / `after_seconds: 60` → 到点观察命令回执 → `/daemon log` 记 `delivered`（含 detail）。
  - E3 重启恢复：建 `after_seconds: 120` 的 deliver 任务 → 退出 dsh → 过点重启（同 profile + 覆盖层，必要时 `--resume` 让目标会话活跃）→ 启动补发命中，journal 时间戳 ≈ 启动时刻。
  - E4 `skipped`：`deliver` 任务指向不存在会话（`sessionId: sess-not-exist`）→ journal 一行 `outcome: skipped` / `error: no-active-agent`，不重试。
  - E5 `backend=memory`：启动日志 `backend=memory`；`/daemon list` 有任务；`journal.jsonl` 与 memory-base 的 `daemon_task` 行可见。
  - 取证：pane 取屏关键行 + `~/.dsh/background-daemon/journal.jsonl` 对应行 + 启动日志，摘要写进「测试与证据」。
- **T5 收尾**：清理 `tmp/`（overlay、克隆 home、repro）；README 回写；追踪文档移 `docs/archived/`；BACKLOG 已接取条目移除（须用户同意关闭时执行）。

计划改动文件清单（细化后）：

- `background-daemon/src/scheduler.ts`（宿主适配器 + 注释口径）
- `background-daemon/src/main.ts`（形状守卫 + 适配 / 回落）
- `background-daemon/src/index.ts`（导出）
- `background-daemon/tests/timer.test.ts`（新增：适配器与回落）
- `background-daemon/tests/harness.ts`（宿主形状假 timer）
- `background-daemon/tests/activation.test.ts` / `background-daemon/tests/apply.test.ts`（假 ctx 改宿主形状）
- `background-daemon/README.md`（「依赖声明」段）
- 本追踪文档
- 真机脚手架落 `tmp/verify/`（被 `.gitignore` 忽略，不入库，收尾删除）

明确不做：不做周期投递等新功能；不重做已合入的设计；不推进 `/daemon` 之外的通路；不新增 `/daemon status` 子命令；不改「新增定时插件（统一 timer 原语）」条目的范围；不改归档设计文档；不改 `~/.dsh/profiles/fff` 的 profile 文件。

## 实现记录

（按时间追加）

- 2026-10-19 T1 代码：
  - `src/scheduler.ts`：`TimerLike` 注释改为「内部统一面」；新增 `HostTimerLike { timeout(callback, delayMs): () => void }` 与适配器 `hostTimer(service): TimerLike`（`schedule(delay, cb)` 转调 `service.timeout(cb, delay)`）。
  - `src/main.ts`：`readService<HostTimerLike>(ctx, "timer")` → 有 `timeout` 则 `hostTimer(...)`，否则回落 `systemTimer()`；宿主对象在场但缺 `timeout` 时告警 `ctx.timer 形状不符（缺 timeout）：改用进程内定时器`；`inject` 保持不含 `timer`。
  - `src/index.ts`：导出 `hostTimer` / `HostTimerLike`。
- 2026-10-19 T2 测试：
  - `tests/timer.test.ts` 新增 3 例：适配器映射与 disposer 透传；宿主形状 timer 建任务 + `arm()` 不抛 + 到点投递成功；形状不符回落 + 告警。
  - `tests/harness.ts` 新增宿主形状假件 `HostTimer`（只实现 `timeout`）；`tests/activation.test.ts` / `tests/apply.test.ts` 的假 ctx timer 从 `FakeTimer`（`schedule` 形状）换成 `HostTimer`（宿主形状），使其与真机一致。
- 2026-10-19 门禁：`npm run check` 通过；`npm test` 139 例全通过（136 + 3）；`npm run build` 通过。
- 2026-10-19 复现重验：`tmp/repro.ts`（宿主形状 timer）改跑修复后代码输出 `arm ok`（修复前同脚本抛 `TypeError: this[#options].timer.schedule is not a function`）。

## 偏差

（2026-10-20 更新，主分支合入 timer 统一面后校正）

- **决策 1 / 规划 / 实现记录中的 `hostTimer` 适配已被主分支取代**：主分支落地「新增定时插件（统一 timer 原语）」条目（commit `9cee6b3`，追踪文档 `docs/archived/2026-10-19-timer-plugin.md`），`background-daemon` 改读 `timer` 插件的 `clock` 服务（`readService<ClockLike>(ctx, "clock")`，缺失回落 `systemTimer()`）；我此前合入本分支的 `HostTimerLike` / `hostTimer` 与宿主形状测试在 `7532f92` 被丢弃，worktree 已同步到 main（`3396f3e`）。任务实际验证的是 clock 统一面版本，D16 口径由 timer 插件承接。
- **T4 真机实际做法**：主分支合入后 profile 挂载点（主 worktree）的 dist 已是 clock 版本，故真机直接用 `dsh --profile fff`（决定 3(a) 的 `--patch` 覆盖层未用），即验证「真实挂载」本身。
- **E5 未达成**：真机启动日志为 `backend=json`（非 memory），且没有「memory-base 记录底座不可用」降级告警 → `readService(ctx, "memory")` 在真实 cordis ctx 上未取到服务（memory 属可选依赖、不在 `inject` 里，严格模式读取不可达）。「memory-base 可用时 `/daemon` 状态面报 `records: memory`」的验收不成立，需主分支裁定（是否补 `inject` / 改惰性解析 / 另行处理）。佐证：`~/.dsh/memory-base/memory.db` 自 10-18 起未被写入，说明各 fff 进程均未走到 memory 底座。
- **E3 时间戳观察（已复验，2026-10-20 重启后）**：首轮 E3 的 journal `at` 等于计划触发时刻（06:34:21.544Z），当时进程已在退出流程中（或读屏缓存误导退出时刻），不能作为启动补发证据。重启后新增 E3b 复验：任务 `d-b91c6c68`（触发 06:51:51.019Z）在进程退出后过点重启，成功被载入并于启动补发时刻触发（`at=06:52:12.579Z` ≈ 重启提交时刻，非计划时刻），outcome `skipped`（启动补发时目标会话尚未注册活跃 agent，设计内不重试）→ 启动补发路径成立，且 `at=now` 语义正确。
- **多实例共享 tasks.json 的覆盖（环境性发现）**：验证期间本机同时运行多个 `dsh --profile fff` 实例（其他 worktree 会话 / 主会话），共享 `~/.dsh/background-daemon/tasks.json`；各实例在启动时各自 load、变更时整文件写回（无锁、无合并）→ 相互覆盖。观察到：E1-E4 的 4 条任务在验证后期从 tasks.json 消失，文件被换成他人任务（`d-d932d07d`，06:43:17Z 创建，非本任务创建）等。背景设计面向**单 dsh 进程**（目标 = 本进程内活跃 agent），此共享覆盖在多实例环境属预期副作用，真实单实例部署不受影响；但「重启恢复完整保留任务表」的验收在共享环境下不可单独归因，证据以单任务 E3b 为准。

## 测试与证据

（2026-10-20 真机，`dsh --profile fff`，真实 `~/.dsh`，herdr pane `wWR:p2` / 重启后 `wWR:p3`）

- 门禁：`npm --prefix background-daemon run check` 通过；`npm --prefix background-daemon test` 137 例全绿（clock 版本）。
- 启动：`[background-daemon] 已启动（任务 1 个，backend=json，store=/home/guochang/.dsh/background-daemon/tasks.json，journal=/home/guochang/.dsh/background-daemon/journal.jsonl）`（stderr 落盘 `tmp/bg-err.log`）；`/daemon list` 与 `daemon_task` 均注册可用。
- **E1 文本投递 ✓**：`daemon_task create`（deliver / after_seconds:60 / 会话 `tui-dc2f5407-…`）→ task `d-6500b1f8` 于 06:27:53.178Z 触发，journal `delivered` / 17ms / `flush 确认（合并 1 条）`；pane 内目标会话收到注入正文 `[DAEMON] 真机验证 E1 文本投递`。
- **E2 命令执行 ✓**：command 任务 `d-c29aad21`（payload `/daemon list`）于 06:29:50.627Z 触发，journal `delivered` / 2ms，detail 含命令回执文本（`守护任务 2 个：…`）。
- **E3 重启恢复 ✓（含 E3b 补发复验，2026-10-20 重启后）**：deliver 任务 `d-b0cf39db`（after_seconds:150）创建后退出 dsh，过点后 `--resume` 重启同会话；重启后任务表保留（`/daemon list` 可见、status done），journal 记 `skipped`（`no-active-agent`，设计内不重试）。另起 E3b 复验启动补发：任务 `d-b91c6c68`（触发 06:51:51.019Z）在退出后过点重启（`--resume tui-0e1094fd-…`），启动时被载入并补发，journal `at=06:52:12.579Z` ≈ 重启时刻（stderr 启动行 `[background-daemon] 已启动（任务 2 个，backend=json，…）`），outcome `skipped`，单条记录不重试。
- **E4 无活跃 agent 的 skipped ✓**：deliver 任务 `d-ac6816b3`（sessionId `q-no-such-session-xyz`）于 06:41:17.223Z 触发，journal `skipped` / `no-active-agent`，仅一条记录、不重试，任务 status done。
- **E5 backend=memory ✗**：启动日志 `backend=json`；`records: memory` 未达成（无 `/daemon status` 子命令，只能经启动日志 / `ctx.backgroundDaemon.status()` 观察）。journal 4 行、tasks.json 4 条均落在本地文件，memory-base 库未参与。
- 遗留物：验证 pane `wWR:p3`（运行中，dsh 进程 `dsh --profile fff --resume …`，stderr `tmp/bg-err3.log`）；临时文件 `tmp/bg-err*.log`、`tmp/verify/overlay.yml`、`tmp/repro.ts`（收尾清理）。

## 收尾

（待写。）
