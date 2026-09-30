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

## 规划

（待定位后补「计划改动文件清单」）

## 实现记录

（待补）

## 测试与证据

（待补）

## 收尾

（待补）
