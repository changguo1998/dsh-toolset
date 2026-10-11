# 状态列 Agents 块开头符号加闪烁（接取条目：`TUI/docs/BACKLOG.md` 第 1 条）

状态：返工（用户真机澄清需求后重做）　　开启：2026-10-11　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

状态列 Agents 块在**有子代理运行**时, 块标题前导符号闪烁; 空闲/异常/非 TTY 时不闪或静态。

## 调研（现状，行号来自条目原文）

- 状态列 Agents 块 = 标题行 `Agents 运行中/总数`（蓝、**无前导符号**, `layout.ts:1320-1337`）+ 条目行 `● 别名 · 工作摘要`（`agentItemRows`, `layout.ts:1097-1112`：运行中 `● ` 黄 / 空闲 `○ ` 灰 / 异常 `! ` 红）。
- 现有时间驱动：`virt-tick`（250 ms, `index.ts:157,596`）与 `RunVirtState` 的渐进降频（`layout.ts:2269,2378`）。

## 接取裁定（①-⑥）

1. **闪哪一处**：**块标题前新增前导符号**（`● Agents 1/2`），不闪条目行的 `●`——条目行符号语义固定（运行/空闲/异常），动它会削弱状态信息；标题前导符号专职表达「有子代理在跑」。
1. **频率与占空比**：复用现有 **250 ms `virt-tick`** 相位，**50% 占空比**（相位偶数显示、奇数显示等宽空白）。不引入新的定时器，也不套用 `RunVirtState` 的渐进降频（那套表达的是「跑得久 → 变慢」，与「有没有在跑」无关）。
1. **谁闪**：**仅「有运行中子代理」时闪**；空闲不显示前导符号（标题回到现状形制）；异常（`diagnostic`）**常亮红** `!` 前缀，不闪——异常需要的是被看见，不是节奏。
1. **降级**：非 TTY、`NO_COLOR`、tick 未启动（如 demo / 一次性出帧的测试与嵌入用法）→ **静态显示** `●`（常亮）。缺省即静态，闪烁只在宿主明确提供相位时发生。
1. **tick 启动条件**：在现有 tick 的启动判据（`inputStatus=running`）之外**并上「有运行中子代理」**（`index.ts:594-600,932-940`）；tick 停的条件对称——两者都不成立才停。
1. **折叠层级（L1/L2）**：**保留闪烁**。折叠影响的是条目行与摘要，前导符号是块级指示，折起来更该看得见。

## 规划改动文件清单

- `TUI/src/app/layout.ts`：`statusBlocks` / agents 块标题行支持「前导符号 + 相位」；新增纯函数 `agentHeadSymbol(agents, phase)`（返回 `{ text, fg }`）便于单测。
- `TUI/src/app/index.ts`：tick 启动/停止判据并上「有运行中子代理」；把相位传给 `buildFrame`。
- `TUI/tests/`：帧断言（同 state 两相位 → 符号不同；空闲 → 无前导符号；异常 → 常亮 `!`；无相位 → 静态 `●`）；既有 Agents / 折叠用例不回归。

## 实现记录

### 落地（2026-10-11 第 21 轮，提交 `4d28ef4` + `8f7d2f4`）

| 改动 | 位置 |
| --- | --- |
| 新增导出纯函数 `agentHeadSymbol(agents, phase)`（异常 `!` 红 > 运行按相位 `● ` / 等宽空白 > 无） | `layout.ts`（`statusBlocks` 定义前） |
| `statusBlocks` 增 `phase: 0 \| 1 = 0` 参数 + Agents 标题行拼接前导符号 | `layout.ts` |
| `renderStatusColumn` 增 `runTokens = 0` 参数；体内改传 `runPhase(runTokens)` | `layout.ts` |
| 生产调用点补 `state.runVirt.tokens` | `layout.ts`（约 `:1416`） |
| `virtTick()` 的门并上「有运行中子代理」（相位驱动闪烁；相位未变不重绘的既有优化同时覆盖本符号） | `index.ts` |
| 单测 5 条（相位 0/1、空闲、异常、异常优先） | `tests/layout.test.ts` |
| 帧级断言 3 条（运行 `● Agents 1/1`、空闲无前导、异常 `! Agents 0/1`） | `tests/layout4.test.ts` |

**方法论记录（重要）**：第 18-20 轮连续三次用**启发式脚本**定位插入点（直接写 `state` / 括号深度扫描 / 唯一实参行+其后首个 `);`）全部插错、编译报错；
第 21 轮改为**先 `read` 出调用点原文、再按字面整段替换**，一次通过。结论：改嵌套调用点必须先读原文，不要脚本猜。

### 锚点核对（2026-10-11 第 17 轮：条目里的行号已漂移，以本节为准）

| 目标 | 真实位置 |
| --- | --- |
| 状态列块构建（标题行 + 条目行） | `layout.ts` 的 `statusBlocks(...)`（定义 `:901`，调用 `:1164`） |
| Agents 条目行 | `layout.ts:870 agentItemRows(a, width)`（调用点 `:1034 rows: agentItemRows(a, width)`） |
| Agents 块标题行 | 同 `:1034` 附近的块组装处（`Agents 运行中/总数` 文本，非原条目写的 `:1320-1337`） |
| 定时器 | `index.ts:826-828`：`this.virtTimer = setInterval(() => this.virtTick(), VIRT_TICK_MS)`（250 ms，始终存在） |
| **相位门**（要改的判据） | `index.ts:1167-1171 virtTick()`：「仅 `inputStatus=running` 时推进」 |
| 相位载体 | `RunVirtState`（`state.ts:595` 字段 `runVirt`；`emptyRunVirt()` 见 `:767`） |

### 相位来源（裁定 ②/④ 的落地口径）

**不再新增 state 字段**：直接把 `state.runVirt` 的累计 tick 当相位（`phaseOn = ticks % 2 === 0`）——

- 裁定 ④ 自动成立：tick 没推进（demo / 一次性出帧 / 非 TTY）时相位恒为 0 → 静态 `●`；
- 裁定 ② 的 50% 占空比随之成立（每 250 ms 交替）；
- 裁定 ⑤ 只需改 `virtTick()` 的门：`inputStatus === "running" || agents 有运行中` 才推进。

### 第 18 轮实测更正（重要）

`buildFrame` **不直接调用** `renderStatusColumn`：全仓只有一处调用，在 `layout.ts:1400`（三元表达式里，
位于 `buildFrame` 定义 `:2409` **之前**的另一函数内）。所以相位要**先透到 `:1400` 那个函数**（**已确认：有**——
该函数体内直接用 `state.jobs` / `state.statusColumnScroll` 构造状态列，故补 `state.runVirt.tokens` 即可），再传给 `renderStatusColumn` 的可选参数。
第 18 轮曾把相位直接写在 `renderStatusColumn` 体内的 `state.runVirt.tokens`（编译报 `state` 未定义）→ 已 `git checkout` 回退，仓库保持全绿。

### 第 19 轮：两处调用点的**精确原文**（下一轮按文本替换，别再写括号扫描）

1. `statusBlocks` 在 `renderStatusColumn` 体内的调用（**单行**，直接整行替换加 `runPhase(runTokens)`）：

```ts
  const blocks = statusBlocks(goals, todos, jobs, agents, w - 1, activation);
```

2. `renderStatusColumn` 的生产调用点（`layout.ts` 约 `:1400`，该函数体内有 `state`）——在最后一个实参后加 `state.runVirt.tokens`：

```ts
    : renderStatusColumn(
        goals,
        todos,
        state.jobs,
        state.statusColumnScroll,
        contentTopH,
        // 只传「状态列正文宽 + 末位竖线」：正文可见列 = statusColWidth − 外缘框格(1)
        // − 分隔竖线(1) = statusColWidth − 2（renderStatusColumn 末位自带竖线，剥去后
        // 与 statusBodyW 同宽）——传满宽会让拼行/折行多算一列，恰好拼满的行被截掉末字符
        statusColWidth - 1,
        // TUI#39：Agents 块数据（当前活跃会话切片；无数据时该块整块省略）
        state.activeSessionId
          ? state.agentsBySession[state.activeSessionId]
          : undefined,
        // goal 自动续轮开关（⟳；进程本地态，仅 active 相位有值）
        goalActivationDisplay(state, state.activeSessionId ?? undefined),
      );
```

1. `layout.ts`：Agents 块标题行支持前导符号——新增纯函数 `agentHeadSymbol(agents, phase)`（返回 `{ text: "● " | "  " | "! ", fg }`），`statusBlocks` 调用处传入相位；折叠层级不动它。
1. `index.ts`：`virtTick()` 的门并上「有运行中子代理」（agents 数据来自 `state.agents`，与状态列同源）。
1. 帧断言：同 state 两相位 → 标题前导符号不同；无运行中 → 无前导符号；异常 → 常亮 `!`；相位 0 → 静态 `●`。）

## 测试与证据

- 单测（返工前的口径，已随第一半删除）：标题前导符号 5 条 —— **已作废**。
- 帧断言（现行）：
  1. 〈Agents 块标题**不带**状态符号〉：`running` / `inactive` / `diagnostic` 三态都不得出现 `● Agents` / `! Agents` / `○ Agents`。
  1. 〈同 tick 下高 tps 与低 tps 的条目行符号必须不同〉（`tests/layout4.test.ts`）：`tokens = 4 × RUN_TOGGLE_TOKENS`
     时 `tps=10`（bucket 1）应为 `● `、`tps=0.5`（bucket 4）应为 `○ `。
- **反向验证（已做，有效）**：把 `agentBlinkBucket` 临时改成恒定档（`return 2`）后，
  上面第 2 条断言**失败** ✓ → 它确实钉住「按 tps 分档」，不是弱断言。
  （对比：本任务早前两条断言经反向验证后**仍通过**，已如实标注为弱断言。）
- 全量 `npm test` **1461 / 1461 通过**；`npm run check` 干净；`npm run build` 通过。
- **真机目视（待用户确认）**：有子代理运行时，状态列 Agents 块**每个条目行自己的** `●` / `○` 闪烁，
  快慢按各代理速率不同；`Agents` 标题前无符号。

## 审阅记录

（待补）

## 用户澄清（2026-10-11 真机观察后）：本实现选错了闪烁位置，需返工

用户原话要点：**「子代理状态符号闪烁错误。现在是代理条目本身没有闪烁，而是『Agents』前面多了符号在闪烁。想要的效果是：每个子代理的条目自己的状态符号闪烁（实心圆 / 空心圆切换），Agents 标题前不要有状态符号。每个子代理闪烁速度和该子代理的 tps 相关。」**

→ 接取时的裁定 ① 选错（我选了「块标题前新增前导符号」，用户要的是**条目行自己的符号**）；裁定 ③/⑥ 不变（仅运行中闪、异常常亮、折叠下保留）。

### 返工计划（下一轮照此做）

1. **撤掉标题前导符号**：`layout.ts` 的 `agentHeadSymbol` 与 `statusBlocks` 里标题行的拼接 → 删除（标题回到 `Agents n/m` 原形制）。
1. **条目行符号闪烁**：`agentItemRows(a, width)`（`layout.ts:870`）里运行中的 `● ` 按**该子代理自己的相位**在 `● ` / `○ ` 间切换（两态等宽 2 列，颜色保持「运行中」的黄，避免被误读成空闲）。
1. **相位与该子代理 tps 相关**：需要 `AgentRowInfo` 里的速率信息 —— 先查它有没有 tps/最近输出速率字段（若没有，用该子代理最近一次活动的时间戳做速率近似，或让适配层补字段）；相位 = 该 agent 的速率累积相位（速率高 → 切换快）。
1. 断言改造：现有 5 条单测 + 3 条帧断言全部按新口径重写（标题**无**前导 ✓、条目符号两相位不同 ✓、空闲 `○` 不闪 ✓、异常常亮 `!` ✓）。
1. `virtTick()` 的启动门（有运行中子代理即推进）保留 ✓。

## 收尾

- **实现**：`4d28ef4`（前导符号 + 相位接线 + tick 门 + 单测）、`8f7d2f4`（帧级断言）。
- **验证**：全量 `npm test` **1451 / 1451 通过**；`npm run check` 干净；`npm run build` 通过。
- **裁定落地对照**：① 块标题前导符号 ✓；② 复用 250ms `virt-tick` 相位、50% 占空比 ✓（两态等宽 2 列）；
  ③ 仅运行中闪、空闲不加、异常常亮红 `!` ✓；④ 非 TTY / 无相位（`runTokens` 缺省 0）静态 ✓；
  ⑤ tick 门并上「有运行中子代理」 ✓；⑥ 折叠层级不影响前导符号（块级） ✓。
- **待用户复核**：真机目视一次（有子代理运行时标题前导 `●` 每 250 ms 闪，空闲不闪，异常常亮 `!`）。
- **归档**：复核通过后本文件移入 `TUI/docs/archived/`，并从 `TUI/docs/BACKLOG.md` 移除该条。

## 返工第二半的收口状态（2026-10-11 第 46 轮）

**已落地**（`4dcbd10` / `6fde6f1` / `4b23879`）：

- 撤掉 `Agents` 标题前导符号与 `agentHeadSymbol`；帧用例改判「标题前不得有状态符号」（三态）。
- `agentItemRows(a, width, tick)`：运行中条目行在 `● `/`○ ` 间切换（两态等宽 2 列、颜色保持运行中的黄），
  空闲仍 `○ `、异常仍 `! ` 常亮。
- `agentBlinkBucket(tps)`：≥8 → 1、≥3 → 2、≥1 → 3、其余 4、缺省 2（tps 越高每 tick 翻转越快）。
- 节拍接线：`renderStatusColumn` → `statusBlocks` 第 8 参 `floor(runTokens / RUN_TOGGLE_TOKENS)`
  （虚拟 token 积分单调递增；App 的节拍门已含「有子代理在跑」）。
- 核对：`layout.ts:2172` 的 `runningSymbol` 用于**用户块**的运行中符号，与 Agents 标题无关。

**未落地（两项，下一轮照此做）**：

1. **`tps` 的生产者**（关键：没有它，全部条目走缺省档「每 2 档翻」，各代理快慢无差异）
   - 产地：`adapter/dsh.ts` 的 Agents 投影（`:3402` `agentRows`，数据来自 `svc.listDescendants` 与
     适配层自维护的 `lastToolBySession`）。
   - 做法：在适配层另维护一个按会话的速率窗口（与 `lastToolBySession` 同寿命、同更新点）：
     子代理会话的 `assistant/message` 与 `tool/result` 文本按 `length / 4` 折算 token，配事件 `time`
     做指数加权（秒窗口），得到 `tps`；投影时按 `id` 取值填入 `AgentRowInfo.tps`。
   - 约束：只在**子代理会话**上累计（主会话不计）；无样本时不填（走缺省档）。
1. **钉子帧断言**：同一 tick（如 `floor(runTokens / RUN_TOGGLE_TOKENS) = 4`）下，
   `tps = 10` 与 `tps = 0.5` 两条 Agents 行的符号**必须不同**（验证分档真的生效）。
   `RUN_TOGGLE_TOKENS` 未导出 → 断言里用 `runPhase` 反推或用可导出的常量。

**生产者的落点（第 47 轮勘察结论，照此改即可）**：

- 唯一咽喉：`adapter/dsh.ts:1887` 的 `onSessionEvent` —— 它先算 `sid`（**全会话**），`:1891-1896`
  已按会话记录 `tool/call`（`lastToolBySession`），`:1899` 才做「非活跃会话丢弃」。
  → 速率累计必须写在 `:1899` **之前**（与 `tool/call` 同处）；写在后面的话子代理事件已被滤掉。
- 事件带时间：`raw.time`（宿主事件顶层字段；日志实测 `{"type":"tool/result","seq":92,"time":…,"data":{…}}`）。
- 体量口径：`tool/call` 取 `raw.data.arguments` 的 `length`；`tool/result` 取 `toolResultDetail(raw.data)`
  的长度（`dsh.ts` 内已有该助手）；两者均按 `length / 4` 折算 token。
- 窗口：按 `sid` 维护 `{ acc, since, tps }`；相邻样本间隔 ≥ 1s 时结算瞬时速率（`acc / 间隔秒`），
  与旧值做 0.5 指数加权，然后重置 `acc` 与 `since`。
- 投影：`:3411` 附近的 `agentRows.map` 里按 `id` 取值填入 `AgentRowInfo.tps`（无样本不填 → 走缺省档）。
- 清理：与 `:3431` 的 `lastToolBySession` 同步删除已消失会话的窗口。
