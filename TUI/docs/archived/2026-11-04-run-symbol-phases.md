# 运行状态符号分阶段：发送中四箭头旋转、接收中按类型着色（接取条目：TUI/docs/BACKLOG.md「运行状态符号分阶段：发送中四箭头旋转、接收中按类型着色」）

状态：关闭　　开启：2026-11-04　　关闭：2026-11-04
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

让用户块首行运行中符号携带两阶段语义：**发送中**（已提交、首字节未到）显示旋转箭头
（黄, 视觉旋转）; **接收中**（首字节已到, 正在流式）保持 `●`/`○` 闪烁但按当前内容类型
着色——思考紫 / 正文蓝 / 工具黄 / notice 灰 / shell 青。配套把旋转箭头符号
（⟳ ⟲ ↻ ↺）加入项目符号白名单（36 → 40）。

## 调研

（来源：本仓源码 / 既有测试）

- **符号渲染**：`layout/run-virt.ts` `userBlockSymbolResolver`（:204）——`info.active` 且
  running 时返回 `runningSymbol(runVirt.tokens)`（`●`/`○`, 按 runVirt 虚拟 token 相位
  交替）+ `fg: "yellow"`; waiting 优先 `△` 黄。符号经 `top-region.ts` 的 `userSym` 传给
  `pipelineContent`, 由 `structure.ts` 渲染在用户块首行左缘（box prefix）。
- **runVirt 相位驱动**：`RunVirtState`（run-virt.ts:74）有 `speed` / `tokens` / `lastTime`
  / `winTokens` / `winSecs`; `nextRunVirt` 在收到流式片段（带 time）时设 `lastTime` 并积分;
  `virtTick` 时间驱动（仅 `inputStatus=running` 时由 wiring 的 250ms 定时器派发）——但
  `lastTime === undefined` 时原样返回（首字节前 tokens 恒 0, phase 恒 0 → 静止 ●）。
- **发送中判定素材**：提交（`sendUserText`）置 `inputStatus=running`; `runVirt` 在
  `turn-begin`（clearActivity）时 `emptyRunVirt()` 重置——`lastTime` 恢复 undefined。
  首块到达（`appendStream` 带 time）才设 `lastTime`。因此
  `inputStatus=running && runVirt.lastTime === undefined` 恰是「已发送未收首字节」。
- **流类型着色素材**：内容来源全集 `BlockSource`（ir.ts:108）= reasoning / system / user /
  assistant / notice / shell / tool。state 侧目前**不记录**正在接收的流类型（`reducer`
  的 append 只推进 runVirt）。`appendStream` 知道 thinking/assistant; `appendNotice`/
  `appendShellLines`/`appendToolLine` 知道 notice/shell/tool; `agent-status` 事件携带
  `tool` 态。
- **符号白名单**：`dev/standard/rules.mjs` `SYMBOLS` 36 个; `AGENTS.md` 符号规范段落与
  `dev/standard/README.md:21` 均写「36」。36 符不含循环箭头（⟳ ⟲ ↻ ↺）。
- **既有测试锚点**：`layout4.test.ts` 的 mark 断言 `●`（相位 0）/`○`/`△`/`✓`/`✗`/`■`/`?`
  与黄/绿/红/灰色; `pipeline-frame.test.ts` 帧断言符号串; `appFakes` 镜像 event → delivery。

## 决策

1. 发送中旋转形态:
   - a. 四个循环箭头轮换 `⟳ → ↻ → ⟲ → ↺`（两顺两逆, 1s 一圈, 随 250ms virt-tick 进相位）,
     并把 4 个字符加入符号白名单（用户 2026-11-04 答复「都加入白名单」）
   - b. 四方向箭头 `↖ ↗ ↘ ↙` 轮换（白名单已含, 但非「循环箭头」字面）
   - c. ASCII `− \ | /`
   - 选定 **a**：贴合用户「四个循环箭头」表述与「都加入白名单」的许可; 视觉上字形
     轮换产生旋转感。白名单 36 → 40。
2. 接收中类型着色表（`streamKind` → 色）:
   - `thinking` → `brightMagenta`（紫）; `assistant` → `brightBlue`（蓝）;
   - `tool` → `yellow`; `notice` → `gray`; `shell` → `cyan`;
   - `undefined`（已接收但类型未记 / 发送中）→ `yellow` 回退（现状）。
   - `waiting` 仍 `△` 黄、未定仍 `?`（不动）。排队块仍不显符号。
3. `streamKind` 状态落点与记录点:
   - `AppState.streamKind?: StreamKind`（新字段, `StreamKind = "thinking" | "assistant" | "tool" | "notice" | "shell"`）;
   - `updates.ts`：`appendStream`（thinking/assistant 更新; user 行不扰）、`appendNotice` /
     `appendNoticeLines`（→notice）、`appendShellLines`（→shell）、`appendToolLine`（→tool）;
   - `reducer-stream.ts`：`agent-status` 为 `tool` 时 → tool（工具阶段可能无文本流）;
   - `reducer-input.ts`：`input-status` 置 `running` 时 → 清空（新发送期）;
   - `reducer-turn.ts`：`turn-end` → 清空（回合结束）。
4. 发送中相位存 `RunVirtState.sendPhase`（0..3）:
   - `virtTick` 且 `lastTime === undefined` 时按 tick 递增（取模 4）;
   - `nextRunVirt`（首块到达）不重置也可（判定走 `lastTime`）, 但为干净在 emptyRunVirt
     初始 0、nextRunVirt 保留现值。
   - 判定：`info.active && running && state.runVirt.lastTime === undefined` → 发送中
     spinner（黄）; 否则接收中 `●`/`○`（按 `streamKind` 着色）。
5. 不改 run-virt 相位机制本体、不改排队块/提示符/等待/未定语义。

## 规划

任务拆分:

1. 白名单扩展: `dev/standard/rules.mjs` SYMBOLS 追加 `⟳ ⟲ ↻ ↺`; `AGENTS.md` 符号规范
   「36 个」清单追加 4 符号并改「40 个」; `dev/standard/README.md:21` 改「40 个」。
2. `run-virt.ts`: `RunVirtState` 加 `sendPhase`; `emptyRunVirt` / `virtTick`（lastTime
   undefined 时递增）/ `nextRunVirt` 处理; 常量 `SPINNER` 与 `STREAM_KIND_COLOR`;
   `userBlockSymbolResolver` 分支（发送中 / 接收中着色）。
3. state: `types.ts` 加 `streamKind` 字段与 `StreamKind` 类型; `updates.ts` 各 append
   记录; `reducer-stream.ts` agent-status tool; `reducer-input.ts` running 清空;
   `reducer-turn.ts` turn-end 清空。
4. 测试: `layout4.test.ts` mark 断言（发送中 = 旋转箭头黄、接收中 thinking 紫 /
   assistant 蓝 / tool 黄 / notice 灰 / shell 青、发送中→接收中切换）; 守成既有
   `●`/`○`/`△`/`?` 断言。
5. 文档: 本文档归档; BACKLOG 条目关闭注记。

计划改动文件清单:

- `TUI/docs/BACKLOG.md`（条目登记, 本次接取已标进行中）
- `TUI/docs/implementation/2026-11-04-run-symbol-phases.md`（本文件）
- `dev/standard/rules.mjs`
- `AGENTS.md`（符号规范段）
- `dev/standard/README.md`
- `TUI/src/app/layout/run-virt.ts`
- `TUI/src/app/state/types.ts`
- `TUI/src/app/state/updates.ts`
- `TUI/src/app/state/reducer-stream.ts`
- `TUI/src/app/state/reducer-input.ts`
- `TUI/src/app/state/reducer-turn.ts`
- `TUI/tests/layout4.test.ts`
- `TUI/src/app/state/reducer-turn.ts`
- `TUI/tests/layout4.test.ts`
- `symbol-normalizer/src/symbols.ts`（**中途补入清单**：与 dev/standard/rules.mjs 同一白名单的
  运行时实现, 回合审查用它判定模型输出; 不同步则模型按新 AGENTS.md 用 ⟳ 会误触发提醒）
- `symbol-normalizer/tests/symbols.test.ts`（同上, 补旋转箭头族正断言）
- `TUI/docs/archived/2026-11-04-run-symbol-phases.md`（关闭后归档位）

明确不做:

- 不改 `waiting`（△）/ `?` / 排队块 / 输入区提示符（模式符号）语义。
- 不改工具名行 / 思考行的其它相位字形（`markToolNameRows` 等）。
- 不做「类型色随流式块实时切换」之外的过渡动画。
- 不改根 `README.md`/`README.zh.md`（不列符号清单；如它处出现「36」另查再定）。

## 实现记录

- 2026-11-04 白名单扩展（36 → 40）：`dev/standard/rules.mjs` SYMBOLS 追加驱动 `⟳ ⟲ ↻ ↺`;
  `AGENTS.md` 符号规范清单同步 40 个; `dev/standard/README.md:21` 改 40。
- 2026-11-04 `layout/run-virt.ts`：`RunVirtState` 加 `sendPhase`; `emptyRunVirt` 初始 0;
  `virtTick` 在 `lastTime === undefined`（首字节未到）时按 tick 递增 `sendPhase`（4 态一圈
  约 1s）, `nextRunVirt` 两处返回透传 `sendPhase`; 新增 `SPINNER`（⟳ ↻ ⟲ ↺）与
  `STREAM_KIND_COLOR` / `streamKindColor`（thinking 紫 / assistant 蓝 / tool 黄 / notice
  灰 / shell 青 / undefined 黄）; `userBlockSymbolResolver` 拆两段——发送中（lastTime
  undefined）= 黄旋转箭头, 接收中 = `●`/`○` 按流类型着色。
- 2026-11-04 state 层：`types.ts` 加 `StreamKind` 与 `AppState.streamKind`; `updates.ts`
  各 append（thinking/assistant/notice/shell/tool）记录 `streamKind`; `reducer-stream.ts`
  `agent-status= tool` 置 `streamKind: tool`; `reducer-input.ts` input-status running 清空;
  `reducer-turn.ts` turn-end 清空; `state.ts` re-export `StreamKind`。
- 2026-11-04 测试：`layout4.test.ts` 更新（发送中 ⟳ / 接收中 ● / 类型色五色互异 + 工具黄
  与回退黄一致; thinking 无流式 = ⟳; 用户输入后 turn-begin 清零 = ⟳）; `app.test.ts`
  活跃 slash 用例改发送中旋转断言; `p8-compaction-active.test.ts` 压缩中符号含旋转族;
  `interrupt-mode.test.ts` 打断直发帧断言改发送中旋转。
- 2026-11-04 `symbol-normalizer`（中途补入清单）：`src/symbols.ts` `DEFAULT_RECOMMENDED`
  加家族 F 四旋转箭头; `tests/symbols.test.ts` 更新「goal 状态符号…不扩白名单」旧裁定
  （⟳ 按本任务用户裁定改入白名单, ∥ 仍不扩）+ 新正断言。

## 偏差

- **无**实质偏差。`symbol-normalizer` 是白名单扩展的同步配套, 属授权范围, 已补入清单。
- 旧裁定「⟳ 不进推荐集合」（`symbols.test.ts` 2026-10 记录）被本次用户明确要求推翻,
  `∥` 保持原裁定（不进白名单）。

## 测试与证据

- 新增/更新断言：`layout4.test.ts`（发送中 ⟳ 相位 0、接收中 ● 相位 0、五类型色互异、
  thinking 无流式 = ⟳、turn-begin 清零 = ⟳; 既有 ✓/✗/■/?/△ 断言保持）;
  `app.test.ts` 活跃 slash 用例（发送中旋转 + 保持黄）; `p8-compaction-active.test.ts`
  （压缩中显示进行中族符号）; `interrupt-mode.test.ts`（打断直发: 被打断块 ■、直发块
  发送中旋转）; `symbol-normalizer/tests/symbols.test.ts`（⟳ 已推荐且无别名）。
- `TUI` `pnpm run check` / `build`: 退出 0; `demo -- --smoke`: 42 PASS + SMOKE_OK;
  全量 `pnpm -w run test:tui`: 1834/1834 通过。
- `symbol-normalizer` `pnpm run check` / `test`: 46/46 通过。
- 根级 `pnpm run check`（全仓 tsc）: 退出 0; `pnpm run check:docs`: 错误 0 / 警告 0
  （40 符白名单校验通过）; 根级 `pnpm run build`:（收尾复核）。
- **未做真机确认**：需 profile 重建后人工实测——提交后首字节前用户块显示黄旋转箭头,
  思考到达显紫 `●/○`、正文蓝、工具黄、notice 灰、shell 青（`fff-test` 为 `link:` 协议,
  改完 `pnpm run build` 即生效）。

## 收尾

- 回写文档：`TUI/docs/BACKLOG.md` 条目标完成并从清单清理移除; `AGENTS.md` / `dev/standard/ README.md` 符号数同步（属本任务白名单扩展）。
- 追踪文档移入 `TUI/docs/archived/2026-11-04-run-symbol-phases.md`。
- 临时调试脚本 `tmp/debug-sym.ts` / `tmp/debug-sym2.ts` 已删。
- 遗留：真机确认（见「测试与证据」末条）。
