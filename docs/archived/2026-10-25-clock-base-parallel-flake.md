# 定位 clock-base 测试在并行负载下的偶发失败（接取条目：`docs/BACKLOG.md`「定位 clock-base 测试在并行负载下的偶发失败」）

状态：已关闭　　开启：2026-10-25　　关闭：2026-10-25
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
调研轮只读代码与测试, 结论写在本文档; 实现轮按用户裁定只改 `clock-base/tests/timers.test.ts` 与本文件.

## 目标

复现并定位 `clock-base` 在根 `npm run test` 并行负载下偶发失败的用例，改用 `ManualClock` 或放宽时间窗消除抖动；不删断言、不用加大 sleep 掩盖。

## 调研

结论先行: 抖动用例已定位为 `clock-base/tests/timers.test.ts:182`「createTimers: interval 重复触发，disposer 后停」, 失败断言是同用例 `clock-base/tests/timers.test.ts:189` 的 `assert.ok(ticks >= 2)`, 报错信息为「interval 至少触发两次（实际 1）」. 根级并行 15 轮复现 2 轮（13%）, 空载单包连跑 10 轮全绿. 成因是墙钟窗口断言撞上事件循环被抢占 ≥ 45ms, 与包内逻辑无关.

### 1. 时间来源盘点（24 条用例）

| 用例（文件:行） | 断言的墙钟依赖 | 时间来源 | 抖动风险 |
| --- | --- | --- | --- |
| `clock-base/tests/timers.test.ts:182` interval 重复触发，disposer 后停 | `:189` 要求 `ticks >= 2`; `:193` 撤销后计数冻结 | 真实 `setInterval` + `sleep(55)`（`:188`） | 高（已复现, 唯一失败项） |
| `clock-base/tests/timers.test.ts:164` schedule 到点触发一次 | `:171` `fired === 1`; `:179` 撤销后仍 1 | 真实 `setTimeout` + `sleep(40)`（`:170`） | 低（10ms 早于 40ms 到期, 单轮扫描按到期序处理） |
| `clock-base/tests/timers.test.ts:196` 带 effect 的 ctx 撤销清理 | `:216`, `:217` 均为 0 | 真实定时器 + `sleep(45)`, 但撤销是同步的 | 低 |
| `clock-base/tests/timers.test.ts:220` 无 ctx / effect 形状不符 | `:232` `fired === 1` | 真实 `setTimeout` + `sleep(35)`（`:231`） | 低 |
| `clock-base/tests/main.test.ts:103` scope 的 effect 清理 | `:119` `fired === 0` | 真实定时器 + `sleep(45)`（`:118`）, 撤销同步 | 低 |
| `clock-base/tests/main.test.ts:122` 省略 ctx 仍可排期与撤销 | `:131` `fired === 0` | 同步撤销 + `sleep(30)`（`:130`） | 低 |
| `clock-base/tests/timers.test.ts:22` 至 `:158`（10 条 ManualClock）+ `:236`, `:241` 两条纯函数 | 无墙钟 | `ManualClock` / 常量 | 无 |

补充: `clock-base/tests/main.test.ts:56` 的 `schedule(0)` 立即撤销, 其余 5 条（`:51`, `:71`, `:78`, `:84`, `:92`）为纯同步, 不触碰时间; `clock-base/tests/timers.test.ts:140` 的步数上限用例在 `100_001` 次回调内跑完（实测 104ms）, 纯 CPU, 抢占只影响耗时不影响结果.

### 2. 失败机制

- 正常时序: `interval(10)` 在 55ms 内应触发 5 次（实测空载 `ticks = 5`）, 断言只要 2 次, 看似留了 4 倍余量.
- 抢占时序: 进程被连续抢占 `S` 毫秒后恢复, libuv 的 timers 阶段在一轮扫描里对同一重复定时器只触发一次, 并重排到 `S + 10`. 若 `S + 10 >= 55`, 55ms 的 `sleep` 与它同刻或更早到期, `await` 恢复时 `ticks = 1`, 断言失败.
- 门槛实测为 `S >= 45`（即 `55 - 10`）: 阻塞 40ms 仍得 2 次（通过）, 45ms 起稳定得 1 次. 也就是说, 一次 45ms 量级的 GC 停顿或调度抖动即可击穿, 余量并不存在.
- 放大器: 根 `scripts/test-parallel.sh:36` 按核数（本机 16）并发; `:41` 用 `parallel -j` 同时跑 34 个包, 单包经 `scripts/test-one.sh:11` 起 `npm run test`; `clock-base/package.json:10` 的 `node --test 'tests/*.test.ts'` 又让 2 个测试文件各起子进程并发. 失败窗口正是包启动后最热的 55ms.

### 3. 复现命令与输出

(a) 单包空载 10 轮, 全绿:

```sh
cd clock-base && for i in $(seq 1 10); do node --experimental-transform-types --test 'tests/*.test.ts' 2>&1 | grep -E '^ℹ (tests|pass|fail)' | tr '\n' ' '; echo; done
```

输出为 10 行 `ℹ tests 24 ℹ pass 24 ℹ fail 0`（`npm test` 同口径, 空载无失败）.

(b) 根级并行 15 轮, 2 轮失败（第 2 轮与第 9 轮, 合计 2/15 ≈ 13%）:

```sh
npm run test
```

失败轮摘要与日志节选:

```
FAIL clock-base           1717 ms
FAIL clock-base           1612 ms

✖ createTimers: interval 重复触发，disposer 后停 (61.575173ms)
ℹ tests 24
ℹ pass 23
ℹ fail 1
test at tests/timers.test.ts:182:1
AssertionError [ERR_ASSERTION]: interval 至少触发两次（实际 1）
    at TestContext.<anonymous> (.../clock-base/tests/timers.test.ts:189:10)
```

同轮其余 33 包全绿, 与 2026-10-25 登记的原始现象一致; 单测耗时 61.6ms 说明抢占发生在本用例开头.

(c) 机制实验（`node -e` 内联, 同步阻塞模拟抢占, 不落盘）:

```sh
node -e 'let ticks=0; const iv=setInterval(()=>{ticks+=1},10);
setTimeout(()=>{console.log("ticks=",ticks); clearInterval(iv)},55);
const end=Date.now()+Number(process.argv[1]); while(Date.now()<end){}' 45
```

阻塞 0 / 10 / 20 / 30 / 40 / 45 / 50 / 55 ms 依次得 `5 / 5 / 4 / 3 / 2 / 1 / 1 / 1`, 在 45ms 处翻转, 与 (b) 的实际值 1 吻合.

(d) 其余真实定时器用例抽查 2 条（`timers.test.ts:164` 的 schedule 用例, `timers.test.ts:196` 的 effect 清理用例）在同款 60ms 阻塞下仍通过: 前者 `fired = 1`, 后者 `fired = 0, ticks = 0`（到期序与同步撤销给了它们保护, 只有 `ticks >= 2` 这条依赖「两次到期之间事件循环还能转一轮」）. 另 3 条（`timers.test.ts:220`, `main.test.ts:103`, `:122`）按同一机制推理稳健, 未单独压测.

(e) 备选修法的可行性实测: 同一 `createTimers` 实现不改一行源码, 在 `node:test` 的 `mock.timers` 下 `interval(10)` 推进 35ms 得 `ticks = 3`, 撤销后再推进 100ms 仍为 3, `schedule(10)` 推进 40ms 得 `fired = 1`, effect 用例登记 2 个 disposer 且清理后 `0 / 0`. mock 句柄自带 `unref` 函数, `timers.ts:97`, `:113` 的 `handle.unref?.()` 不会抛.

### 4. 建议方向

1. 首选: `timers.test.ts:182` 改用 `t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })` + `tick()`, 断言一字不改. 理由: 实测直通, 墙钟依赖归零, 被测对象仍是 `createTimers` 的真实 `setTimeout` / `setInterval` 分支, 仓内已有先例（`TUI/tests/approval-panel.test.ts:336`, `TUI/tests/notify-bell.test.ts:158`）, 且不减少既有覆盖（现无任何 `unref` 断言）.
2. 次选: 保留真实调度, 断言改等待式——回调里 `ticks >= 2` 即 resolve, 另设 2s 兜底超时判失败. 能去掉「同刻到期」竞态, 但用例仍要真等一次 10ms 周期.
3. 不建议: 把 `ticks >= 2` 放宽到 `>= 1`, 加大 `sleep`, 在 `test-parallel.sh` 加重试. 三者只是抬高门槛或掩盖, 断言不再能区分「重复触发」与「只触发一次」.
4. 结构性: 降低 `TEST_JOBS` 或给 `clock-base` 单独串行化能降概率, 但与「34 包并行」的设计目标相反, 且不消除竞态.

### 5. 途中观察（不改, 仅记录）

- `ManualClock` 不能用来替换这条用例: `createTimers` 走全局 `setTimeout` / `setInterval`, 换成 `ManualClock` 等于换掉被测实现, 该文件后半段就失去覆盖对象.
- 同类「真实 `sleep` + 计数断言」在其他包也存在（`TUI/tests/*`, `memory-base/tests/*`, `auto-approve/tests/*` 等有 `await sleep(...)`）, 本次未逐条审查其断言形态; 按流程应另开条目, 不并入本任务.

## 决策

> 2026-10-25 用户裁定: 决策项 1 选 a (即上文的 1.2 写法), 决策项 2 选 a, 决策项 3 选 b; 语义前提选 4.1 (检查只判断该轮是否执行, 允许事后补判).

### 决策项 1: `timers.test.ts:182` 的修法 (选定 a)

- 改用 Node 测试框架自带的假定时器 (`t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })` + `tick()`), 断言不再依赖真实时间.
- 用例拆成两层含义, 写成两条:
  1. 机制: 推进 50 毫秒恰好触发 5 次; 撤销后再推进 30 毫秒次数不变.
  2. 跳过语义: 推进 5 个周期, 消费方用「上一轮未结束」标记模拟忙; 断言任务只启动 1 次, 其余 4 轮记为跳过.
- 理由: 原断言要求「每轮都执行」, 与 4.1 的语义冲突; 新写法验证的是接线正确与跳过语义, 与机器负载无关. 被测对象仍是 `createTimers` 的真实 `setTimeout` / `setInterval` 分支.

### 决策项 2: 其余 5 条真实定时器用例 (选定 a)

- 不动 (`timers.test.ts:164` / `:196` / `:220`, `main.test.ts:103` / `:122`).
- 理由: 它们只验证「单次触发」或「撤销后为 0」, 到期顺序早于等待时间或撤销发生在触发之前, 不依赖真实时间的累计次数.

### 决策项 3: 其他包同类写法 (选定 b)

- 本次一并排查 (范围扩大到全仓), 判据: 断言「一段时间内的触发次数」才属同类隐患; 「单次触发」与「撤销后为 0」不算.
- 排查结果写入本文件; 是否修改其他包的用例, 待排查结果出来后另行确认 (不在本次直接改).

### 决策项 4: 「准点检查」的语义 (选定 a)

- 检查只判断「这一轮该不该执行」, 允许事后补判; 边界补算 (用时间差算出错过几轮) 属使用方逻辑, 不在 `clock-base` 内实现, 也不需要额外计时线程或进程.
- 本次因此不改 `clock-base` 的产品逻辑.

## 规划

计划改动文件清单:

- `clock-base/tests/timers.test.ts`: 改写 `:182` 为假定时器机制用例, 新增一条跳过语义用例.
- 本追踪文档: 记录决策与全仓排查结果.

明确不做:

- 不改 `clock-base/src/` (定时器逻辑不动).
- 不改其余 5 条 `clock-base` 用例.
- 其他包的用例只排查、不在本次修改 (如需修改另行确认).
- 不删断言、不放大等待时间、不加测试重试.

## 实现记录

- `clock-base/tests/timers.test.ts:182` 原用例「interval 重复触发, disposer 后停」改写为两条:
  1. 「interval 每个周期触发一次, 撤销后停 (假定时器)」: `t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })` + `tick(50)`, 断言恰好 5 次; `dispose()` 后再 `tick(30)`, 断言仍为 5.
  2. 「忙时跳过——上一轮未结束时不再启动 (假定时器)」: 同样的假定时器, 用 `running` 标记模拟任务跨多个周期; `tick(50)` 后断言启动 1 次、跳过 4 轮.
- 其余 5 条真实定时器用例未动 (决策项 2 选 a).
- `clock-base/src/` 未动.
- 全仓同类写法排查 (决策项 3 选 b), 判据「断言一段时间内的触发次数」, 结果见下节.

### 全仓排查结果 (2026-10-25)

排查方式: `grep` 全仓 `--include=*.test.ts` 的 `await sleep(` / `await new Promise(... setTimeout ...)` 共 93 处, 逐一按「断言是否依赖一段时间内的累计次数」分类; 命中嫌疑的逐个读断言与实现.

| 位置 | 断言形态 | 判定 |
| --- | --- | --- |
| `clock-base/tests/timers.test.ts:182` (原) | 真实等待后 `ticks >= 2` | 同类隐患, 已改 |
| `TUI/tests/status.test.ts:113` | `tickCount >= 1` | 安全: `StatusTicker.start()` 先同步 `tick()` 一次 (`TUI/src/app/status.ts:62-64`) |
| `TUI/tests/status-column-agents.test.ts:293` | `refreshAgentsCalls > 0` 与关闭后相等 | 安全: 只要求「至少一次」, 且到期顺序在等待之前 |
| `TUI/tests/command-panel-agents-tools.test.ts:497` | `refreshAgentsCalls > openCalls` | 安全: 同上, 只要求比此前多一次 |
| `TUI/tests/completion.test.ts:472-496` | 去抖后查询次数与 abort 次数 | 安全: 等待时长远大于去抖窗口, 同一轮按到期时间先后处理 |
| `TUI/tests/adapter.dsh.test.ts:844` | 等待后断言「未发生自动裁定」 | 安全: 断的是否定结果, 与次数无关 |
| `herdr-integration/tests/main.test.ts:688-708` | 关闭补发后条数不变 / 初始一次 | 安全: 比较前后相等或初始一次 |
| `command-template/tests/template.test.ts:296` | 总预算超时 | 安全: 超时阈值远小于步骤耗时, 方向相反 |
| `rule-engine/tests/main.test.ts:108` | 自建假 `setInterval` | 安全: 不是真实定时器 |
| 其余 80 余处 | 单次事件 / 状态 / 顺序断言 | 安全: 不依赖累计次数 |

结论: 除已修的这一条外, 全仓没有同类隐患, 其他包不需要改动.

## 偏差

- 决策项 1 的写法比原计划多了「跳过语义」一条用例 (按用户选定的 1.2 执行, 原文只写机制用例), 属计划内扩充, 已回写「决策」节.

## 测试与证据

- `cd clock-base && npm run check` → 通过 (src + tests 两套 tsconfig).
- `cd clock-base && npm test` 连续 10 次 → 每次 `tests 25 / pass 25 / fail 0` (原 24 例, 新增 1 例, 改写 1 例).
- 根 `npm run test` → 无 `FAIL` 行, 34 个包全部通过.
- 未做: 真机验证 (本任务只改测试, 无运行时行为变化, 不需要重启会话验证); 人工确认 (待用户确认后再提交).

## 收尾

已关闭（2026-10-25）。提交：`97b655d`（测试改写 + 本文档的实现记录）。

- 回写：`docs/BACKLOG.md` 移除条目「定位 clock-base 测试在并行负载下的偶发失败」并记关闭注记。
- 归档：本文件移入 `docs/archived/2026-10-25-clock-base-parallel-flake.md`。
- 遗留：无。其他包的同类写法经全仓排查确认无隐患（见「全仓排查结果」）, 不另立条目。
- 未做：真机验证（本次只改测试, 无运行时行为变化, 不需要重启会话验证）。

## 待决策项

以下三项已于 2026-10-25 由用户裁定 (1 a / 2 a / 3 b), 另附语义前提 4 a; 结论已回填「决策」节, 本节保留作历史记录.

1. 决策项 1: `clock-base/tests/timers.test.ts:182` 的修法.
   - a) 改 `t.mock.timers`（选定, 依据见「建议方向」第 1 条与实测 (e)）.
   - b) 保留真实调度, 断言改等待式 + 兜底超时.
   - c) 拆两条: 语义用例走 mock timers, 另留一条真实定时器冒烟只断言「至少触发一次」.
   - d) 只放宽断言 / 加大 sleep（不推荐, 断言失去区分力）.
2. 决策项 2: `createTimers` 其余 5 条真实定时器用例（`timers.test.ts:164`, `:196`, `:220`, `main.test.ts:103`, `:122`）是否一并改.
   - a) 只改失败这一条, 其余不动（选定）.
   - b) 凡用到 `sleep` 的一并改 mock timers, 一次清干净.
   - c) 全不改, 只加兜底超时做保险.
   - d) 维持现状, 接受偶发.
3. 决策项 3: 其他包的同类「`sleep` + 计数断言」是否纳入.
   - a) 本任务只管 `clock-base`, 另开 BACKLOG 条目.
   - b) 本任务扩大范围一并排查（选定, 结论见「全仓排查结果」）.
   - c) 先不处理, 等下一次复现再说.
