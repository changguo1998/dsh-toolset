# 字符宽度探测的触发时机（接取条目：TUI/docs/BACKLOG.md「检查字符宽度探测的触发时机（能生效但时机偏早）」）

状态：关闭　　开启：2026-10-16　　关闭：2026-10-16
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把「探测时机」核成明确口径并修掉「做早了」的根因：① 首帧不再被探测吞掉（先出帧）；② 启动阶段只发一轮探测（首帧登记批 ∪ 符号列表先验，单飞调度，并发不再可能）；③ 探测结果可疑即整批作废并重排队，错值不再静默写进覆盖表；④ 四处入口（按需 / 启动 / 尺寸变化 / `/detect-char-width`）统一到同一套「单飞 + 待测队列」调度；⑤ 同步 `SPEC.md` 的探测时机口径与 `DESIGN.md` 的历史注记。

## 调研

（来源：本工作区代码与测试实读、隔离跑单测与取证脚本实测）

### 1. 现状时序（四个入口）

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 按需（帧写屏前） | `src/app/index.ts:5766-5774`（`renderFrame`）→ `:898`（`probeThenRender`） | 本次排版登记的「呈现不确定」字符（`layout/markdown.ts:551` → `:481` 入队）取走后**本次不出帧**，实测完再整帧重绘；超时上限 `WIDTH_PROBE_TIMEOUT_MS = 150`（`:79`） |
| 启动预探测 | `src/app/index.ts:1060`（`start()` 内）→ `:979-985` | 首帧 `paintNow()`（`:1059`）之后，按符号列表整批实测，超时 `STARTUP_PROBE_TIMEOUT_MS = 1200`（`:81`） |
| 尺寸变化 | `:1007-1012`（`onResize`）→ `:962`（`reprobeWidths`） | 重置尝试额度后重测「已实测码点」 |
| 手动重测 | `:3612`（`/detect-char-width`）→ `:3816` 一带 | 已实测码点 ∪ 符号列表，走同一 `reprobeWidths` |

### 2. 「时机偏早」的复现与根因

**根因：启动瞬间两轮探测并发。** `paintNow()` 的首帧排版会把首屏出现的「呈现不确定」字符全部登记（框线 `─`、`—`、`•`、`·`、Nerd Font 图标等）；`renderFrame`（`:5766`）因队列非空而**先发一轮探测并吞掉首帧**（此时屏幕上还没有任何帧）。紧接着 `start()` 里的 `probeSymbolsAtStartup()`（`:979`）**只查 `widthProbeUnavailable`、不查 `widthProbeInFlight`**，于是再发一轮（符号列表批）。两轮同时在途。

**串台机制：** `Renderer.probeSymbolWidths` 的应答等待者挂在广播集合 `cprWaiters`（`src/renderer/index.ts:182-185`）上——每个 CPR 应答会送给**所有**等待者；两轮报文都从 `\x1b[1;1H` 起写、应答不带请求标识，只能按到达顺序配对（`:396-398` 的块间静默期只解决「同一次探测内跨块」错配）。后发起的探测只要收满 `chunk.length` 个应答即定值，而最先到达的那批应答属于先发起的探测 → **列差取自别人的首字符**。

**证据 1（隔离跑既有单测即暴露）：**

```
sh scripts/test.sh "启动按符号列表预探测" tests/width-probe.test.ts
✖ AssertionError: 启动即按列表预探测（首帧等探测完再出）
  actual:   [ [ '—', '•', '·', '󰦪', '󰓆', '󰂟', '─' ], [ '➡' ] ]
  expected: [ [ '➡' ] ]
```

（全量跑同一文件时，前序用例已把 `CHAR_WIDTH_TABLE` 宽度 memo 填上、首帧不再登记新字符，掩盖了这个并发；按测试名过滤后 memo 为空，双探测当场现形。）

**证据 2（取证脚本：两次探测并发 vs 单独探测）：**

```
并发：A = [ [ '✅', 2 ], [ '•', 1 ], [ '·', 1 ] ]  B = [ [ '➡', 2 ] ]
单独：B = [ [ '➡', 1 ] ]
```

即 ➡ 在并发场景下被记成 2 列（取自 A 的首字符），单独探测是 1 列。错值经 `setWidthOverrides`（`layout/markdown.ts:416`）写入覆盖表后**本会话不再重测**（只有漏测会重新入队，`index.ts:926-937`）→ 「做早了」的错值一直用。

### 3. 时序代价（可度量）

- 首帧被吞：首屏至多等 `WIDTH_PROBE_TIMEOUT_MS = 150` ms 才出第一帧（终端不支持 CPR 时必然吃满）。
- 启动批：`STARTUP_PROBE_TIMEOUT_MS = 1200` 按块分摊（`renderer/index.ts:359`：`budgetMs = max(30, floor(timeoutMs / chunks))`）+ 块间 `PROBE_SETTLE_MS = 20`（`:49`）；其间探测字符画在屏幕原点，由最后一次 `refresh()` 覆盖 → 首屏慢 + 原点闪烁。
- 两轮各自结束时都会 `refresh()`（`:938`）并再次取队列（`:939`），首屏阶段最多连出三帧。

### 4. 陈旧陈述 / 口径漂移（本次对齐）

| 位置 | 现状 | 实际 |
| --- | --- | --- |
| `docs/SPEC.md:823` | 「`App.probeSymbolsAtStartup` 按列表**首帧前**整批实测（有列表则该帧等探测完再出）」 | 实现是**首帧之后**（`index.ts:973-978` 注释即写「首帧之后」）；改后为「首帧先出、帧后一轮合并实测」 |
| `docs/DESIGN.md:464`（2026-09-27 历史注记） | 「不再走启动期符号集探测」 | 2026-10-12 起恢复为「首帧后按符号列表预探测」 |
| `README.md:357` | 「实测值落盘 `<profile 目录>/tui-width-table.json` 供后续会话复用」 | 宽度**不落盘**（只落符号列表 `tui-width-symbols.json`，每次会话重新实测）→ 超出本任务范围，按「途中发现新问题」追加 BACKLOG 新条目 |

### 5. 既有测试覆盖与缺口

- 已覆盖（`tests/width-probe.test.ts`，16 例）：CPR 解码不产按键 / 批量列差解析与分块 / 探测期隐藏与恢复光标 / 超时回退 / 跨行跳过 / 覆盖表失效 / 候选判定与登记 / 帧前实测时序 / 无 CPR 关闭 / `TUI_WIDTH_PROBE=0` / 符号列表预探测 / 尺寸变化与手动重测。
- 缺口：① 没有「启动只发一轮（合并批）」的断言，双探测被前序用例的宽度 memo 掩盖；② 没有「整块作废」与「有应答但作废 ≠ 终端不支持」的断言；③ 没有「首帧先出」的断言。

## 决策

四项均经用户裁定（2026-10-16）：

1. **取证方式**：以代码级复现为准（隔离单测 + 取证脚本），真机目视留到合并后自查；验收 ① 的替代证据即上面的两份实测记录。
2. **时机改向**：**单飞 + 首帧先出、帧后合并一轮**——首帧只出帧不探测（屏幕先有内容），首帧之后把「首帧登记批 + 符号列表批」合并成一轮实测再整帧重绘。首帧之外的按需探测仍保持「帧写屏前实测、该帧由实测后的整帧重绘产出」（用户 2026-10-01 裁定不变）。
3. **答错路径**：加**批次自校验**——应答数不足 / 行号偏离基线行（1）/ 列倒退 → **整块作废**（不写宽度、不写覆盖表）并重新入队；单字符列差异常（落在 `{1,2}` 之外但非倒退）仍按「丢掉该字符」处理，避免一个宽字符废掉整块。只有「零应答」才判终端不支持 CPR。
4. **调度**：四处入口统一到「单飞 + 待测队列」——`probePendingWidths()` 是唯一发起口（在途 / 终端不支持 / 启动首帧 → 不动）；尺寸变化与 `/detect-char-width` 沿用 `reprobeWidths` 入队后调它。

### 确认后的口径（本次要写进文档的一句话）

> 字符宽度探测：**首帧先出、帧后实测**；待测字符统一入队，由单一发起口**单飞**整批实测（启动轮 = 首帧登记批 ∪ 符号列表先验）；应答数不足 / 行号偏离基线 / 列倒退的**整块作废并重排队**，只有零应答才判终端不支持；实测值进内存覆盖表，宽度不落盘。

## 规划

### 任务拆分

1. App 侧调度收口：新增 `probePendingWidths(timeoutMs)`（唯一发起口，返回是否已发起）、`probingSuspended` 首帧闸门；收起 `maybeProbePendingWidths`；`renderFrame` 改为按返回值跳过本帧写屏。
2. 启动时序：`start()` 里首帧前置闸门、后置合并探测；`probeSymbolsAtStartup()` 把符号列表并入队列后走同一发起口（含在途守卫）。
3. Renderer 侧逐块校验：`probeSymbolWidths` 每块产出「应答数 / 行号 / 列序」判定，命中可疑条件即整块作废；`ProbeReject` 增 `reason` 字段（`short` / `row` / `back`），`TUI_WIDTH_DUMP` 诊断行带上它。
4. App 侧「作废 ≠ 不支持」：`widths.size === 0 && rejects.length === 0` 才置 `widthProbeUnavailable`；有应答但整批作废时重排队（受每码点 3 次上限约束）。
5. 测试：新增 4 例（首帧先出 / 启动单轮合并批 / 整块作废重排队且不判不支持 / 零应答才判不支持），调整既有断言（分块用例的查询计数、rejects 用例的字段）。
6. 文档：`SPEC.md` §15.7 探测时机口径；`DESIGN.md:464` 历史注记补正；BACKLOG 标进行中 + 追加 README 旧口径新条目。

### 计划改动文件清单

| 文件 | 改动 |
| --- | --- |
| `TUI/docs/BACKLOG.md` | `#3` 标〔进行中: 2026-10-16〕；追加新条目「同步 README.md 的字符宽度落盘旧口径」；排序注记追加本次接取与四项裁定 |
| `TUI/docs/implementation/2026-10-16-width-probe-timing.md` | 本追踪文档（唯一过程记录） |
| `TUI/src/app/index.ts` | `probePendingWidths` 单一发起口 + `probingSuspended` 首帧闸门；`probeSymbolsAtStartup` 合并符号列表；作废批重排队与「不可用」判定 |
| `TUI/src/renderer/index.ts` | `probeSymbolWidths` 逐块校验与整块作废；`ProbeReject.reason` |
| `TUI/tests/width-probe.test.ts` | 新增 4 例；既有断言按新口径调整 |
| `TUI/docs/SPEC.md` | §15.7 探测时机口径（首帧之后 → 首帧先出、帧后单飞合并实测、整块作废规则） |
| `TUI/docs/DESIGN.md` | `:464` 历史注记的口径补正（一句） |

### 明确不做

- 不改首帧之外「帧写屏前实测」的总口径（用户 2026-10-01 裁定）；不改静态表 / EAW 判定；不改符号列表落盘格式与「宽度不落盘」口径。
- 不改尺寸变化与 `/detect-char-width` 的行为语义（只改为走统一发起口）。
- 不做「同一码点两次探测一致才生效」（裁定 ③ 选的是作废重排队）。
- 不移除 `TUI_WIDTH_PROBE=0` / `TUI_WIDTH_DUMP` 两个排查开关。
- 不改 `README.md:357`（追加 BACKLOG 新条目交其他 agent）；不动 `tui.config.json` 与宿主侧接线。

## 实现记录

### 1. `src/app/index.ts`（单飞调度 + 首帧先出 + 作废处理）

- 新增字段 `probingSuspended`（`:393`）：首帧闸门；`widthProbeUnavailable` 注释改为「**零应答**才置位」。
- `probePendingWidths(timeoutMs = WIDTH_PROBE_TIMEOUT_MS): boolean`（`:984`）：**唯一发起口**——在途 / 终端不支持 / 首帧闸门 / renderer 无该能力 → `false`；取走待测队列（`takePendingWidthProbes`）非空则走 `probeThenRender` 并返回 `true`。原 `maybeProbePendingWidths`（无返回值）被它取代。
- `renderFrame`（`:5816`）：改为 `if (this.probePendingWidths()) return;`（本帧由实测后的整帧重绘产出）。
- `start()`（`:1104`）：`paintNow()` 外包 `probingSuspended = true` / `finally` 复位 → **首帧只出帧**；随后 `probeSymbolsAtStartup()`。
- `probeSymbolsAtStartup()`（`:1019`）：加在途守卫；先把符号列表并入待测队列（`requeueUnmeasuredProbes(this.widthSymbols)`，与首帧登记批同一 `Set` 保序去重），再经同一发起口发**一轮**（超时仍为 `STARTUP_PROBE_TIMEOUT_MS`）。
- `probeThenRender`（`:924`）：新增 `voids: ProbeVoid[]` 并透传给 renderer；完成分支改为「`answered = widths.size > 0 || rejects.length > 0 || voids.length > 0`」——`!answered` 才置 `widthProbeUnavailable`；`answered` 即重排队未测得码点（含整块作废的整批、列差被拒的单字符）；notice 文案的「未测到」改为 `batch.length - widths.size`（不再只数 rejects）。
- `dumpProbeResults(widths, rejects, voids)`（`:871`）：新增 `VOID reason=… responded=n/m chars=U+…` 诊断行；`REJECT` 注释同步（不再说「本会话不再重测」）。
- `reprobeWidths`（`:1001`）：改调 `probePendingWidths()`（尺寸变化与 `/detect-char-width` 仍共用）。

### 2. `src/renderer/index.ts`（逐块自校验）

- 新增 `ProbeVoid` 类型与 `chunkVoidReason(responses, expected)`：应答数 ≠ 请求数 → `short`；任一应答行 ≠ `PROBE_BASELINE_ROW`（1）→ `row`；列**严格递减** → `back`。命中即整块作废（不写宽度），并 `voids.push({reason, chars, responded, expected})`。
- `probeSymbolWidths(chars, timeoutMs?, rejects?, voids?)`：报文起点改用常量 `\x1b[${PROBE_BASELINE_ROW};1H`；解析分支只在整块通过校验后执行（列差 = `col - prevCol`，仅接受 1 / 2）；块间静默期注释补「真漏进来的迟到应答会让该块判 `short` 而整块重试，不再错配」。
- `Renderer` 接口的该方法签名加第 4 个可选参数（注入型 renderer 不实现仍可用；测试 fake 忽略它也不报错）。

### 3. `tests/width-probe.test.ts`

- 渲染层：`终端不响应时超时返回已收集结果` → 改为 `应答数不足 → 整块作废`（断言 `voids = [["short", 1, 2]]` 且零宽度）；`跨行…跳过` → 改为 `行号偏离基线 / 列倒退 → 整块作废`（两段：`row` / `back`）；`被丢弃的列差进 rejects` → 改为 `列差异常（delta 0 / 3）只丢该字符，不废整块`（含「异常字符之后的正常字符照常记录」）。
- App 层：旧的「帧绘制前实测——本帧不出」拆成 `首帧先出，启动轮把首帧登记批与符号列表合并成一轮实测`（新增 `events` 时序断言 `["render","probe"]`）与 `首帧之后的按需实测仍在写屏前`（相对计数）；新增 `整块作废 → 重排队重试，不判「终端不支持」`（作废 → 重试 → 部分测得 → 再重试 → 测得后停；末段验证「仍可测」）；`整批无回包` 用例改名为「零应答 = 终端不支持 CPR」并补 `clearLayoutCaches()`；启动预探测用例改断「只发一轮 + 批内含 ➡」。
- `ProbeRenderer` fake：记录 `events` / `pending`（含 `chars` 与 `voids` 引用），`resolveProbe(widths, voidReason?)` 可模拟整块作废。

### 4. 文档

- `docs/SPEC.md` §15.7「按需实测」条：补单飞入口、整块自校验与作废规则、首帧例外、「零应答」措辞；「符号列表落盘 + 启动预探测」条：`首帧前整批实测` → `首帧先出（不等探测）→ 帧后合并一轮实测`。
- `docs/DESIGN.md`：`:355` 命令表的函数名与「整批无回包」措辞对齐；`:464` 历史注记补「后续修正」一句。
- `docs/BACKLOG.md`：`#3` 标〔进行中: 2026-10-16〕；追加 `#8`（README 旧口径）；排序注记追加本次接取与四项裁定。

## 偏差

1. **整块作废的诊断用独立类型**（计划里写的是「`ProbeReject` 增 `reason`」）：改为新增 `ProbeVoid` + `probeSymbolWidths` 的第 4 个可选参数。理由：逐字符列差异常与整块作废是两类事件，混进一条记录会让 `responded` / `expected` 这类字段对单字符无意义；`ProbeReject` 的既有断言与 dump 格式也不受影响。
2. **「列倒退」收窄为严格递减**：列差 0（该字符在终端上零宽，如变体选择符）仍按单字符丢弃，不判整块作废——否则一个零宽字符会废掉同块其余字符的测量。
3. **首帧闸门用标志位而非改 `renderFrame` 时序**：`start()` 内 `try/finally` 置位 `probingSuspended`，首帧之外的分支逻辑与 2026-10-01 口径完全不变；启动批合并复用 `requeueUnmeasuredProbes`（不新造合并函数）。
4. **测试取舍**：旧 App 用例「首帧排版后、写屏前发起实测 / 本帧不出」与「启动即按列表预探测（首帧等探测完再出）」的语义已被裁定 ② 取代，按新口径重写；其中「本轮只测到 ─、其余重排队」的断言并入整块作废用例（同一条重排队路径）。净增 2 例（1609 → 1611）。原先靠测试顺序掩盖并发的 `宽度 memo` 依赖，改为在各 App 用例显式 `clearLayoutCaches()`。
5. **范围微扩（同文档口径）**：`DESIGN.md:355` 的 `maybeProbePendingWidths` 函数名与「整批无回包」措辞随实现同步（该行本就在「同步口径」范围内）；未动 `README.md:357`（另开 `#8`）。

## 测试与证据

### 机械验证

```
TUI $ npm run check     # tsc --noEmit → 退出码 0（无输出）
TUI $ npm run build     # tsc -p tsconfig.json → 退出码 0
TUI $ npm test          # ℹ tests 1611 / ℹ pass 1611 / ℹ fail 0（改动前 1609）
TUI $ npm run demo -- --smoke   # 退出码 0；SMOKE_PASS 42 / SMOKE_FAIL 0 / SMOKE_OK sent=[…] interrupts=1
```

### 复现对比（验收 ①：用隔离跑既有用例复现「启动并发两轮探测」）

改动前（`worktree` 原状）：

```
$ sh scripts/test.sh "启动按符号列表预探测" tests/width-probe.test.ts
✖ App：启动按符号列表预探测（宽度只存内存，不读旧宽度表）
  AssertionError: 启动即按列表预探测（首帧等探测完再出）
  actual:   [ [ '—', '•', '·', '󰦪', '󰓆', '󰂟', '─' ], [ '➡' ] ]
  expected: [ [ '➡' ] ]
```

改动后（同一条命令）：

```
ℹ pass 1 / ℹ fail 0
```

（同一文件全量跑时，前序用例填了 `CHAR_WIDTH_TABLE` 宽度 memo、首帧不再登记字符，掩盖了这个并发——这正是它只在真机暴露的原因。）

### 取证脚本（启动双探测的应答串台：不改动前的直接证据）

```
并发：A = [ [ '✅', 2 ], [ '•', 1 ], [ '·', 1 ] ]  B = [ [ '➡', 2 ] ]
单独：B = [ [ '➡', 1 ] ]
```

即 ➡ 在「两轮并发」下被记成 2 列（取自另一轮首字符的列差），单独探测为 1 列——错值会进覆盖表并整会话不再重测。

### 验收 ②「首屏不再因探测卡帧」（真实 renderer + CPR 无人应答的最坏情况）

```
start() 返回 7ms；首帧首次写屏 6ms（先于探测 = true，首帧字节 3337）
首个探测报文 6ms（零应答时探测超时收摊，不阻塞首帧）
```

改动前同一路径的首帧被探测吞掉（旧断言 `renders === 0`，屏幕要空等至多 `WIDTH_PROBE_TIMEOUT_MS`）；改后首帧字节（3337）先写出，探测报文在其后，且启动只发一轮合并批。

### 真机核对（未做，按裁定 ①）

`~/.dsh/profiles/fff/node_modules/@dsh-toolset/tui` 指向**主检出**，本 worktree 改动须经合并才作用于真机；真机目视（含 `TUI_WIDTH_DUMP` 抓启动批）留待合并后自查。替代证据为上两节的隔离复现与首帧实测。

## 收尾

- BACKLOG：`#3`「检查字符宽度探测的触发时机（能生效但时机偏早）」已从待办清单移除，排序注记追加关闭记录；`#8`（README 旧口径）按「途中发现新问题」规则保留在清单，交其他 agent。
- 追踪文档：本文件移入 `TUI/docs/archived/`。
- 相关文档：`SPEC.md` §15.7、`DESIGN.md:355` / `:464` 已随本任务同步（见「实现记录 4」）；`STATUS.md` 由用户择时更新，本任务不改。
- 真机目视：留待合并后在 `dsh --profile fff` 自查（含 `TUI_WIDTH_DUMP` 抓启动批的前后对比）——本 worktree 不具备条件（profile symlink 指向主检出）。
- 残留：无。相关提交止于本次关闭提交；过程中发现的新问题已登记为 `#8`。
