# 问答面板上下移动选中时首项上方被复制出一行（接取条目：`TUI/docs/BACKLOG.md`「问答面板上下移动选中时首项上方被复制出一行（排版残留）」）

状态：进行中　　开启：2026-09-30
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

定位并修掉真机现象：退出确认面板用上下键移动选中项时，第一个选项上方被复制出一行、排版错位。

## 调研（复现尝试）

自建复现台（临时脚本 `tmp/repro*.ts`，跑完删除）：`App` + 真 `createRenderer({ write: ScreenEmu.feed })`
（`TUI/tests/helpers/screenEmu.ts` 终端模拟器）+ `FakeAdapter`，逐帧断言「屏幕上实际字形 == 当前帧行」。

已覆盖组合（均 **0 屏差、帧内无重复行**）：

- 尺寸：80x24 / 80x18 / 80x16 / 80x14 / 120x40 / 200x50；宽度 34 / 40 / 46 / 50 / 60 各档。
- 选择移动：打开面板后上/下各若干次（含移动到第 4 项「自定义回答」并回退）。
- 并发场景：先灌活动区流式内容，再在 `frameIntervalMs: 100`（生产 10Hz 合帧）下「流式事件 + 选择移动」交替。
- 检查项：屏帧逐行比对、帧内相邻重复行、行显示宽度是否超终端宽度。

结论：现有模拟台无法复现 —— 说明触发条件在模拟台之外，待补事实（见下）。

## 用户补充的事实（2026-09-30）

1. 重复出来的行 = 「1. 取消」这类**选项文字**。
1. 触发时机：面板刚打开、选中在第 1 项时**第一次按下键**出现；此后继续移动不再增加。
1. 环境：全屏终端、**在 herdr 内**（不是 tmux）。
1. 「按 Ctrl+L 不消失」这一条**不成立**：面板打开时所有按键都进 `handleQuestionKey`
   （`TUI/src/app/index.ts:1528`）→ `Ctrl+L` 被吞、根本没有触发全帧重绘。该观测作废，
   需在面板关闭后或重新打开面板来复测。

## 下一次定位（A/B 判别）

在 herdr **之外**的普通终端按同样步骤复现（`dsh` → `Ctrl+D` → 第一次按 `↓`）：

- 普通终端也复现 → TUI 侧帧 / 增量重绘问题，继续在本包内定位；
- 只在 herdr 内复现 → 大概率是 herdr 的合成 / 滚动区处理与全帧重绘的交互
  （herdr-integration 侧），需要按 herdr 面板的渲染路径另查。

同时记录 herdr 窗格内的 `stty size`（TUI 认为的几何）与 herdr 窗口实际尺寸是否一致。

## A/B 结论与归属（2026-09-30）

- 用户在 herdr **之外**的普通终端复现失败 → **只在 herdr 内复现**。
- 排查本仓渲染路径后确认：herdr-integration 包**只做状态上报**（unix socket 上报
  `pane.report_agent_*`，见其 README），**不参与任何终端渲染**；TUI 侧渲染器对「首次下移」
  的增量区间重写已在下文核过（末行不发 CRLF，防触底上滚）。
- 因此现象归属 **herdr（外部工具，0.9.3）的窗格合成**：它对 TUI 区间重写报文
  （`?2026` 同步块 + `ESC[K` 擦行 + 行间 `CRLF`）的处理与普通终端不同。
- 现状代码里可作为佐证的报文（首次下移，1 块 600 字节）：
  `\e[?2026h\e[?25l\e[19;1H` + 每行 `\e[38;2;…m\e[48;2;…m\e[K<文本>` + 行间 `\r\n` + `\e[?2026l`。

## 下一步（上游定位 / 规避判断）

在 herdr 的一个窗格里跑探针（三种报文变体，逐一试）：

```sh
node tmp/herdr-panel-probe.mjs A   # 与 TUI 现状一致（同步块 + ESC[K + CRLF）
node tmp/herdr-panel-probe.mjs B   # 去掉 ?2026 同步块
node tmp/herdr-panel-probe.mjs C   # 行间改绝对定位（不用 CRLF）
```

哪个变体不再出现「行被复制」→ 即 herdr 需要修的那段序列；若 A 复现而 B/C 不复现，
本仓也可以选择规避（改渲染器报文形态），但那属于 workaround，需与上游修复权衡。

## 探针 v2 结果（2026-09-30）

10 个最小用例（内容标签与行号始终一致），用户逐个观察：

- **正常**：T1 全帧重绘、T2 单行擦行、T3 单行不擦、T4 两行绝对定位、T5 三行绝对定位、
  T6 连续行 CRLF、T7 加 `?2026` 同步块、T8 全帧后局部重写、T9 每行单独写出。
- **出错**：只有 **T10 ——第二行改用相对下移 `ESC[2B`**。

推论：

1. herdr 对「相对下移后写行」的合成有 bug（绝对定位、CRLF、`?2026`、`ESC[K`、拆分写出都正常）。
1. **TUI 侧不走那条路**：`TUI/src` 全仓 grep 无相对光标移动（`ESC[nA/B/C/D`），渲染器只用
   绝对定位 `ESC[r;cH` + 行间 `CRLF`（`TUI/src/renderer/screen.ts:213,222,274,279`）。
   故真实场景的复制行另有触发源。
1. 待验证假设：面板打开时 herdr-integration 上报 `blocked`（`waiting for user`）→ **herdr 自行
   重绘窗格 / 边框**时复制了某行；与按键无关（用户当时刚按下第一次键才注意到）。

## 暂停（2026-09-30）

用户裁定：触发条件未定、间歇性（同日一度自行消失），**先暂停**，等再次碰到时按「下一次定位」继续。
暂停时的状态：仓库代码零改动（`TUI/src/**` 未动），只有本追踪文档与 BACKLOG 状态。
`tmp/` 下的临时复现脚本与探针已删除；探针源码内嵌在下方，需要时照抄重建。

### 探针 v2 源码（内容标签与行号一致；跑法：`node tmp/herdr-panel-probe2.mjs`，每例 2.5s）

```js
// 用法（在 herdr 窗格里）：保存为 tmp/herdr-panel-probe2.mjs 后 node 运行
const base = "\x1b[38;2;201;220;222m\x1b[48;2;10;17;39m\x1b[K";
const plain = "\x1b[38;2;201;220;222m\x1b[48;2;10;17;39m";
const W = (s) => `${base}${s}`;
const pos = (r) => `\x1b[${r};1H`;
const A = { 10: "10 退出：确认退出 dsh？", 11: "11 >  1. 取消", 12: "12       留在 TUI（默认）",
  13: "13    2. 退出 dsh", 14: "14       关闭会话并退出", 15: "15    3. 重启 dsh（保留会话）",
  16: "16       保留会话，由启动器重启 dsh", 17: "17    4. 自定义回答" };
const B = { ...A, 11: "11    1. 取消", 13: "13 >  2. 退出 dsh" };
const chrome = [" 1 顶栏", " 2", " 3", " 4", " 5", " 6", " 7", " 8", " 9"];
const full = (st) => { const rows = [...chrome.map((t, i) => [i + 1, t]),
  ...Object.entries(st).map(([r, t]) => [Number(r), t]), [18, "18"], [19, "19"], [20, "20 输入区"]];
  process.stdout.write("\x1b[2J\x1b[H" + rows.map(([r, t]) => `${pos(r)}${W(t)}`).join("") + "\x1b[1;1H"); };
const write = (parts) => process.stdout.write(parts.join(""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = [
  ["T1 全帧重绘 → B", async () => full(B)],
  ["T2 单行重写 11（ESC[K）", async () => write([pos(11), W(B[11])])],
  ["T3 单行重写 11（不擦行）", async () => write([pos(11), plain + B[11]])],
  ["T4 两行绝对定位 11、13", async () => write([pos(11), W(B[11]), pos(13), W(B[13])])],
  ["T5 三行绝对定位 11、13、15", async () => write([pos(11), W(B[11]), pos(13), W(B[13]), pos(15), W(B[15])])],
  ["T6 连续三行（CRLF）", async () => write([pos(11), W(B[11]), "\r\n", W(A[12]), "\r\n", W(B[13])])],
  ["T7 同 T4 + ?2026", async () => write(["\x1b[?2026h", "\x1b[?25l", pos(11), W(B[11]), pos(13), W(B[13]), "\x1b[1;1H", "\x1b[?2026l"])],
  ["T8 全帧 A 后局部 11、13", async () => { full(A); await sleep(150); write([pos(11), W(B[11]), pos(13), W(B[13])]); }],
  ["T9 同 T4，每行单独写出（40ms）", async () => { write([pos(11), W(B[11])]); await sleep(40); write([pos(13), W(B[13])]); }],
  ["T10 同 T4，第二行相对下移 ESC[2B", async () => write([pos(11), W(B[11]), "\x1b[2B", W(B[13])])],
];
let i = 0; full(A);
const timer = setInterval(async () => {
  if (i >= tests.length) { clearInterval(timer); return; }
  const [name, run] = tests[i++]; full(A);
  process.stdout.write(`${pos(20)}${W("用例 " + name)}`);
  setTimeout(() => void run(), 250);
}, 2500);
```

结果：T1-T9 正常，**只有 T10 出错**（herdr 对相对下移后写行的合成有缺陷；TUI 从不发该序列）。

### 复现时应记录（三样）

1. 出现瞬间是否有状态变化（回合结束 / 面板刚打开 / herdr 状态角标变化）；
1. 是否「开面板后不按键」也会出现；
1. 复制行的行号与内容（以及是否 `stty size` 与 herdr 窗口尺寸不一致）。

## 第四次复现与取证通道（2026-09-30 晚）

- 用户报告（本轮为重启 `fffdsh` 复验 command-template 修复期间）：「刚刚又出现退出面板排版重复了」。
- **新增取证通道（herdr CLI；本会话即在 herdr 窗格内，`HERDR_ENV=1`、`HERDR_PANE_ID=wP1:p1`）**：
  - `herdr pane read wP1:p1 --source visible [--ansi|--raw]`：读窗格**合成后**可见屏（本窗格 43 行）——可直接抓残留行实屏证据；
  - `herdr pane read --source recent --lines N`：读最近帧；`herdr pane get`：窗格几何/滚动；
  - `herdr pane send-keys wP1:p1 <KEY>...`：向窗格发键（受控复现用；**待用户许可**）。
  - `herdr status`：client 0.9.3 / **server 0.9.1（`server_binary_stale: yes`）** —— 合成层在 server，版本落后记为嫌疑（重启 server 有破坏性，另行评估）。
- 基线已采集：窗格 `wP1:p1`（dsh / focused / viewport_rows=43），当前屏正常；`tmp/pane-visible.{ansi,raw}` 为基线快照（任务结束前清理）。
- 受控复现计划（待许可）：`Ctrl+D` 开面板 → 抓屏（回答「不按键是否出现」）→ `↓`（已知触发动作）→ 抓屏（比对残留行）→ `esc` 关面板 → 抓屏（「关面板后残留是否清除」）。全程不按 Enter（不会触发退出）。
- 待用户补：① 当时是否有命令/子代理流式输出；② 是否本窗格（wP1:p1）；③ 残留是否持续到面板关闭；④ 当时窗格尺寸是否变化。

### 受控复现（2026-09-30 晚，经用户许可，由 agent 经 `herdr pane send-keys` 操作）

- 机制确认（读码）：`Ctrl+D` 仅 `agentStatus==="idle" && 未压缩 && inputText===""` 才开面板（`canExitOnCtrlD`）——忙碌时忽略；**「750ms 内双击 Ctrl+C」无 idle 守卫**，面板可随时打开（受控复现改用它）。
- 试次 1（busy 态 `C-c C-c` 开面板；右列渲染 `退出：确认退出 dsh？` + 4 项）→ `Down`/`Down`/`Up` 各抓屏：**面板移动干净，无复制行**。
- 试次 2（面板开着 + 逐次工具调用使活动区逐步刷新，近似流式头部）→ `Down`/`Down`/`Up`：**仍无复制行**。
- 附带确认：退出面板渲染在**活动区（右列）**；`esc` 在面板打开态只关面板（安全）；无面板的 busy 态 `esc` = `interrupt()`（首轮受控操作曾因此中止 agent 回合——此后避免在 busy 态发面板外按键）。
- 结论：静态/近静态条件不复现。已布秒级抓屏（`herdr pane read --ansi`，~1.4 帧/秒 × 480s，落 `tmp/cap/`，任务结束前清理）由用户在真实条件下复现取帧。
- 另记嫌疑：`herdr status` → client 0.9.3 / server 0.9.1（`server_binary_stale: yes`），合成层在 server；重启 server 会波及所有窗格进程，需用户单独决定，不在本任务内做。

## 再次暂停（2026-09-30 晚，用户裁定）

- 用户决定「先不管了，以后再说」→ 本条回「暂停」。
- 暂停前新增的取证结论：
  1. **pane 侧全干净**：受控两轮 + 高帧率抓屏（共 1600+ 帧；其中面板帧 135 + 102 帧）逐帧结构扫描**零重复行**——重复行不在 pane 内容 / 服务端渲染视口里。
  1. 用户报告在受控两轮中**肉眼看到复现**，与 1 冲突 ⇒ 现象进一步收窄到 **herdr 客户端（0.9.3）把 pane 画到真实终端的那一步**（或极短瞬态，超出抓屏采样）。
  1. herdr 侧线索：client 0.9.3 / server 0.9.1（`server_binary_stale: yes`）；client 日志含大量 `flushing lone escape after input timeout … may reach the pane as plain esc bytes=[27]`（与渲染无直接关系，另记）。
- 恢复入口：① 请用户提供**拍屏/截图**（重复行的行号 / 列 / 持续性或瞬态）；② 可选：在受控尺寸虚拟终端挂第二个 herdr 客户端录制**客户端渲染**（会改 pane 尺寸，需用户同意）；③ 或评估重启 herdr（server stale，波及所有窗格进程）。
- 清理：本轮临时产物（`tmp/cap*/`、`tmp/hi/`、`tmp/r*.txt`、`tmp/s*.txt`、`tmp/pane-visible.*`）已删；仓库代码零改动（`TUI/src/**` 未动），只有本追踪文档与 BACKLOG 状态。

## 规划

（待定位后补「计划改动文件清单」）

## 实现记录

### 复现环境快照（2026-09-30 第二次复现，用户报告「herdr 里切换条目显示错误」）

采集时刻的真实进程与终端（沙箱外只读采集）：

| 进程 | 位置 | tty | 尺寸（行×列） | 环境 |
| --- | --- | --- | --- | --- |
| pid 4092190 `dsh --profile fff -c --resume tui-4a7f65c3…` | **herdr 内**（`HERDR_ENV=1`、`HERDR_PANE_ID=wP1:p1`、`HERDR_SOCKET_PATH=~/.config/herdr/herdr.sock`） | pts/4 | **43×154** | TERM=xterm-kitty |
| pid 3758640 `dsh --profile fff -c` | herdr 外（kitty 窗口） | pts/0 | 52×230 | 无 HERDR\_\* |
| pid 4087503 `dsh --profile fff -c` | herdr 外 | pts/8 | 55×230 | 无 HERDR\_\* |
| pid 3762101 `herdr session attach default` | herdr 客户端 | pts/6 | — | — |

并在同一时刻观察到：herdr 内会话正有**长任务在流式输出**（`/playbook code-review` 的子代理连续工具调用），
用户同时打开着问答面板并在其中上下切换条目。

**候选触发条件（按可能性排序，待复现验证）**

1. **herdr 窗格尺寸/重排**：herdr 内窗格宽 154 列、窗格外 230 列；切换条目/窗格时 herdr 会重排并可能触发
   我们侧的整屏重绘（SIGWINCH），重绘与 herdr 自身合成交叠时残留旧行 —— 优先验证「切换瞬间是否伴随尺寸变化」。
1. **流式输出 + 面板同屏**：面板在输入区、流式内容在活动区，两者同时刷新；若某次刷新只更新了部分区域，
   herdr 的合成层可能把上一帧的行留在面板首项上方。
1. **herdr 合成对相对光标移动的处理**（上一轮探针结论：仅 `ESC[2B` 相对下移会错位，而 TUI 不发出相对移动）——
   需确认重绘路径上是否出现宿主/其它插件输出的相对移动序列。

**第三次观察（同日，**未重启**）**：退出确认面板上下选择**正常**，残留未复现。差异点：复现时有两笔
`playbook code-review` 命令在跑（子代理连续工具调用 → 持续流式输出），正常时没有流式输出。
→ 进一步支持候选 2「流式输出与面板同屏刷新」；候选 1（尺寸）本轮未采集尺寸变化，暂不能排除。
验证方法（下次有流式输出时）：在有命令/子代理流式输出期间打开退出确认面板并上下切换，观察是否复现；
同时采集 `stty -F /dev/pts/<n> size` 前后值。

**下次复现时请采集**（按此顺序，30 秒内可完成）：`stty -F /dev/pts/<n> size`（复现前后各一次，判断是否伴随
resize）、当时是否有流式输出/命令在跑、是哪一个面板、切换的是哪个条目、以及残留行的截图或 `cat -A` 抓屏。

## 定位结论与修复（2026-10-01）

**新事实（用户补充，推翻旧结论）**：① tmux 里同样复现 → 不是 herdr 合成层专属；② 不止方向键，**空格**也触发。

**复现（离线，改用带触底滚屏语义的模拟器）**：旧复现台的 `tests/helpers/screenEmu.ts` 在底行收到 `\n` 只做钳位、**不模拟滚动**，所以「屏 == 帧」恒成立、长期查不出。换成带滚屏语义后复现：

- 帧行数 > 终端行数（多路复用器里 pane resize 上报滞后时必现）→ 渲染器把多出的行定位到终端末行（被终端钳位），该行之后的 `\r\n` 触发**终端滚屏**，整屏上移一行；
- 而帧间逐行 diff 认为这些行已经写对 → **残留永久保留**（表现就是「首项上方被复制出一行」）；
- 80x24（TUI 认为 25 行）、154x43（认为 44 行）均复现；尺寸一致时不复现。`↓` / 空格 / 打开面板都能触发——任何一次「超长帧写入」都会。

**修复（渲染层，最小改动）**：

1. `TUI/src/renderer/screen.ts`：`render()` 与 `renderRanges()` 把写入行钳在 `this.rows` 内——帧比终端高时**整段丢弃超出行**，绝不在最后一行之后再发 `\r\n`（从源头杜绝触底滚屏）。
1. `TUI/src/renderer/index.ts`：帧高**变短**（= 几何刚缩过）时强制**整帧重写**，自愈任何已发生的滚屏错位；帧高变长仍走 delta 增量（常见于追加，不会滚屏）。

**测试**：`tests/helpers/screenEmu.ts` 新增 `{ scroll: true }` 触底滚屏语义与 `scrollCount`（缺省关，既有断言不受影响）；`tests/screen-residue.test.ts` 新增回归用例（超长帧不滚屏 + 注入外部滚屏后帧高变短即整帧自愈）；`tests/renderer-diff.test.ts` 两处按新口径更新。

**验证**：`npm run check` ✓、`npm run test:tui` 1291 通过 / 0 失败、`npm run build` ✓；原复现场景（帧高于终端）滚动次数 1 → 0。

## 收尾

- 改动文件：`TUI/src/renderer/screen.ts`、`TUI/src/renderer/index.ts`、`TUI/tests/helpers/screenEmu.ts`、`TUI/tests/screen-residue.test.ts`、`TUI/tests/renderer-diff.test.ts`、本追踪文档、`TUI/docs/BACKLOG.md`（条目清理）。
- 真机验证项（待人工确认）：herdr / tmux 里开面板后按 `↓`、空格，首项上方不再多一行；调整窗格大小（横竖各一次）后重开面板同样干净。
- 未覆盖：残留若来自 multiplexer 客户端合成（非 pane 内容），本次修复不涉及——出现时按「pane 侧抓屏是否为净」继续二分。
