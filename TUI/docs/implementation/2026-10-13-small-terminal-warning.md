# 启动时终端尺寸过小警告

- 层：TUI
- 接取条目（按标题引用）：`TUI/docs/BACKLOG.md`〈启动时终端尺寸过小警告〉
- 开始：2026-10-13　状态：进行中（实现完成：check + build + 全量测试通过；真机人工确认待用户）

## 目标

终端尺寸过小时界面不可用，但启动后没有任何提示。本任务在**启动时检测一次**终端尺寸，
**宽 ≤ 16 或 高 ≤ 9** 时给出一条警告；不做小尺寸降级设计、不监听 resize（用户 2026-10-13 裁定）。

## 调研（2026-10-13，源码）

1. **尺寸来源**：`renderer.getSize()`（`src/renderer/index.ts:386`）→ `terminal.getSize()`
   （`src/renderer/terminal.ts:97-102`）：取 `stdout.columns/rows`，**非 TTY 或 0 时回落 `80×24`**
   → 启动时不会拿到 `0×0`，不会误报；真 TTY 下启动即有有效尺寸。
2. **落点时机**：`App.start()`（`src/app/index.ts:907`）顺序为 —— 接线 → statusTicker →
   `virtTimer` → `loadWidthSymbols()` → `renderer.setTheme()` → **`paintNow()`（首帧）** → 探测 → 目录拉取 …。
   故检测点放在 **`paintNow()` 之前**，警告可在首帧就位、且不必多绘一帧。
3. **通知机制**（两处可落）：
   - `state.notice` + tone → 底部输入区上方的 notice 行（`noticeFooterLines`，面板态改显最近 notice）；
     **常驻**直到被下一条 notice 覆盖（无 TTL、无定时器）。
   - `notice()`（`index.ts:5220`）= `apply(notice)` + `deliverLocal(notice 节)` + `paint()`：
     除底部行外还**写进流水线通知节**（进回合区历史），并且会多绘一帧。
4. **tone 取值与配色**（`adapter/types.ts:120`、`content-rules.ts:122`）：`log` 灰 / `info` 蓝 /
   `warn` 黄 / `error` 红 / `success` 绿 —— 警告语义对应 `warn`。
5. **同类先例**：启动期提示走 `notice(text, tone)`（如「宿主不支持 steer，已按 followup 投递」）；
   本任务的警告是否也进历史（流水线通知节）见决策 3。
6. **测试面**：既有启动用例在 `tests/app.test.ts`（`App` + `FakeAdapter` / `FakeRenderer`，
   可注入尺寸）；`FakeRenderer` 的尺寸由构造参数给出，便于注入 `cols ≤ 16` / `rows ≤ 9`。

## 决策（2026-10-13 与用户裁定）

> 约定：决策项用数字，选项用 abcd。

1. **落点与写入方式 = a**：`start()` 内、`paintNow()` 之前**只置状态**（`apply(notice)`）→ 首帧即显示、不多绘。
2. **文案与 tone = a**：「终端尺寸过小（宽 ≤ 16 或高 ≤ 9），显示可能不可用，请调大窗口」+ tone `warn`（黄）。
3. **是否写进历史 = a**：只进底部 notice 行，不写流水线通知节（启动噪音不进回区）。
4. **持续时长 = a**：常驻直到被下一条 notice 覆盖（无 TTL、不新增定时器）。
5. **测试落点 = a**：新增 `tests/small-terminal-warning.test.ts`。

**细节（用户 2026-10-13 答复）**

1. **正常警告格式**：文案不带符号前缀，走既有 notice 渲染（与其它启动期提示同口径）。
2. **尺寸变化后重新检测，但不管理旧警告**（用户 2026-10-13 二次澄清）：在既有 `renderer.onResize`
   回调里**重跑检测** —— 仍过小 → **再弹一次警告**（新记录）；已够大 → **不弹新警告**，也**不主动清除**
   旧警告（警告是**记录**而非状态，随既有的「下一条 notice 覆盖」口径自然更替）。
   实现上因此**不需要**清空 notice 的分支。
3. **尺寸未知按正常处理**（非 TTY / 0 → `terminal.getSize()` 回落 `80×24`，不提示）：**暂时可以，看测试情况**。
4. **用例含该边界**（回落 `80×24` → 不提示）：**暂时可以，看测试情况**。

## 计划改动文件清单（2026-10-13 定稿）

1. `src/app/index.ts`：新增纯判据 `smallTerminal(size)`（`cols ≤ 16 || rows ≤ 9`，**可导出供测试**）+
   警告文案 / tone 常量；`start()` 的 `paintNow()` **之前**首次检测并置 notice（决策 1a）；
   既有 `renderer.onResize` 回调（现为 `() => this.paint()`）改为「重跑检测 + paint」——
   过小 → **再置一次 warning notice**（会覆盖当前 notice）；够大 → **什么都不做**（不清旧警告）。
   **无清空 notice 的分支**（决策细节 2）。
2. 新增 `tests/small-terminal-warning.test.ts`（决策 5a），四条：
   - 启动即过小（`cols ≤ 16` / `rows ≤ 9` 各一）→ notice 行出现警告文案
   - 启动正常 → 无该文案
   - 先被别的 notice 覆盖 → resize 仍过小 → **警告再次出现**（这就是「再弹一次」的可观测口径）
   - 已被别的 notice 覆盖 → resize 变正常 → **仍是那条别的 notice**（不清旧警告）
   - 边界：非 TTY / 0 尺寸 → `getSize()` 回落 `80×24` → 不提示
3. 文档：`TUI/docs/SPEC.md` 无「启动期提示」专节（已核：只有 notice 注入与渲染口径），故**本次不改文档**；
   如需登记，等本任务关闭时在 `TUI/docs/DESIGN.md` 的启动路径描述里补一句（关闭时再定）。

## 实现记录

1. `src/app/index.ts`：新增常量 `SMALL_TERMINAL_COLS = 16` / `SMALL_TERMINAL_ROWS = 9` /
   `SMALL_TERMINAL_NOTICE`（文案）与纯判据 `smallTerminal(size)`（导出供测试）；`start()` 在
   `paintNow()` **之前**调 `warnIfSmallTerminal()`；`renderer.onResize` 回调改为「重跑检测 + paint」；
   新增私有方法 `warnIfSmallTerminal()`（够大分支为空，无清空 notice 分支）。
2. 新增 `tests/small-terminal-warning.test.ts`：7 条（判据边界 / 启动过小·宽 / 启动过小·高 /
   启动正常 / 尺寸未知 / resize 仍过小 / resize 够大不新增）。

**计划外偏差（2 处，均有实测证据）**

1. **判据对「尺寸未知（0）」短路返回 false**（计划未写）：按阈值判定 `{cols:0,rows:0}` 会得 true
   （`0 ≤ 16`）→ 误报。真机 `terminal.getSize()` 有 `80×24` 回落故拿不到 0，但未知按正常处理更稳，
   也正是决策细节 3 的口径。
2. **警告走 `notice()` 而非「只置状态」（决策 1a + 3a 的原文）**：实测只 `apply(notice)` 时警告
   **在真机不可见** —— 流水线下活动区内容来源唯一（节缓存，`layout.ts:982`），只写 `state.local`
   的 notice 仅出现在**模态面板态**的底部行（`noticeFooterLines` 只在 approval / question 打开时
   接管 footer），而本警告要在普通输入视图可见。改走 `notice()` 后它作为一条**记录**进活动区，与
   既有启动期提示（「宿主不支持 steer，已按 followup 投递」）同路径；首帧路径上紧随的 `paintNow()`
   会清掉 `notice()` 的待绘标记，**并未多绘一帧**（决策 1a 的真正关切仍成立）。决策细节 2 亦自述
   「警告是**记录**而非状态」，与此一致。

## 测试与证据

- `sh scripts/test.sh tests/small-terminal-warning.test.ts`：**7 通过 / 0 失败**。
- `npm run check`：通过；`npm run build`：通过。
- `sh scripts/test.sh`（全量）：**1532 通过 / 0 失败**（无既有帧断言回归，本次未重冻任何断言）。
- 帧核验（临时探针脚本，跑后已删）：`80×9` → 活动区两行「终端尺寸过小（宽 ≤ 16 或高 ≤ 9），显示
  可能不可用，请 / 调大窗口」；`16×24` → 逐段折行可见；`80×24` → 无警告；`0×0` → 无警告。
- resize 核验：`80×24`（先被 `/theme xyz` 的 usage notice 覆盖）→ resize `80×9` → 警告重新出现；
  `80×9` → resize `80×24` → 帧内警告计数仍为 1（不新增），最新一条仍是 usage notice。
- **人工确认真机效果：未做**（用户不在场，按授权先提交）。真机复看项：`dsh --profile fff`，
  把窗口缩到 ≤ 16 列或 ≤ 9 行重启 → 活动区应出现该警告；够大时 resize 到过小也应出现。

## 收尾

（待填）
