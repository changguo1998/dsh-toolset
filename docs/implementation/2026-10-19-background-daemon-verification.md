# background-daemon 真机验证（接取条目：docs/BACKLOG.md「background-daemon 真机验证（已挂载，发现 timer 适配缺陷）」）

状态：调研　　开启：2026-10-19　　关闭：
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

（待写。）

## 偏差

（待写。）

## 测试与证据

（待写。）

## 收尾

（待写。）
