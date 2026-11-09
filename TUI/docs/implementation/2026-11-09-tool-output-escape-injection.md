# 工具输出转义序列注入（接取条目：TUI/docs/BACKLOG.md「回合区输出时状态行上边框左段缺横线(增量渲染残留, 待定案)」）

状态：规划　　开启：2026-11-09　　关闭：（未关闭）
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

工具输出（尤其脚本）里夹带的转义序列不再被终端当命令执行；回合区任何内容的写入都不能波及固定边框行，状态行上边框左段缺口不再出现；宽度 / 截断口径与正文放行口径一致。

## 调研

### 现象

- 2026-11-05 用户报告：回合区流式输出 / 快速滚动时，状态行上边框行左段横线消失变空白、右段完好；缺口固定在该行，Ctrl+L 全帧重绘恢复（条目原文）。
- 2026-11-09 用户补充：**工具条目**输出会出现，**尤其是脚本**；怀疑脚本里的字符没被当纯文本，而是被当成控制字符。

### 代码事实（本次逐处核对）

1. **正文放行口径过宽**：`TUI/src/app/state/updates.ts:41-58` 的 `sanitizeText` 只剔除孤立 ESC，**完整 CSI（`ESC[…`）与 OSC（`ESC]…`）原样保留**，注释写明理由是「样式 / 光标控制，属已有功能」。该函数是 `appendStream` / `appendNotice` / `appendNoticeLines` / `appendShellLines` / `appendToolLine` 的共用闸门（`updates.ts:96`、`:146`、`:182`、`:206`、`:228`），剔除计数进 `state.strippedChars`。
2. **写屏不过滤**：`TUI/src/renderer/screen.ts:368-392` 的 `serializeFrameRow` 直接拼 `seg.text`（`:387`），帧序列化到写盘之间没有任何再过滤。内容里保留的 `ESC[2K`（清行）、`ESC[1A`（上移一行）、`ESC[3;5H`（绝对定位）、`ESC[2J`（清屏）因此会在真终端**按命令执行**，写到当前帧正在拼装的画面里。
3. **增量渲染不重画未变化行**：`TUI/src/renderer/screen.ts:224-225` 只对变化区间逐行 `ESC[{row};1H` + `ESC[K` + 行文本；被内容误写 / 擦掉的固定边框行若「文本未变」，此后不再被重写 → 缺口保留。Ctrl+L 走全帧（`screen.ts:161-192`），每行绝对定位 + 行首 `ESC[K` 重擦 → 自愈。与「缺口固定不动、重绘恢复」一致。
4. **宽度 / 截断只认 SGR**：`TUI/src/app/layout/markdown.ts:30-34` 的 `ANSI_RE` 与 `TUI/src/app/layout/primitives.ts:67` 的扫描正则都只匹配 `ESC[…m`；非 SGR 序列被当可见列计入宽度，折行与截断随之偏移（第二重不一致）。
5. **现有用例把风险写成期望**：`TUI/tests/app.test.ts:3297-3306` 断言「完整 ANSI CSI/OSC 序列保留」，且用 `ESC]52;c;abc BEL` 作样例——正是本条目要拦的类别。
6. **主渲染路径不经上述闸门**：正文已改走节缓存（`state.local` 只作遗留缓冲）。适配器事件经 `deliverLocal` → `TUI/src/app/runtime/frame.ts:100` `applyDelivery` → 节缓存；`applyDelivery`（`TUI/src/app/layout/pipeline/sections.ts:604-620`）把 `delivery.text`（`:672`）、`delivery.args`（`:385-447`）、`delivery.detail`（`:455-499`）**原样**存入节模型。即：工具结果 / 工具参数 / 正文的主路径**完全没有** `sanitizeText`，只有遗留缓冲那条辅路有。

### 取证（未取得实物）

- 扫本机全部会话日志 `~/.dsh/sessions`（19 个 `session*.jsonl.zstd`，逐个 `zstd -dc | grep` 非 SGR CSI 形态）：命中仅出现在本会话推理正文里（本次调查自述文字），**工具结果 / 脚本输出里没有 ESC 字节**。
- 结论：机制可定案（第 1 至 6 条是读码事实），但「报告场景里具体哪条序列」没有实物；按用户 2026-11-09 裁定走机制加固，不等帧取证。

## 决策

1. **闸门位置**：a 各适配器入口逐个加 / **b 节接收层 `applyDelivery` 统一加（选定）** / c 帧序列化时过滤。
   选 b：`applyDelivery` 是「接收层唯一入口」（`sections.ts:603` 注释），实时线、结算线、恢复重放、本地交付四条路径都过它；在此处净化后文本即成为节模型的唯一事实，宽度计算天然只见净化后文本。选 a 要改多处易漏，选 c 时宽度已经算错。
2. **放行范围**：a 全放行（现状）/ **b 只放行 SGR（`ESC[…m`），其余 CSI 与 OSC 一律剔除（选定）** / c 连 SGR 一起剔。
   选 b：SGR 是本仓渲染着色自己的产物，也是工具输出彩色化的唯一可见收益；光标 / 擦除 / 清屏 / 剪贴板 / 标题这类序列对 TUI 有害无益。选 c 会让工具输出的颜色整片变成转义文字，视觉退化。
3. **宽度口径**：a 各处各写 / **b 抽一份共享 SGR 定义（选定）**。
   选 b：现有 `markdown.ts:30` 与 `primitives.ts:67` 已重复同一正则，加闸门后三处必须同口径。
4. **条目里备案的「相邻段首行强制重写」**：a 同时做 / **b 不做（选定）**。
   选 b：闸门已封死「内容自带光标控制」这一来源；若后续取证发现另有他源，另开条目评估。
5. ~~**`\r` 与 `\t` 口径**：`\r\n` / 孤立 `\r` 归一为 `\n`，其余 C0/C1（含 `\t`）剔除并计入 `strippedChars`。~~（实现期被 5′ 取代）
5′. **`\t` 口径修订（实现期取代 5 号决策）**：`\t` 不剔除，改为**展开固定 4 个空格**；`\r\n` / 孤立 `\r` 仍归一为 `\n`，其余 C0/C1 与孤立 ESC 剔除并计 `strippedChars`。理由与证据：按 5 号原口径剔除 `\t` 后，代码块缩进整片消失（`TUI/tests/code-block-tab.test.ts` 两例红：`代码块：\t 展开 4 空格，行号列 + 列分隔，行宽恰为内容宽`、`思考区代码块：同一口径展开 \t`）；展开 4 空格与代码块既有口径（`expandCodeTabs`）一致，宽度可预测，且帧里不留裸 `\t`（工具行同样受益）。

## 规划

任务拆分：

1. 抽共享净化原语：新文件承载 `sanitizeText` 与 SGR 正则，`state/updates.ts` 改为再导出（对外 API 不变）。
2. 节接收层加闸门：`applyDelivery` 内按交付类型净化 `text` / `args` / `detail`。
3. 宽度口径统一：`layout/markdown.ts`、`layout/primitives.ts` 改用共享 SGR 定义。
4. 测试：更新 `sanitizeText` 用例（改为「只留 SGR」）；新增工具行 / 工具结果注入非 SGR 序列的帧级用例（断言渲染出的帧字节里没有 `ESC[2K` / `ESC[1A`，且文本按纯文本可见）。
5. 反向验证：临时还原净化前的实现，新用例应变红。

计划改动文件清单（本任务只碰这些文件）：

- `TUI/src/app/sanitize.ts`（新建：`sanitizeText` + `SGR_RE`）
- `TUI/src/app/state/updates.ts`（删本地实现，改再导出）
- `TUI/src/app/layout/pipeline/sections.ts`（`applyDelivery` 入口净化）
- `TUI/src/app/layout/markdown.ts`（改用共享 SGR 定义）
- `TUI/src/app/layout/primitives.ts`（改用共享 SGR 定义）
- `TUI/tests/app.test.ts`（`sanitizeText` 用例口径更新）
- `TUI/tests/pipeline-sections.test.ts`（节接收层净化的单元用例）
- `TUI/tests/pipeline-frame.test.ts`（工具行 / 工具结果注入序列的帧级用例）

明确不做：

- 不改渲染层的「相邻段首行强制重写」备案方案（决策 4）。
- 不动状态列 / 状态行自身的文本来源（会话标题、todo 文本、goal 文本等）；本次审计发现它们各自有独立路径，是否也有同类风险未核，若确认有另开条目。
- 不动 `docs/BACKLOG.md` 与 `STATUS.md`；条目的清理只在本任务收尾时做。

## 实现记录

- 新建 `TUI/src/app/sanitize.ts`：`SGR_ANCHORED`（放行口径）、`stripSgr`（宽度剥离）、`sgrTokens`（截断按 token）、`sanitizeText`（CR 归一 → `\t` 展开 4 空格 → 非 SGR 的 CSI / OSC 整条剔除 → 其余 C0/C1 与孤立 ESC 剔除并计数）。模块不引其它 app 模块，避免循环依赖。
- `TUI/src/app/state/updates.ts`：删本地实现，改为 `import` + `export { sanitizeText }`，对外 API 与 `state.ts:77` 的再导出不变（5 处内部调用点无需改动）。
- `TUI/src/app/layout/pipeline/sections.ts`：新增 `sanitizeDelivery`（按交付类型净化 `text` / `args` / `detail`），在 `applyDelivery` 首行调用——实时线、结算线、恢复重放、本地交付四条路径共用这一个闸门。
- `TUI/src/app/layout/markdown.ts`：删 `ANSI_RE` / `stripAnsi`，改 `import { stripSgr }`（`displayWidth` 处口径一致）。
- `TUI/src/app/layout/primitives.ts`：`computeTruncateToWidth` 的 matchAll 换成 `sgrTokens`，截断不再自带一份正则。
- 测试：`TUI/tests/app.test.ts` 的 `sanitizeText` 用例改为「只留 SGR + `\t` 展开 4 空格」；`TUI/tests/pipeline-sections.test.ts` 加第 ⑧ 条（工具参数 / 工具结果 / 正文的净化断言）；`TUI/tests/pipeline-frame.test.ts` 加帧级用例（工具结果带 `ESC[2K` / `ESC[1A` / OSC，断言帧里无转义、无残缺参数、正文仍在）。
- 验证过程中一并按新口径更新两条既有用例（`append：剔除计数…`、`tool-call：summary 含 \r\n/控制符…`），它们断言的是旧 `\t` 剔除行为。
- 关键命令与结果见「测试与证据」。

## 偏差

- **决策 5 被取代**：`\t` 原计划剔除，实现期改为展开 4 空格——原因与证据（`code-block-tab.test.ts` 两例红）记在决策 5′。
- 计划外文件：无（源码 5 个 + 测试 3 个，与清单一致；另加本追踪文档与 `TUI/docs/BACKLOG.md` 的状态标记）。
- 未做项：仍不做渲染层「相邻段首行强制重写」备案（决策 4）；状态列 / 状态行自身文本来源是否也带同类风险**未核**（本次只覆盖回合区内容路径），未确认前不另开条目。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `pnpm -C TUI run check` | 通过（`tsc --noEmit`） |
| `pnpm -C TUI run build` | 通过 |
| `pnpm run test:tui` | 1879 例全绿（含新增 3 例；期间修掉 `code-block-tab` 2 例、`app.test` 2 例旧口径） |
| `pnpm run test:tui <单文件>` | `pipeline-sections` 31 / `pipeline-frame` 18 / `app.test` 199 / `code-block-tab` 3，全绿 |
| 反向验证（`applyDelivery` 的 `delivery = sanitizeDelivery(delivery)` 改 `void sanitizeDelivery`） | `pipeline-sections` 30/31（⑧ 红）、`pipeline-frame` 17/18（帧级用例红）；恢复后全绿 |
| `pnpm run check`（38 包） | 全 OK |
| `pnpm run test`（38 包） | 38 包 OK，0 失败 |
| `pnpm run demo -- --smoke` | `SMOKE_PASS` / `SMOKE_OK` |
| `pnpm run check:docs` | 119 篇现行 Markdown / 960 个 `.ts`，错误 0 / 警告 0 |
| `format <改动文件>` | 全部 unchanged（无需重排） |

未验证：真机会话里「脚本输出带 `ESC[2K`」的原始场景未再复现（本机会话日志里没有实物 ESC 字节，见调研）；新构建要等 `scripts/install.sh --profile fff --sync` 与重启后才会加载到运行中的会话。

## 收尾

（待补）
