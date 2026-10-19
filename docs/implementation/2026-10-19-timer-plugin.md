# 新增定时插件（统一 timer 原语）（接取条目：docs/BACKLOG.md「新增定时插件（统一 timer 原语）」）

状态：测试　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

新增一个本仓定时插件 / 统一面，封装宿主原语（`cordis-plugin-timer` 的 `timeout(cb, delay)` / `interval(...)`，fiber 绑定、无 `schedule`）与进程内回退，至少含 `schedule(delay, cb) → dispose`、`now()`、可注入假时钟，供各包按需注入、卸载不泄漏；消费方（`TUI` 的 `StatusTicker` / `session-channel` 心跳 TTL / `background-daemon` 的 `TimerLike` / `metric-loop` 测量节奏）统一走该面。先按条目「接取时裁定」三项定形态。

## 调研

来源：宿主已装包 `@deepseek-ai/cordis-plugin-timer@1.1.7`（`~/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis-plugin-timer/src/index.ts`）、`@deepseek-ai/cordis` 的 `Service` / `mixin` 源码（`.../node_modules/@deepseek-ai/cordis/src/reflect.ts`）、本仓四消费方源码、`docs/host/HOST-PACKAGES.md`；行为结论另用四段临时探针（`tmp/probe-*.mjs`，验证完已删）在真实 cordis + timer 上实测装载 / 卸载。

**宿主 timer 事实**

- 服务名 `timer`、类 `TimerService`：`timeout(cb, delay)` / `interval(cb, delay)`（回调在前，返回 disposer），另有 `timeout(delay)` / `interval(delay)` 的 Promise / async iterator 重载、`throttle` / `debounce`；`setTimeout` / `setInterval` 已标 deprecated（内部转调 `timeout` / `interval`）。
- **无 `schedule`**：探针实测 `typeof ctx.timer.schedule === "undefined"`（1.1.4 与 1.1.7 两份源码相同）——这就是 BACKLOG 条目 1 的真机报错根因。
- **fiber 绑定只在 mixin 形态成立且实测成立**：`ctx.mixin('timer', [...])` 暴露 `ctx.timeout` / `ctx.interval`；探针（consumer fiber 在 30 ms 时 dispose：60 ms 一次性回调从未触发、20 ms interval 冻在 1 次）确认回调随 fiber 卸载撤销；直接调服务对象（`ctx.timer.interval`）同样受绑定（第二段探针：dispose 后 ticks 冻在 2）。
- **严格模式读服务**：未声明 `inject: ['timer']` 时读 `ctx.timer` 抛 `cannot get property "timer" without inject`（探针实测）——可选消费必须走 `ctx.get('timer')` / `readService` 这类受保护读取；cordis 的 `inject` 只表达**必需**依赖（`registry.ts`："the required service name"），没有可选注入。
- **不支持 unref**：`timeout` / `interval` 只返回 disposer，拿不到 handle，内部 `setTimeout` 未 unref；而 `session-channel`（`#heartbeatTimer.unref?.()`，`src/index.ts:338-342`）与 `background-daemon`（`systemTimer()` 里 `handle.unref?.()`，`src/scheduler.ts:37-45`）都靠 unref 避免拖住进程退出 —— 直接包装宿主 timer 会把这两处变成「进程不退出」。
- 宿主服务表无 `clock`（`HOST-PACKAGES.md` §3 服务清单），新服务名 `clock` 与宿主不冲突。

**本仓约束**

- 29 个包零运行时依赖（各 `package.json` 只有 `@types/node` + `typescript`），`@deepseek-ai/cordis` 是宿主 workspace 包、不可 import（`security-guard/src/index.ts:7`、`goal-contract/src/index.ts:6` 等已声明）→ 不能 `extends Service`，也就拿不到 cordis 的「调用方 ctx 自动绑定」；跨包共享只能走 ctx 服务 + 结构化类型（`sessionPaths` / `backgroundDaemon` 同款）。
- 可选服务消费的既定姿态：`sessionPaths` 不写进消费方 `inject`，用 `ctx.get` 探测 + 结构性回落（`memory-base/src/index.ts:76-79`、`:199-204`）。
- TUI 对可选服务一律懒读（`getSymbols` / `getSessionChannel` / `getRuleEngine` / `getGuard`，`TUI/src/main.ts:78-85`、`:765-777`），以容忍插件装载顺序；`StatusTicker` 已留 `schedule?: (fn, ms) => () => void` 注入缝（`TUI/src/app/status.ts:24-31`、`:54-65`），`App` 在 `TUI/src/app/index.ts:1141` 构造它，`main.ts:125` 给 `intervalMs: 1000`。

**四消费方现状**

- `background-daemon`：`TimerLike { schedule(delayMs, cb): () => void }`（`src/scheduler.ts:31-45`）+ `systemTimer()`（unref）回落；`main.ts:218` 把宿主 `timer` 当 `TimerLike` 读 → 真机 `timer.schedule is not a function`；另有独立 `now` 选项（`scheduler.ts:86`，测试注入 `() => clock.value`）。
- `session-channel`：心跳 `setInterval` + `unref`（`src/index.ts:338-342`），`stop()` 里 `clearInterval`（`:351-354`）；`heartbeatMs` 缺省 5 s、在线键 TTL 15 s（`src/constants.ts:7-10`）。
- `metric-loop`：**不跑定时器**——只有 `now` 注入（`MetricLoopController` opts，`src/index.ts:223`）与 cadence 算术，周期唤醒交给宿主 `schedule_create` 提示（`src/engine.ts:223-240`）。
- `TUI`：`StatusTicker` 缺省 1 s `setInterval`（`src/app/status.ts:54-65`），已可注入调度器。

**候选形态探针（先验证再定稿）**

- 纯对象服务（`ctx.provide('clock', { now, scope })`）+ `scope(ctx)` 里用 `ctx.effect(...)` 注册清理：consumer fiber 25 ms dispose → 20 ms interval 停在 1 次、60 ms 一次性回调未触发 —— **不 import cordis 也能做到 fiber 绑定**（探针 3：无 `#private`、无 `Service` 子类，只用 `ctx.effect`）。
- 反例：若把本地 timer 的清理登记在服务提供方 fiber 上（服务自持 Set 或构造期 `ctx.effect`），consumer 卸载后 60 ms 回调照常触发（探针 2 的 fallback 分支 `fired=1`）——故接口必须拿到**调用方 ctx**，这也是 `scope(ctx)` 的来源。
- 装载顺序风险：`clock` 若晚于消费方激活，消费方 apply 期的 `ctx.get('clock')` 会是 `undefined`。收尾时以 `scripts/install.sh` 的 `canonical_pkgs` 置首 + 消费方惰性解析（首次使用时读）双重保障。

## 决策

写作要求：决策项用数字、选项用 abcd，选定项写明字母与理由。决策项 1-3 对应条目「接取时裁定」的 ①②③，决策项 4 是落地时派生项。

**决策项 1（形态）= a**

- a) 独立新包 `timer`（`@dsh-toolset/timer`，服务 `clock`）
- b) 放进既有工具包（如 `session-paths`）
- c) 不建包，只修 `background-daemon` 的适配

选定 a。理由：四个消费方是四个独立包、彼此零依赖，统一面必须可跨包共享 → 只能是新包或塞进既有包；塞进 `session-paths` 会让「会话目录编码」承担定时语义（名不副实），且消费方要么硬依赖该包，要么再各写一份读取代码；独立包与仓内「一个能力一个包」一致，可单独挂载 / 卸载。代价：四处清单（根 `package.json` 的 check/build、`scripts/test-parallel.sh`、`scripts/install.sh`、`AGENTS.md` 与两版 README 的计数与清单）各加一项。

**决策项 2（接口形状）= b**

- a) 对齐宿主 `timeout(cb, delay)`（回调在前），只提供一次性
- b) `Timers { now(); schedule(delayMs, cb): Disposer; interval(delayMs, cb): Disposer }`，服务 `clock = { now(); scope(ctx): Timers }`
- c) 只提供 `schedule` + `now`，重复间隔由消费方自建

选定 b。理由：延迟在前是条目原文与 `background-daemon` 既有 `TimerLike` 的形状，改动面最小；`interval` 是 `session-channel` 心跳与 TUI 1 s 刷新必需（省掉消费方各写一份 setInterval + 清理）；`now()` 与定时器同源后，假时钟一次注入即可同时驱动「排期」与「读钟」（`background-daemon` 的 `now` 选项与 Scheduler 的补发判断因此不再各拿一份）；`scope(ctx)` 是「不 import cordis 也能把清理挂到调用方 fiber」的唯一可靠机制（见调研探针 3），也是「卸载不泄漏」的落点。

明确不做：不提供 `sleep()` / `debounce` / `throttle`（无消费方；`session-channel` 的重试 sleep 是 Promise 语义，混进来会扩大审查面），需要时再加。

**决策项 3（与宿主 `cordis-plugin-timer` 的关系）= b**

- a) 包装：统一面内部优先调 `ctx.timeout` / `ctx.interval`
- b) 并存：统一面自实现（本地 `setTimeout` / `setInterval` + 调用方 `ctx.effect` 清理 + `unref`），宿主 `timer` 保持不动
- c) 替代托管：用 `timer` 作服务名接管宿主面

选定 b。理由：包装需要 (1) 消费方声明 `inject: ['timer']`（cordis 无可选注入，无 timer 的组合会整包不加载）、(2) 宿主 timer 不支持 unref（两处消费方依赖 unref，见调研）、(3) 宿主 `timeout(cb, delay)` 与仓内 `schedule(delay, cb)` 参数序相反，还要分辨 `timeout(delay)` 的 Promise 重载。自实现的核心只有 `setTimeout` + `ctx.effect` 两行，与宿主实现同构，且能按需 unref；「封装宿主原语」的原意（统一排期语义 + 卸载不泄漏）由本面满足，宿主面继续服务官方插件。将来宿主补齐 unref / handle 时，只需改 `timer/src/timers.ts` 一处。

**决策项 4（TUI 接入姿态）= b**

- a) 硬依赖：TUI `inject` 加 `clock`
- b) 懒读 + 回落：`ctx.get('clock')` 拿到则用，未挂载 / 未就绪则保留现有 `setInterval`
- c) 不接入

选定 b。理由：与 TUI 既有四个可选服务读取姿态一致；TUI 的 demo/mock 没有宿主 ctx 也要能跑；为一个 1 s 的界面刷新让整个 UI 包硬依赖定时包不划算。代价：接入是「尽力而为」（装载顺序晚于 Ticker 启动时回落 setInterval，行为仍正确）—— 这一点在 README 与「偏差」写明。

## 规划

任务拆分：

- 决策 ①②③④（形态 / 接口 / 与宿主关系 / TUI 姿态）。
- 建包 `timer`（`@dsh-toolset/timer`）与统一面：`timers.ts`（`createTimers` + `ManualClock`）、`main.ts`（服务 `clock` = `now` + `scope(ctx)`），单测覆盖假时钟、真实定时器、`ctx.effect` 卸载、provide 注册。
- 根接线：三处包清单 + `AGENTS.md` + 两版 `README`（计数与插件表 / 目录树）。
- 消费方逐个切换并单独核验：`background-daemon`（修条目 1 的崩溃面）→ `session-channel`（心跳）→ `metric-loop`（`now`）→ `TUI`（`StatusTicker` 懒读 + 回落）。
- 全量 `check` / `build` / `test` + `npm run demo -- --smoke`；人工确认后走提交点。

计划改动文件清单（形态已定稿为独立新包；清单外文件需用户裁定）：

- 新包：`timer/package.json`、`timer/package-lock.json`（`npm install` 生成，与其他包一致提交）、`timer/cordis.patch.yml`、`timer/tsconfig.json`、`timer/tests/tsconfig.json`、`timer/LICENSE`、`timer/README.md`、`timer/src/timers.ts`、`timer/src/main.ts`、`timer/tests/timers.test.ts`、`timer/tests/main.test.ts`
- 根接线：`package.json`（check / build 链）、`scripts/test-parallel.sh`（`default_pkgs`）、`scripts/install.sh`（`canonical_pkgs`，**置首**以先于消费方注册 `clock`）、`AGENTS.md`（插件计数 28 → 29、包计数 29 → 30、命令委托清单、插件子包清单与轻量包口径）、`README.md` / `README.zh.md`（计数、插件表、目录树、安装段包数）
- `background-daemon`：`src/main.ts`（改用 `clock.scope(ctx)` + 回落）、`src/scheduler.ts`（只校正 `TimerLike` 注释与导出注释）、`tests/apply.test.ts`（新增走 clock 的接线用例）
- `session-channel`：`src/index.ts`（心跳改 `timers.interval`、`stop()` 走 disposer、服务构造时惰性取 `clock`）、`tests/service.test.ts`（新增假 clock 心跳用例）
- `metric-loop`：`src/index.ts`（`now` 缺省改由 `clock` 提供）、`tests/controller.test.ts` 或既有控制器测试（新增 now 来源用例）
- `TUI`：`src/app/index.ts`（`AppDeps.status` 增 `schedule` 透传）、`src/main.ts`（`getTimers` 懒读接线 + 回落）、`tests/status.test.ts`（新增注入用例）
- 文档：`docs/BACKLOG.md`（条目状态 → 完成并在收尾移除；§2 实现顺序表行；途中发现的新条目）、本追踪文档

明确不做：

- 不包装 / 不替代宿主 `cordis-plugin-timer`（决策项 3 = b）；不改宿主代码、不读宿主 `ctx.timer`。
- 不做定时任务的持久化 / 补偿 / `cron`；不做 `sleep` / `debounce` / `throttle`（无消费方）。
- 不接入其余有裸定时器的包（`herdr-integration` / `herdr-pane` / `script-interpreter` / `rule-engine` / `preference-analysis` / `task-engine` / `auto-approve` / `ast-tools` / `command-template` 及 TUI 其它内部定时器）；途中发现即记入 `docs/BACKLOG.md` 候选。
- 不改 `docs/STATUS.md`（用户择时）、`docs/ARCHITECTURE-REUSE.md`（计数随条目 3 重审计一并刷）。

验收（细化后）：

- `timer` 包 `npm run check` / `npm test` 通过：`ManualClock` 的一次性 / 重复 / dispose / `advance` 内重排与顺序；`createTimers` 真实定时器触发、调用方 `ctx.effect` 卸载后不再触发、无 `ctx` 时 disposer 生效；`apply` 注册 `clock`、`now()` / `scope(ctx)` 形状、重复 provide 告警不抛。
- 四消费方各自 `check` / `test` 通过，且各有一条用例证明走统一面（注入假 clock，无真实等待）。
- 根 `npm run check` + `npm run build` + `npm test` 通过；`npm run demo -- --smoke` 通过（TUI 无宿主路径不回归）。
- 卸载无残留：timer 单测与 `background-daemon` / `session-channel` 用例断言 stop / 卸载后无排队回调。
- 真机（用户 profile）挂载验证留用户执行，结论记入「测试与证据」。

估时：1 至 1.5 天（建包 + 单测约 0.4 天，根接线 0.2 天，四消费方各 0.1 至 0.2 天，全量验证与文档 0.2 天）。

## 实现记录

全部按「规划」落地；关键命令与结果如下（时间窗 2026-10-19）。

- **建包**：`timer/` 全套（package.json / cordis.patch.yml / tsconfig / tests/tsconfig / LICENSE / README / .gitignore / src/timers.ts / src/main.ts / tests 两个）。计划外新增 `.gitignore`（`node_modules` / `dist`，与其他包一致；漏列进计划清单，补记）。`npm install`（工作区 npm cache：`--cache ../tmp/npm-cache`，因主机 `~/.npm/_cacache` 在沙箱下只读）→ 生成 `package-lock.json`。
- **timer 单测**：24 例（假时钟一次性 / 重复 / 撤销 / advance 内重排 / 0 间隔步数上限 / 参数校验；真实定时器触发与 disposer；`ctx.effect` 卸载清理；无 ctx 退化；服务注册形态与重复 provide 告警）。中途修了两处用例断言（`advance(15)` 的顺序按绝对到期时刻、`1_000+50` 的期望值笔误）。
- **根接线**：根 `package.json` 的 check/build 链、`scripts/test-parallel.sh` 的 default_pkgs、`scripts/install.sh` 的 canonical_pkgs 三处均把 `timer` 置首并加注释（clock 先于消费方激活）；`AGENTS.md` 计数 28→29 插件 / 29→30 包、委托清单、插件子包清单、轻量包口径各加 `timer`；`README.md` / `README.zh.md` 拆分包计数 + 插件表 + 目录树 + 安装段包数。
- **消费方切换**（各配一条走统一面的用例）：
  - `background-daemon`：`main.ts` 新增 `resolveTimers(ctx)`（读 `clock` → `scope(ctx)`，缺失回落 `systemTimer()`），调度器 `now` 改从统一面取；`scheduler.ts` 的 `TimerLike` 注释改为统一面结构子集；`tests/activation.test.ts` 的 `OPTIONAL_SERVICES` 由 `timer` 改为 `clock`；`tests/apply.test.ts` 新增「clock 服务可用时排期与读钟都走统一面」用例（137 例通过）。
  - `session-channel`：新增导出 `resolveTimers(host)` / `systemTimers()` / 结构类型；`#afterConnect` 心跳改 `#resolveTimers().interval(...)`，`stop()` 走 disposer；`tests/service.test.ts` 新增「心跳经统一面排期、stop 撤销」redisTest（63 例通过）。
  - `metric-loop`：新增 `ClockLike` / `makeClock(ctx)`，`apply` 里控制器 `now` 缺省改从 `clock` 取；`tests/controller.test.ts` 新增「clock 服务可用时读钟走统一面」（46 例通过）。
  - `TUI`：`AppDeps.status` 增 `schedule` 透传到 `StatusTicker`；`main.ts` 增 `getTimers` 懒读闭包（`clock.scope(ctx)`，未挂载回落 setInterval）；`tests/status.test.ts` 新增统一面参数序与回落两例（1635 例通过）。
- **全量验证**：`npm run check` 全 30 包通过；`npm run build` 通过；`npm test` 30 包全绿（timer 24 / TUI 1635 / session-channel 63 / background-daemon 137 / metric-loop 46 等）；`npm run demo -- --smoke` 出 `SMOKE_PASS` / `SMOKE_OK`，退出码 0。
- 环境说明：worktree 无 node_modules，消费方包用主工作区符号链接（`ln -s /home/guochang/Projects/dsh-toolset/<pkg>/node_modules`，gitignore 内），timer 包真实 `npm install`。

## 偏差

- 计划文件清单漏列 `timer/.gitignore`（`node_modules` / `dist` 等，与其他包一致）——实现时补建，已在「实现记录」补记；属包骨架应有文件，非遗漏的产物性改动。
- TUI 接入是「尽力而为」口径（决策项 4 = b）：装载顺序晚于 Ticker 启动时回落 `setInterval`，行为仍正确；这在决策与 README 已写明，属于既定口径而非未做。
- `session-channel` 心跳新用例用 `redisTest` 注册（需本机 `redis-server`，无则 skip）——与包内既有端到端用例同口径，非缺口。
- 提交点 2 已按用户裁定单独提交代码（commit `630e0f9`，不含测试用例与「测试与证据」）；测试用例在提交点 3 提交。
- 其余规划项全部落地；`scripts/test-install.sh` 全量未跑（需 30 次 npm install + 网络），改为抽取其内部一致性校验执行，结果见「测试与证据」。

## 测试与证据

命令 + 结果（2026-10-19，worktree `dsh/timer`）：

- `npm run check`：30 包全部通过（含 `timer` 的 `tsc -p tsconfig.json` + `tsc -p tests/tsconfig.json`），退出码 0。
- `npm run build`：30 包全部通过，退出码 0。
- `npm test`：30 包全绿 `fail 0`。关键包：`timer 24` / `TUI 1635` / `session-channel 63`（含新增 redisTest「心跳经统一面排期、stop 撤销」，本机 redis-server 7.0.15 实测通过）/ `background-daemon 137`（含新增「clock 服务可用时排期与读钟都走统一面」）/ `metric-loop 46`（含新增「clock 服务可用时读钟走统一面」）。
- `npm run demo -- --smoke`：`SMOKE_PASS`（preset-badge / jobs-panel / jobs-kill 等）与 `SMOKE_OK sent=[...]`，退出码 0 —— TUI 无宿主路径不回归。
- 清单一致性（`scripts/test-install.sh` 内部校验逻辑）：`canonical_pkgs == default_pkgs`；根 `check` 与 `build` 链同序；集合与 canonical 一致（30 项）。
- 卸载无残留：`timer` 单测断言 dispose / 调用方 `ctx.effect` 卸载后回调不再触发（`timers.test.ts`、`main.test.ts`）；`background-daemon` / `session-channel` 用例断言 stop / 卸载后无排队回调。
- 假时钟可测：三个消费方新用例均注入 fake clock，无真实等待；`ManualClock` 另有 13 例直接单测。

人工确认部分：smoke demo 已由本会话执行通过；真实 profile 挂载（`clock` 服务在 `dsh --profile fff` 下的装载顺序与 `background-daemon` 端到端）留用户执行（BACKLOG 条目「background-daemon 真机验证」覆盖）。

（待填：真机挂载结论由用户补充后再完成本节。）

## 收尾

（待写。）
