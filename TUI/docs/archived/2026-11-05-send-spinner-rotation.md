# 发送中旋转箭头：等待首字节期间看不出旋转

> 接取条目（按标题引用）：TUI/docs/BACKLOG.md「发送中旋转箭头：等待首字节期间看不出旋转」（已完成, 收尾时从 BACKLOG 移除）
> 状态：完成（2026-11-05）
> 来源：用户报告「用户消息前的状态符号, 在已发出请求等待期间的箭头, 旋转效果不对」

## 计划改动文件清单

- `TUI/src/app/layout/run-virt.ts`（`SPINNER` 序列 / 发送中分支）
- `TUI/src/app/runtime/wiring.ts`（`virtTick` 的重绘判据）
- `TUI/tests/layout4.test.ts`、`TUI/tests/interrupt-mode.test.ts`（帧断言随实现同步）

## 调查记录

### 现有实现

- `SPINNER = ["⟳", "↻", "⟲", "↺"]`（`run-virt.ts:28`），发送中（`runVirt.lastTime === undefined`）显示 `SPINNER[sendPhase]`，黄色（`run-virt.ts:274-282`）。
- `virtTick` 在发送中只做 `sendPhase = (prev.sendPhase + 1) % 4`（`run-virt.ts:175-179`）。
- `VIRT_TICK_MS = 250`（`lifecycle.ts:38`），`setInterval` 常驻，`inputStatus === "running"` 或子代理运行时才推进（`wiring.ts:75-88`）。

### 根因 A：重绘被跑掉（主因）

`wiring.ts:83-87` 的重绘判据是虚拟 token 相位：

```ts
const before = runPhase(ctx.state.runVirt.tokens);
ctx.self.apply((s) => reduceState(s, { type: "virt-tick", time: Date.now() }));
if (runPhase(ctx.state.runVirt.tokens) !== before) ctx.self.paint();
```

发送中 `lastTime === undefined`，`tokens` 不增长，`runPhase` 恒定，故 `paint()` 永不触发。状态变化本身不重绘（`frame.ts:633-650` 的 `apply` 只改状态）。

画面实际由状态行 ticker 带着走：`intervalMs` 默认 1000ms（`lifecycle.ts:297`），其回调里 `ctx.self.paint()`（`lifecycle.ts:301-303`）。1s 恰好是 4 拍 = 一整圈, 采样总落在同一相位 → 箭头看起来静止；只有当两个定时器的相位漂移时才偶尔跳一格。

### 根因 B：序列方向不一致（次因）

`⟳`（顺时针缺口圈）、`↻`（顺时针开圈）为顺时针，`⟲`、`↺` 为逆时针。按 `⟳ → ↻ → ⟲ → ↺` 播放等于「顺时针半圈 + 逆时针半圈」，视觉上是来回摆而不是单向旋转。

### 牵连

- `⟳` 同时被状态列的 goal 自动续轮开关使用（`TUI/src/app/components/StatusColumn.ts`），改 `SPINNER` 不影响它。
- 现有帧断言：`layout4.test.ts:461`、`layout4.test.ts:560`（发送中相位 0 = `⟳`）；`interrupt-mode.test.ts:218`（正则 `/[⟳↻↲↺]/`，其中 `↲` 不在白名单，属笔误级宽松断言）。

### 待用户裁定的方案候选

1. 修重绘判据：发送中按 `sendPhase` 变化重绘（4 态真正连续，1s 一圈）；序列是否仍用 4 向字形待定。
2. 改序列：只用同向字形（`⟳ ↻` 两态轮换，或 `⟳ ↻` 加空白/点交替），避免半圈倒转。
3. 改节律：把发送中相位绑到状态行 ticker（1s 一拍、4s 一圈）或反向提高刷新率。

实现时按用户指令选其中一条或其组合。

## 实施记录（2026-11-05）

用户裁定：先只做「4 相位切换真正可见」，字形后面再定。故只落方案 1 的重绘部分。

- `TUI/src/app/runtime/wiring.ts`：`virtTick` 在 tick 前后同时记录 `runPhase(tokens)` 与 `runVirt.sendPhase`，任一变化即 `paint()`。发送中 token 不涨，靠 `sendPhase` 每拍变化触发重绘；接收中行为不变（仍由 token 相位驱动）。
- `TUI/tests/app.test.ts`：新增「发送中旋转箭头随 virt-tick 每拍重绘（4 拍一圈）」——mock `setInterval` + `Date`，不传 status deps（无状态行 ticker），断言每 250ms 重绘一帧且符号依次 `⟳ → ↻ → ⟲ → ↺ → ⟳`。

### 验证

- 变异验证：临时去掉 `sendPhase` 判据 → 新用例在「每拍重绘一帧（期望 ↻）」失败；恢复后通过。
- `pnpm run check` 全包通过；`pnpm run test:tui` 1837 项全通过；`pnpm run build` 通过。

### 未做（待用户裁定）

- 字形方向与目标转速未改：`⟳ ↻` 顺时针、`⟲ ↺` 逆时针，画面仍是来回摆，`SPINNER` 保持原样。
- `TUI/tests/interrupt-mode.test.ts` 的正则含 `↲`（不在符号白名单），属既有宽松断言的笔误，本次未动。

## 二改（2026-11-05）：发送中改 2 相位「虚线圆 / 实线圆」交替

用户裁定：`SPINNER` 改成两相位, 虚线圆与实线圆交替, 同时重新审阅此前加入白名单的四个旋转箭头。

### 代码与测试

- `TUI/src/app/layout/run-virt.ts`：`SPINNER = ["◌", "○"]`（U+25CC 虚线圆 → U+25CB 实线圆）；相位取模改按 `SPINNER.length`（原本就按长度取模, 现自动变 2 相位）, 250ms 一拍, 两态一轮 0.5s。注释同步。
- 帧断言同步 `◌`：`TUI/tests/layout4.test.ts`（三处）、`app.test.ts`（两处, 含重绘用例改为两态一轮）、`interrupt-mode.test.ts`、`p8-compaction-active.test.ts`、`app.test.ts:1266` 的发送中符号集。
- `run-virt` 的重绘判据不变（`sendPhase` 变化即重绘）, 两相位下每拍换帧。

### 验证

- `pnpm run check` 全包通过；`pnpm run build` 通过；`pnpm run test:tui` 1837 项全通过。
- 列宽：实测编译产物 `charWidth`, U+25CC 与 U+25CB 静态都是 1 列。差别是 U+25CB 落在 `WIDTH_UNCERTAIN_RANGES`（运行期 CPR 实测自校正），**U+25CC 不在该表**, 属 EAW=A 却无实测校正；极端字体若按 2 列显示, 2 列前缀会被撑开。补表需改生成器并重生成（已有 229 行漂移条目）, 本次不动。

### 白名单审阅（待用户裁定, 未改任何文件）

四个旋转箭头的现状：

- `⟳` U+27F3：仍在使用——状态列 Goal 块的自动续轮开关（`TUI/src/app/components/StatusColumn.ts`, SPEC §15.1）。保留。
- `↻` U+21BB：仍在使用——重试行 `↻ 重试中 (N)`（`TUI/src/app/layout/tool-line.ts`）与 `TOOL_STATUS_PREFIXES`（`content-rules.ts`）。保留。
- `⟲` U+27F2 / `↺` U+21BA：产品代码已无使用, 只剩 `symbol-normalizer` 白名单与其测试、以及历史文档。**可删**。
- 新符号 `◌` U+25CC：不在白名单, 但现在是 TUI 发送中可见符号, 建议**加入**。

候选：A）加 `◌`、删 `⟲ ↺`（40 → 39）；B）只加 `◌`（40 → 41）；C）只删 `⟲ ↺`（40 → 38, 发送中符号不进白名单）。改动面 = `AGENTS.md` 白名单段 + `symbol-normalizer/src/symbols.ts` + 其 README/测试 + 相关文档。

用户裁定：选 A（加 `◌`、删 `⟲ ↺`，白名单 40 → 39）。

### 白名单改动（已落）

- `AGENTS.md`：白名单「40 个」改「39 个」, 删 `⟲ ↺`, 在 `○` 后加 `◌`。
- `symbol-normalizer/src/symbols.ts`：同步白名单; 家族 F 注释改为「⟳ ↻ 两态」; 治理区注释补 2026-11-05 调整记录。
- `symbol-normalizer/README.md`：推荐白名单串补 `⟳ ↻ ◌`, 圆域行补 `◌`。
- `dev/standard/rules.mjs`：`SYMBOLS` 同步（删 `⟲ ↺`、加 `◌`）, 注释改 39。
- `symbol-normalizer/tests/symbols.test.ts`：家族 F 断言改为 `⟳ ↻`; 新增「`⟲`/`↺` 已移出白名单」「`◌` 已推荐且无别名」。
- 全仓复查：`⟲`/`↺` 在产品代码、测试、现行文档中已无引用（只剩本追踪文档与历史归档）。

### 验证（白名单改动后）

- `symbol-normalizer/` 内 `pnpm run test`（46 项通过）与 `pnpm run check` 通过。
- `pnpm run check` 全包通过；`pnpm run build` 通过；`pnpm run test` 全包通过（exit 0）；`pnpm run check:docs` 0 错误 0 警告。
