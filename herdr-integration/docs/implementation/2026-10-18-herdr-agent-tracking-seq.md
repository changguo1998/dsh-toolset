# herdr 面板丢失代理归属：seq 闸门与周期补发（接取条目：herdr-integration/docs/BACKLOG.md「herdr 面板丢失代理归属（seq 闸门 + 无周期补发）」）

状态：决策　　开启：2026-10-18　　关闭：-

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

模型调用 `bash` 工具后，本 pane 的 agent 在 herdr 侧消失（`herdr pane get` 的 `agent_status=unknown`、`herdr agent list` 不含该 pane）。目标：让归属在以下两种情况下都能自愈，且不引入额外的状态语义：

1. 已有更高的 `seq` 被接受过（插件此后所有上报被静默忽略）；
2. 归属被 herdr 侧清掉（自重报代理的「shell 回归」兜底、server 重启 / handoff）。

## 调研

来源：herdr 0.9.5 官方源码（`src/terminal/state.rs`、`src/app/api/panes.rs`、`src/pane.rs`、`src/detect/mod.rs`、`src/platform/mod.rs`）、官方文档（socket-api / add-herdr-support / agents）、本机实测。

**1. `seq` 闸门是静默丢弃**

- `src/terminal/state.rs` `hook_report_is_newer(source, seq)`：仅当 `seq > 该 source 的上次接受值` 才应用；否则请求返回成功但状态不变。
- 官方文档 `socket-api.mdx` §Metadata 段同口径：「reports with a sequence number less than or equal to the last accepted sequence are accepted by the API but ignored by the pane state」。
- 本包 `src/herdr.ts` 的 `reportSeq` 在构造时取 `Date.now() * 1000`，之后每条 `+1`。因此：
  - 同一进程长时间运行后，`seq` 只涨「上报条数」，远低于墙钟量级；
  - 任何更晚启动的 dsh（另一个进程）或任何手工/脚本上报（带 `Date.now()*1000` 量级 `seq`）都会把闸门抬到该进程永远够不到的高度。

**2. 实测复现（隔离 pane）**

- 新建 workspace `wT0`，pane `wT0:p1` 内 `dsh --profile fff`：插件工作正常（`dsh working` → `done` → `idle`）。
- `$ echo hi`（TUI shell 模式）后仍为 `dsh idle`（不复现）。
- 发 prompt 让模型调用 `bash` 跑 `sleep 3`：`dsh idle` → `working` → `done`（不复现）。
- 预置 canary：`herdr pane report-agent wT0:p1 --source dsh --agent dsh --state blocked --message canary --seq <Date.now()*1000 + 5e8>`，再发 prompt 让模型跑 `bash: echo ok`（TUI 侧确已执行并回 `OK`）：45 秒内面板一直是 `dsh blocked`，插件的 `working` / `idle` 全部被吞 → **确认闸门方向与静默性**。
- 收尾：`herdr workspace close wT0`（临时 workspace 与 pane 已删除）。

**3. 归属被清掉的路径（源码核对）**

- `src/pane.rs` `report_self_reported_agent_shell_return`：herdr 无法按进程识别的上报方（`dsh` 不在其内置 agent 表内，`parse_agent_label("dsh") == None`）被当作「self-reported agent」，只能靠「pane 回到空闲 shell」判断它退出；命中 `detect::pane_shell_is_idle(child_pid)` 即发 `AppEvent::ReportedAgentShellReturned` → `TerminalState::clear_self_reported_agent` 清掉归属、名字与 resume 命令。
- 另有 `pane.release_agent`、`pane.clear_agent_authority`、进程退出推断、server 重启/handoff 等路径。
- 结论：清掉的动作在 herdr 侧无法拦截，也不通知上报方；上报方唯一能做的自愈手段是**定期重报**。

**4. 现状缺口**

- 本包只在 `publish` 检出「状态或 message 变化」时上报，`force` 只在启动用一次；一旦闸门被抬高或归属被清，`lastState` 仍在内存里，永不重发。
- 启动期 `readRoots()` 常为空（根 agent 尚未注册），因此首发 `report_agent` 不带 `agent_session_id`；`report_agent_session` 要等首个 `agent/status`。补发会顺带携带 `currentSessionRef`，无需单独修。

**5. 与本条目无关的外部配置偏差（仅记录，不改）**

profile `~/.dsh/profiles/fff/package.json` 的 `dsh.profile.bundles` 把 `@dsh-toolset/herdr-integration` 排在 `@dsh-toolset/tui` **之后**，与 `README.md`「加载顺序」要求相反；它影响 blocked 桥的观察者注册顺序，不影响本条目。属用户环境配置，按需由用户调整。

## 决策

1. `seq` 生成方式

   - a) 保持「进程启动墙钟 + 1」；
   - b) 每条上报取 `max(上一条 + 1, Date.now() * 1000)`（选定）；
   - c) 改用随机数 / UUID 排序。
     理由：b 与官方建议「a timestamp works well」一致，且保证任意时刻新上报的 `seq` 都高于此前接受过的墙钟量级值；同毫秒多条靠 `+1` 保序，不引入额外状态。c 丢掉了「后发先至」的排序语义。

2. 补发机制

   - a) 只在检测到丢失时补（需另开连接查 `pane.get`，多一条协议依赖）；
   - b) 固定周期重发当前推导状态（选定）；
   - c) 依赖 herdr 侧新增通知（当前版本没有）。
     理由：b 无额外协议依赖，最坏恢复延迟 = 一个周期；频率低时开销可忽略（一条两行 JSON）。

3. 周期与开关

   - a) 硬编码 20 秒；
   - b) 配置项 `refreshIntervalMs`，默认 20000，`0` 关闭（选定）。
     理由：与既有 `source` / `agent` / `attemptTimeoutMs` 三个可选配置同风格，便于真机排查时临时关掉。

4. 补发的 payload

   - a) 原样重发当前状态（选定）；
   - b) 重发时附带 `resume_argv`。
     理由：a 最小改动；`resume_argv` 需要新增「会话恢复命令」拼装，超出本条目范围，另开条目再说。

## 规划

改动范围（仅本包）：

- `src/herdr.ts`：`reportSeq` 改为逐条取下界；`nextSeq()` 内取 `Date.now()`。
- `src/main.ts`：新增配置项 `refreshIntervalMs`（默认 20000，`0` 关闭）；`publish` 之后按当前推导状态起周期补发；`dispose` 清理定时器；补发用 `unref()` 的定时器，避免拖住进程退出。
- `tests/herdr.test.ts`：`seq` 单调且不小于 `Date.now()*1000` 的用例（含同一毫秒内多条）。
- `tests/main.test.ts`：假定时器下补发按周期重发同一状态、`0` 关闭时不发、`dispose` 后不再发。
- `README.md`：更新「发送策略」与「配置」两处（新增 `refreshIntervalMs`；说明 `seq` 语义与自愈能力）。

明确不做：

- 不改 blocked 桥的注册顺序，不动 profile 配置（见调研 5）。
- 不发 `resume_argv`（决策 4b 留作后续条目）。
- 不改 herdr 侧行为，不做「检测丢失再补」的额外查询。

计划改动文件清单：

1. `herdr-integration/src/herdr.ts`
2. `herdr-integration/src/main.ts`
3. `herdr-integration/tests/herdr.test.ts`
4. `herdr-integration/tests/main.test.ts`
5. `herdr-integration/README.md`
6. `herdr-integration/docs/BACKLOG.md`（条目状态）
7. `herdr-integration/docs/implementation/2026-10-18-herdr-agent-tracking-seq.md`（本文件）

## 实现记录

- 2026-10-18：`src/herdr.ts` 的 `nextSeq()` 改为 `Math.max(this.reportSeq + 1, Date.now() * 1000)`；文件头协议注释补「seq 语义」段（说明静默忽略与墙钟下界的由来）。
- 2026-10-18：`src/main.ts` 的 `HerdrIntegrationConfig` 增 `refreshIntervalMs`（默认 20000，`0` 关闭）；启动期 `publish(true)` 之后起 `setInterval(() => publish(true), refreshIntervalMs)`，定时器 `unref()`；`dispose` 内 `clearInterval`。
- 2026-10-18：`tests/herdr.test.ts` 增两例——「seq 取墙钟下界」（进程已运行 40ms 后上报的 seq 必须 ≥ `(startedAt+20)*1000`，旧实现为 `startedAt*1000+1` 会失败）、「seq 不倒退」（把 `Date.now` 回拨 60 秒，seq 仍严格递增）。
- 2026-10-18：`tests/main.test.ts` 的 `startPlugin` 支持传 config，增四例——周期补发按当前状态原样重发、补发跟随状态变化、`refreshIntervalMs: 0` 关闭、`dispose` 后停止补发。
- 2026-10-18：`README.md` 更新「协议」「seq 闸门与自愈」「发送策略」三条与「配置」示例（四项）。

## 偏差

- 差一处：决策 1 的「同毫秒多条靠 +1 保序」在实现里由 `Math.max(last+1, now*1000)` 自然满足，未单独写用例（墙钟下界用例与不倒退用例已覆盖两种极端）。理由：同毫秒是 `Math.max` 的平凡分支，单独造时钟桩价值低。
- 未做：`resume_argv`（决策 4b，按计划留作后续条目）；blocked 桥注册顺序与 profile bundle 顺序未动（按计划）。

## 测试与证据

包内（`herdr-integration/`）：

```
npm run check   → tsc --noEmit 通过
npm run build   → tsc -p tsconfig.json 通过
npm test        → tests 49 / pass 49 / fail 0
```

仓库根（29 个包）：

```
npm run check   → 全部子包 tsc --noEmit 通过
npm run test    → 29 个包全 OK、0 fail（TUI pass 1628 / herdr-integration pass 49 / herdr-pane pass 109）
```

补发用例的抖动：首轮全量并行跑测时「周期补发」一例偶发失败（10ms 间隔 + 60ms 定长等待，负载下只跑到 1 次补发）。已改为按谓词轮询（`waitUntil`，上限 2 秒），包内连跑 3 轮与仓库全量跑测均 49/49 通过。

真机验证（herdr 0.9.5，dsh 0.2.0-rc.2，新构建的 dist）：

1. 新建临时 workspace，pane 内 `dsh --profile fff`：`dsh working` → `dsh done` → `dsh idle`（启动期上报正常）。
2. 预置 canary：`herdr pane report-agent <pane> --source dsh --agent dsh --state blocked --message canary --seq <(now+2s)*1000>` → 面板立刻变成 `dsh blocked`（闸门生效）。
3. 等待：12 秒后（canary 的未来 seq 被墙钟越过后的第一个补发周期）面板回到插件自己的状态 `dsh done` → **墙钟 seq + 周期补发确实能夺回归属**（旧实现下 canary 会永久压制）。
4. 收尾：`herdr workspace close <id>` 删除临时 workspace 与 pane，未留残留 pane（`herdr pane list` 只剩用户自有 pane）。

对照实验（旧实现，回归前记录在「调研」§2）：预置未来 seq 的 canary 后，TUI 侧真实跑完一轮 bash 工具调用并回了 `OK`，面板 45 秒仍停在 canary。

## 收尾

（待填）
