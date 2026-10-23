# 其余包接入定时器统一面 `clock`（接取条目：`docs/BACKLOG.md`「其余包接入定时器统一面 `clock`」）

状态：已关闭（2026-10-23）　　开启：2026-10-22　　关闭：2026-10-23
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把各包里的裸定时器换成 `clock-base` 插件提供的 `clock` 服务，使**插件级排期**随调用方 fiber 卸载自动撤销、**操作级超时**在卸载时立即收尾（不悬挂），并让测试可注入假时钟。

交付：`herdr-integration` / `herdr-use` / `script-interpreter` / `rule-engine` / `task-engine` / `auto-approve` / `ast-tools` / `command-template` 八个包的改造 + `ManualClock` 断言 + 服务缺失降级（进程内定时器 + 每个插件实例告警一次）。

边界：不动 TUI 内部的渲染节律定时器（34 处）；不改 `timer` 的服务面；不改宿主 `cordis-plugin-timer`。

## 调研

来源：本仓八包源码（逐处读实现与调用链）、`clock-base/src/timers.ts` / `clock-base/README.md`、既有消费方 `background-daemon` / `session-channel` / `metric-loop` 的接线先例。

### 裸定时器清单与分类

`grep -rn 'setInterval\|setTimeout'` 计数（2026-10-22，含类型标注与子进程脚本字符串）：

| 包 | 位置 | 形态 | 分类 |
| --- | --- | --- | --- |
| `herdr-integration` | `src/main.ts:327` | 周期补发状态（20 s，`unref`，dispose 清理） | 插件级排期 |
| `herdr-integration` | `src/herdr.ts:24,26` | 面板协议**子进程脚本字符串**里的 `setTimeout` | 非本进程 |
| `herdr-integration` | `src/herdr.ts:262,278` | socket 单次请求等待超时 | 操作级超时 |
| `herdr-use` | `src/cli.ts:122,147` | CLI 子进程超时 SIGKILL | 操作级超时 |
| `herdr-use` | `src/socket.ts:153` | socket 读超时 | 操作级超时 |
| `herdr-use` | `src/socket.ts:312` | `realClock.sleep`（判稳间隔） | 操作级等待 |
| `script-interpreter` | `src/run.ts:326` | SIGTERM → 1 s → SIGKILL 宽限 | 操作级超时 |
| `script-interpreter` | `src/run.ts:386` | 脚本总超时 | 操作级超时 |
| `rule-engine` | `src/inject.ts:106` | 注入推迟一个宏任务（0 ms） | 插件级排期 |
| `task-engine` | `src/main.ts:395` | 子代理 / 裁决 run 超时 | 操作级超时 |
| `auto-approve` | `src/review.ts:303` | 审查模型调用超时 | 操作级超时 |
| `auto-approve` | `src/learn.ts:614` | 学习审阅 2 s 合并窗口（已有 `schedule` 注入缝） | 插件级排期 |
| `ast-tools` | `src/binary.ts:140` | ast-grep 子进程超时 SIGKILL | 操作级超时 |
| `command-template` | `src/subagent.ts:99` | 子代理步骤超时 | 操作级超时 |

### 既有接线先例

- `background-daemon`：`resolveTimers(ctx)` 读 `clock`，`clock.scope(ctx)` 造排期器，缺失回落 `systemTimer()`；
- `session-channel`：心跳 `interval` 走 `clock.scope(host)`，`stop()` 调 disposer；
- `metric-loop`：只消费 `clock.now()`。

### 发现的两处事实

1. `clock-base/README.md:44` 称 `ManualClock` 自带 `scope()`，实际实现（`clock-base/src/timers.ts:142-227`）只有 `now` / `schedule` / `interval` / `advance` / `pending`。测试里以 `{ now: () => manual.now(), scope: () => manual }` 适配；`timer` 包不在本任务范围内（仅记录，留待后续条目）。
2. 仓内包彼此零运行时依赖，且各包 `tsconfig` 的 `rootDir` 是本包目录 → 测试直接 import `clock-base/src/timers.ts` 会触发 TS6059。沿用 `md-table-check` 的先例：把跨包测试文件从本包 `tsconfig.json` 的 `include` 中排除（`exclude` 一行），测试运行时（node 类型擦除）仍能 import 真实 `ManualClock`。

## 决策

写作要求：决策项用数字、选项用 abcd，选定项写明字母与理由。

**决策项 1（转换范围）= c**

- a) 只换插件级长生命周期排期（仅 `herdr-integration` / `rule-engine` / `auto-approve` 三处）
- b) 只换「不影响在途操作」的排期
- c) 八包全部转换；按语义分两类绑定

选定 c。理由：条目验收要求「每包卸载后无残留排期」，只换三处无法覆盖八包；八包全部走 `clock` 后，假时钟可覆盖全部超时路径，测试不再真等。

**决策项 2（绑定语义）= b**

- a) 全部 `clock.scope(ctx)`（fiber 绑定），卸载即撤销
- b) 插件级排期用 `scope(ctx)`；操作级超时用 `scope(ctx)` + **每次排期另注册一个 `ctx.effect`**：卸载时立即触发超时收尾（杀子进程 / abort 运行 / abort 审查）并撤销排期
- c) 操作级超时用 `scope()`（不绑定 fiber），调用方只靠显式 disposer

选定 b。理由：a 会让在途子进程 / 子代理 / 模型调用在插件卸载时**失去兜底超时**而悬挂；c 做不到「卸载后无残留」。b 两者兼得：卸载时排期清零，同时在途操作被立即终止（与超时同一条收尾路径，因此子进程不会残留、工具调用不会悬挂）。

**决策项 3（降级口径）= a**

- a) 服务缺失 / 形状不符 / `scope` 抛错 → 回落进程内定时器（`setTimeout` / `setInterval` + `unref`），每个插件实例**只告警一次**
- b) 服务缺失 → 不排期（fail-closed）
- c) 服务缺失 → 每次调用各告警

选定 a。理由：`clock` 是可选服务（不进 `inject`），缺失不得影响插件加载；逐次告警会刷屏。

**决策项 4（代码形态）= a**

- a) 每个包新增包内 `src/timers.ts`（结构面类型 + `resolveClock` + `createDeadline`），不跨包 import
- b) 新建共享工具包供八包依赖
- c) 各包就地写最小内联代码

选定 a。理由：仓内「包彼此零运行时依赖、服务读取按结构面复制」的既定惯例（`readService` 在多包各有一份）；b 会引入新的跨包依赖与新包接线；c 无法统一降级与告警语义。

**决策项 5（`Deadline` 契约）= b**

- a) `(delayMs, fire: () => void) => cancel`
- b) `(delayMs, fire: (why: "timeout" | "unload") => void) => cancel`

选定 b。理由：卸载时 `script-interpreter` 需要直接 SIGKILL（不再排 1 s 宽限，否则卸载后仍有残留排期）；其余包可忽略 `why`。

**明确不做**

- 不改 `clock-base` 包（`ManualClock` 缺 `scope` 的 README 偏差只记录）。
- 不改 TUI 内部 34 处渲染节律定时器。
- 不改 `herdr-integration/src/herdr.ts` 面板协议**子进程脚本字符串**里的 `setTimeout`（不是本进程排期）。
- 不改 `docs/STATUS.md` / 两级 `BACKLOG` / `SPEC` / `README` / `COMMANDS`（本任务不做收尾）。
- 不做真机验收。

## 规划

### 任务拆分

1. 八个包各加 `src/timers.ts`：`TimersLike` / `ClockLike` 结构面、`systemTimers()` 回落、`resolveClock(ctx, warn)`（返回 `scoped` / `detached` 两组排期器，缺失时告警一次）、`createDeadline(timers, ctx)`（卸载即收尾）。
2. 逐包接线：
   - `herdr-integration`：`main.ts` 周期补发改 `scoped.interval`；`HerdrClientOptions.deadline`，socket 请求等待改 deadline。
   - `herdr-use`：`createDefaultRunner(bin, deadline)`、`createNetConnector(deadline)`；`createClock(timers)` 供判稳读钟 / sleep（用 `detached`，卸载不撤销睡眠）。
   - `script-interpreter`：`RunOptions.deadline`，总超时与 SIGTERM 宽限都走 deadline；`ToolRuntime.deadline` 从 `apply` 透传。
   - `rule-engine`：`InjectorOptions.schedule`，`apply` 传 `scoped.schedule`（卸载即取消，不再注入）。
   - `task-engine`：`runChildOnce` 的 `opts.deadline`；`ExecutorWireOptions` / `semanticHooksFor` 透传。
   - `auto-approve`：`Reviewer.deadline` + `runReview` / `runLearnReview` 走 deadline；学习窗口 `schedule` 走 `scoped.schedule`。
   - `ast-tools`：`AstOptions.deadline`，`runCli` 超时走 deadline；`createAstToolsBundle` 从 `apply` 透传。
   - `command-template`：`OneShotAgentOptions.deadline`，服务构造时解析一次并透传。
3. 每包 `tests/clock.test.ts`（跨包 import 真实 `ManualClock`，从本包 `tsconfig.exclude` 排除）：
   - `resolveClock`：clock 可用时返回 `fromClock: true` 且 `scope` 收到本插件 ctx；缺失时回落 + 告警恰好一次；
   - `createDeadline`：到点触发 `timeout`；模拟 fiber 卸载后回调触达（`unload`）且 `ManualClock.pending === 0`；
   - 该包接线用例：排期确实经由假时钟（`advance` 触发 / `pending` 计数），插件级排期在卸载后清零；服务缺失时插件仍可工作。
4. 验证：八包 `check` / `test`；根 `npm run check` / `npm run build`（本环境无全局 `tsc`，用 `/home/guochang/.pi-lens/tools/node_modules/typescript/bin/tsc` + 缓存 `@types/node` 的 `--typeRoots` 执行，命令记入「测试与证据」）。

### 计划改动文件清单

- 八包各新增：`src/timers.ts`、`tests/clock.test.ts`
- `herdr-integration`：`src/main.ts`、`src/herdr.ts`、`tests/main.test.ts`、`tsconfig.json`（exclude 跨包测试）
- `herdr-use`：`src/main.ts`、`src/cli.ts`、`src/socket.ts`、`tests/cli.test.ts` / `tests/net.test.ts`（按需）、`tsconfig.json`
- `script-interpreter`：`src/index.ts`、`src/run.ts`、`src/tools.ts`、`tests/run.test.ts`（按需）、`tsconfig.json`
- `rule-engine`：`src/main.ts`、`src/inject.ts`、`tests/inject.test.ts`、`tests/main.test.ts`（按需）、`tsconfig.json`
- `task-engine`：`src/main.ts`、`tests/`（新增或既有 executor 测试）、`tsconfig.json`
- `auto-approve`：`src/main.ts`、`src/review.ts`、`src/decide.ts`、`tests/`（新增或既有审查测试）、`tsconfig.json`
- `ast-tools`：`src/index.ts`、`src/binary.ts`、`src/types.ts`、`tests/cli.test.ts`（按需）、`tsconfig.json`
- `command-template`：`src/main.ts`、`src/subagent.ts`、`tests/`（新增）、`tsconfig.json`
- 本文档（调研 / 决策 / 规划 / 实现记录 / 测试与证据）

### 验收

- 八包每包至少一条 `ManualClock` 用例：假时钟下排期可见（`pending` / `advance` 触发），模拟 fiber 卸载后 `pending === 0` 且操作级超时收尾被触达。
- 八包每包至少一条服务缺失降级用例：不抛错、功能照常、告警恰好一次。
- 八包 `check` / `test` 全绿；根 `check` / `build` 全绿。

### 明确不做（再次约束）

不做收尾：追踪文档不归档、两级 `BACKLOG` 不改、`SPEC` / `README` / `COMMANDS` 不动；不 commit 到 main、不 push。

## 实现记录

2026-10-22（实现完成检查点）：

八包各新增 `src/timers.ts`（结构面 `TimersLike` / `ClockLike`、`systemTimers()` 回落、`resolveClock`、`createDeadline`；同文复制，包间零运行时依赖）。逐包接线：

- `herdr-integration`：周期补发改 `timers.scoped.interval`，`dispose()` 调 disposer；`HerdrClientOptions.deadline`，socket 单次等待改 deadline；`HerdrPluginDeps.warn`。
- `herdr-use`：`createDefaultRunner(bin, deadline)` 与 `createNetConnector(deadline)`；新增 `createTimersClock(timers)`（判稳 `now` / `sleep` 用不绑定 fiber 的排期器，避免卸载撤销 sleep 让 Promise 永不结算）；`HerdrUseDeps.warn`。
- `script-interpreter`：`RunOptions.deadline` / `ToolRuntime.deadline`；总超时与 SIGTERM 宽限都走 deadline，卸载原因**直接 SIGKILL**（不再排 1 s 宽限）；`apply` 装配期解析并注入。
- `rule-engine`：`InjectorOptions.schedule`；`apply` 传 `scoped.schedule`（卸载即取消推迟的注入）。
- `task-engine`：`runChildOnce` 的 `opts.deadline`、`ExecutorWireOptions.deadline`，executor 的 subagent run 与 audit / entail 裁决 run 共用；`apply` 装配期解析。
- `auto-approve`：`Reviewer.deadline` + `runReview` / `runLearnReview` 走 deadline；学习窗口走 `scoped.schedule`；`createBundle` 装配期解析。
- `ast-tools`：`AstOptions.deadline` / `runCli(..., deadline)`；`createAstToolsBundle(config, deadline)` 由 `apply` 注入；`BundleHost` 补 `get` / `effect` 结构面。
- `command-template`：`OneShotAgentOptions.deadline`；`CommandTemplateService` 构造期解析一次并透传给每次 agent 步骤。

关键命令与结果（本环境未安装全局 `tsc`，用外部 5.9.3 + 缓存 `@types/node`；`npm run check` 在本机报 `tsc: not found`，故用等价直调）：

```sh
TSC=/home/guochang/.pi-lens/tools/node_modules/typescript/bin/tsc
TYPES=/home/guochang/.npm/_npx/ab5cd9f6d13a2312/node_modules/@types
cd <pkg> && node $TSC -p tsconfig.json --noEmit --typeRoots $TYPES   # check
cd <pkg> && node $TSC -p tsconfig.json --typeRoots $TYPES            # build（dist/ 已被包内 .gitignore 忽略）
```

八包 check / build 均以退出码 0 通过（2026-10-22，源码完成后）。`format` 已对本次改动的 33 个 TS 文件执行（`/home/guochang/fff/scripts/format`）。

## 偏差

- 计划清单里的 `tests/cli.test.ts` / `tests/net.test.ts` / `tests/inject.test.ts` / `tests/run.test.ts` 等（标「按需」）未改：新用例集中在新文件 `tests/clock.test.ts`。`rule-engine/tests/main.test.ts` 属计划外修改——其假宿主补了 `clock` 服务，否则新增的回落告警会改变既有告警计数与 stderr 断言；回落路径由新测试专门覆盖。
- 各包 `tsconfig.json` 各加一行 `exclude`（超出「只改 src/tests」的字面范围）：测试要 import 真实 `ManualClock`（`clock-base/src/timers.ts`），在包内 `rootDir` 下触发 TS6059；沿用 `md-table-check` 的既有先例把跨包测试文件排除出类型检查。该行不影响构建产物。
- 计划中的「根 `npm run check` / `npm run build`」改为逐包等价直调 tsc：本机没有可用 `tsc` 命令。
- 按用户要求不做收尾：追踪文档未归档、两级 `BACKLOG` 未改、`SPEC` / `README` / `COMMANDS` 未动。

## 测试与证据

2026-10-22（测试通过检查点）：

- 新用例：八包 `tests/clock.test.ts` 共 54 例（herdr-integration 8 / herdr-use 8 / script-interpreter 8 / rule-engine 5 / task-engine 6 / auto-approve 6 / ast-tools 7 / command-template 6）。每包均覆盖：`resolveClock` 形状与回落告警恰好一次；`createDeadline` 的到点与卸载两条路径（卸载后 `ManualClock.pending === 0`）；该包接线用例（假时钟 `advance` 触发超时 / 插件级排期在卸载后清零 / 服务缺失仍可工作）。
- 包内全套（`npm test`，`fail 0`）：
  - herdr-integration 57 / 57
  - herdr-use 164 / 164
  - script-interpreter 94 / 94
  - rule-engine 173 / 173
  - task-engine 142 / 142
  - auto-approve 155 / 155
  - ast-tools 45 / 45
  - command-template 33 / 33
- 类型检查与构建：八包 `node <tsc> -p tsconfig.json --noEmit --typeRoots <types>` 与 `node <tsc> -p tsconfig.json --typeRoots <types>` 均退出码 0。
- 卸载无残留的直接证据：各包 `createDeadline` 用例在模拟 fiber 卸载后断言 `manual.pending === 0`；herdr-integration 的周期补发在 `plugin.dispose()` 后 `pending === 0`；rule-engine 卸载后推进假时钟不再回调宿主；task-engine / command-template / auto-approve 的在途 run / 审查在卸载时被立即中止且 `pending === 0`。
- 已知现象：command-template 既有测试的宿主 ctx 不提供 clock，运行时会打印一行回落告警（预期文案；既有断言不依赖 stderr 为空）。
- 未做真机验收（按用户要求）。

## 接线上发现的缺陷（2026-10-23，主分支）

真机接入 profile 时出现三条告警：`[rule-engine] warn: clock 服务不可用`、`dsh: warning: 1 entry did not activate`、`hmr: pending (waiting for service: timer)`。逐层排查后是**两个接线缺陷**，都不在本条的实现里，而在挂载面：

1. **bundle 未登记**：profile 的 `dsh.profile.bundles` 里没有 `@dsh-toolset/timer`（当时包名; 现已改为 `@dsh-toolset/clock-base`）。只在 profile patch 写 `- id: timer` 是无效的 —— 宿主对非 `insert` 补丁先按 id 查找已有条目，找不到就跳过（`dsh-app-boot/lib/index.js:95-99`）。修法：把包加进 bundles（排在消费方之前），让包内 `cordis.patch.yml` 的 `- insert:` 生效。
2. **条目 id 撞车**：宿主 base 已有 `- id: timer`（`@deepseek-ai/cordis-plugin-timer`, `dsh-base/cordis.patch.yml:24-25`）。本包原 patch 也用 `id: timer`，重复 id 使其中一条未激活、`hmr` 一直等 `timer` 服务。修法：本包条目 id 改为 `timer-toolset`（`cordis.patch.yml`、`src/main.ts` 的 `export const name`、README 示例、单测断言同步）。

验证：`dsh --profile fff --dump-config` 可见宿主 `- id: timer` 与我们的 `- id: clock-base`（当时临时名 `timer-toolset`）并存且无重复；重启后最新一次启动只余一条无关的 `herdr-use` 告警，上述三条均未再出现；`timer` 单测 24 例全过。

## 关闭（2026-10-23）

- **真机复验**：本会话于 2026-10-23 09:51 启动（改名后）。在沙箱内以 `DSH_HOME` 复刻 profile 跑 `dsh --profile fff --dump-config`（只读，临时目录已删）：组合 160 条、stderr 0 字节 → 无「1 entry did not activate」、无「waiting for service: timer」；宿主 `- id: timer` 与本仓 `- id: clock-base` 并存且 id 不撞；`clock-base` 与八个消费方条目都在树内（`clock-base` 在 564 行，消费方自 575 行起）。
- **测试**：2026-10-23 全量 30 包 0 失败。本条相关：`clock-base` 24、herdr-integration 57、herdr-use 164、script-interpreter 94、rule-engine 173、task-engine 142、auto-approve 157、ast-tools 45、command-template 33；根 `npm run check` 通过。
- **未取证**：运行中各包是否真取到 `clock` 服务（缺失只打一行回落告警并降级）——该告警只出现在启动终端，沙箱内取不到。
- **收尾动作**：条目从 `docs/BACKLOG.md` §2 移除并补关闭注记；「实现顺序与并行分组」表删去 D 组行、并注明余下六组；本文件移入 `docs/archived/`；`TUI` / `SPEC` / `README` / `COMMANDS` 不动（本条不涉界面与命令）。
- **提交**：实现 `190ee24`、假时钟与降级用例 `e40f5d0`；接线修复 `86e44f3`（条目 id 改 `timer-toolset`）与 `2d2fbd4`（包名改 `clock-base`）。
