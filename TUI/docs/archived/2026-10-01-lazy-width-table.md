# 字符宽度表：运行时按需实测 + 落盘到 profile（接取条目：`TUI/docs/BACKLOG.md`「字符宽度表：运行时按需实测 + 落盘到 profile」）

状态：已完成　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把「启动时对固定 35 个符号测一次、只存内存」升级为：**只对可能判错的字符按需实测**，实测结果落盘到 profile 目录复用；实测发生在**该帧写屏前**，这一帧即按实测宽度排版。

用户裁定（2026-10-01）：

1. 表放 profile 文件夹（`~/.dsh/profiles/fff`）。
1. 探测时机＝「帧绘制前计算宽度时」。
1. 只记录可能判断出错的字符。

## 计划改动文件清单

代码：

- `TUI/scripts/gen-width-table.mts`：新增第四张区间表（不确定区）。
- `TUI/src/app/layout/eaw-table.ts`：生成物，含新表 `WIDTH_UNCERTAIN_RANGES`。
- `TUI/src/app/layout/width-table.ts`（新增）：不确定判定 + 待测登记/取走 + 落盘读写（纯 IO，不依赖 layout）。
- `TUI/src/app/layout/markdown.ts`：`charWidth` 命中「不确定且未测过」时登记待测字符。
- `TUI/src/renderer/index.ts`：`probeSymbolWidths` 按终端宽度分块（避免自动换行导致整块结果作废）。
- `TUI/src/app/index.ts`：启动读表 → 覆盖表；帧前探测 → 按实测宽度出该帧（整帧重绘覆盖探测残留）；结果落盘。
- `TUI/src/main.ts`：从 `ctx.get('profileContext')` 取 profile 目录并注入 App。

测试：

- `TUI/tests/width-table.test.ts`（新增）：不确定判定抽样、表读写、终端标识不匹配作废、非法值过滤。
- `TUI/tests/width-probe.test.ts`：补分块探测用例；保持既有 CPR 解析 / 超时 / 覆盖表用例。

文档：

- `TUI/docs/SPEC.md` §15.7（字符宽度）：改为「静态表 + 运行时按需实测 + profile 落盘」口径。
- `TUI/docs/BACKLOG.md`：条目状态维护（接取时标「进行中」，收尾时清理）。
- 本文件。

## 设计

### 1. 「可能判错」的判据

静态表只在两类字符上可能偏离终端实际：

- **EAW = A（歧义）**：同一码点在不同终端/字体下是 1 或 2 列（`→ × ± •` 以及 CJK 语境下的框线、希腊字母等）。
- **带 emoji 属性且 ≥ U+2190**：终端可能按 emoji 呈现（2 列）也可能按文本呈现（1 列）（`➡ ➠ ➢ ➣ ⬅ ⚠ ✓` 等）。

判据取并集，并在生成器里减去 EAW ∈ {W,F}（无歧义宽）与零宽区：`WIDTH_UNCERTAIN_RANGES`。
ASCII/CJK/全角标点等落在表外 → 既不探测也不记账。

### 2. 表与落盘

- 内存：沿用 `markdown.ts` 的 `WIDTH_OVERRIDES`（码点 → 列数，优先于全部静态判定）。

- 磁盘：`<profile 目录>/tui-width-table.json`：

  ```json
  { "version": 1, "term": "TERM|TERM_PROGRAM|COLORTERM", "widths": { "2022": 1, "27a1": 1 } }
  ```

  读取时 `term` 不匹配 → 整表作废（换终端/字体后旧值不可信）；写盘失败静默（排版不受影响）。

- 终端标识：`TERM|TERM_PROGRAM|COLORTERM` 拼接，仅作相等性比较用，不参与文件名。

### 3. 帧前探测时序

1. 排版（`buildFrame` → `charWidth`）过程中，命中「不确定且不在表内」的码点 → 登记进待测集（上限 64，去重）。
1. `renderFrame()` 先取待测集：**非空且探测可用** → 先发探测（写探测字节到左上角 → 等 CPR 回包，超时上限 150ms）→ 实测值写入覆盖表 → 重新排版 → **整帧重绘**（`renderer.refresh`，覆盖探测字符残留）。
1. 待测集为空 → 走原路径（增量 diff 渲染）。
1. 整批无回包（终端不支持 CPR）→ 关闭探测开关，后续不再发起（避免每个新字符都卡一次超时）；已成功的批次不关闭。

`TUI_WIDTH_PROBE=0` → 启动探测与按需探测一起关闭。

## 验证

- `npm run check`（TUI 单包 + 仓库根全包）：通过。
- `npm run build`（TUI）：通过（dist/ 已更新，profile `fff` 走 `link:` 实时可见）。
- `npm run test`（TUI 全量）：1262 例通过（本次新增 12 例，原 1250 例无回归）。
- `npm run demo -- --smoke`：SMOKE_OK（帧构建/渲染链路未受影响）。
- 真机确认（2026-10-01，用户）：字符宽度测量正常——含 `➡` / `⬅` 的行不再错位（原「未获确认前不提交」的门禁已解除）。

### 真机验证清单（请人工核对）

1. `npm run build` 后重启 `dsh --profile fff`。
1. 让屏幕上出现 `➡` / `⬅`（静态判 2 列、多数终端实为 1 列）所在的行 → 该行不再多占 1 列、右侧框线不错位。
1. 看 `~/.dsh/profiles/fff/tui-width-table.json` 是否生成（内容形如 `{"version":1,"term":"...","widths":{"2500":1,"27a1":1,...}}`）。
1. 退出后再启动：表已存在 → 同一批字符不再触发探测（对比：删掉该文件后首次启动会重新写出）。
1. 可选：`TUI_WIDTH_PROBE=0 dsh --profile fff` → 不生成/不载入表，行为回到静态表基线。

## 过程记录

- 判据从「EAW=A ∪ emoji ≥ U+2190」起步，抽样发现 `➠➢➣`(U+27A0/27A2/27A3) 与 `✓`(U+2713)
  是 EAW=N 且无 emoji 属性（用户点名的字符里正好有它们）→ 补「符号块 `0x2600-0x27BF` /
  `0x2B00-0x2BFF`」进不确定区，重生成表（不确定区 268 → 241 对区间）。
- 原「启动探测固定 35 符号」（`WIDTH_PROBE_SYMBOLS` + `App.probeWidths`）整体移除：
  按需实测已覆盖同一批字符（它们都在不确定区内），且首帧同样按实测宽度出帧，
  省掉每次启动的固定往返与「未上屏也测」的浪费。
- 探测残留的处理：探测字节写在屏幕原点 → 结果到达后**整帧重绘**（`App.refresh()`）
  覆盖，而不是走增量 diff（增量会因帧内容未变而跳过探测所在行，残留留着）。
- 分块探测按终端宽度切分（`perChunk = (cols-1)/2`）：旧实现一次性写完全部字符，
  窄终端上会自动换行、跨行字符的列差作废。
- 终端不支持 CPR 的保护：整批无回包 → `widthProbeUnavailable`，本次会话不再实测
  （否则每个新字符都要白等一次 150ms 超时）。
- 首帧代价：出现新字符的那一帧延后一次探测往返（超时上限 150ms）；已实测/已在表内的
  字符不再触发，故只有「首次遇到」的一帧受影响。
- 真机取证（2026-10-01）：`~/.dsh/profiles/fff/tui-width-table.json`（0600）生成，27 条实测值——
  静态表判 2 列的 `27a1`(➡) / `2b05`(⬅) 实测均为 1 列；PUA / Nerd-Font 图标（`f09aa` / `eda6` 等）
  因 PUA 属 EAW=A 一并登记。
- 已知限制：`terminalKey` 在当前 dsh 进程内为 `xterm-256color||`（`TERM_PROGRAM` / `COLORTERM`
  为空），故同 `TERM` 的不同终端（herdr / tmux）共用一张表；字体差异造成的偏差需删表重测。
