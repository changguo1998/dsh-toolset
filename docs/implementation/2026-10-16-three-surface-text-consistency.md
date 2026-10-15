# 追踪文档（同一分支的两项任务: A 助手正文「三面一致」核对 / B md-table-check 漏检形态筛查）

状态：规划　　开启：2026-10-16　　关闭：
本文件是这两项任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 接取范围

- 任务 A（项目级条目）: `docs/BACKLOG.md`「助手正文「三面一致」核对（TUI 接收面 / 插件实收文本 / 会话区显示）」——状态〔进行中: 2026-10-16〕。
- 任务 B（模块级条目）: `md-table-check/docs/BACKLOG.md`「漏检形态筛查（除已证形态外, 哪些坏表格不会被拦下）」——状态〔进行中: 2026-10-16〕。
- 任务 C（rule-engine 检查流程）: 用户 2026-10-16 指定; **尚未登记 BACKLOG 条目**（规划评审时一并裁定落点与登记方式）。

## 任务 A：助手正文「三面一致」核对

### 目标

核对同一条模型回复正文在三个面上的内容是否一致: ① TUI 接收并显示到会话区的文本; ② rule-engine 经 `assistant-text` 交给插件（md-table-check 等消费者）的文本; ③ 插件提示经注入后回到会话区的呈现文本。逐条给出「一致 / 有意不同（含理由与风险）」结论, 并留可复现证据。

### 调研

#### S1 链路与关键代码

链路 ①（宿主 → TUI 会话区）:

- `assistant/message` 事件: 取 `data.message.content` 里的文本块, 经 `extractTextBlocks`（`TUI/src/app/adapter/normalize.ts:42-50`）`join("")`（**不 trim、不折叠**）。
- `pushText`（`TUI/src/app/adapter/dsh.ts:338-348`）: 仅当整条文本 `trim() === ""` 时丢弃, 否则原样入会话区（role `assistant`）。
- 另有实时帧通道 `agent/assistant-stream`（`dsh.ts:1335` / `1367` / `1917+`）先逐块出正文; `assistant/message` 作定型表面事件只补缺失后缀, 避免重复显示。

链路 ②（宿主 → 插件）:

- rule-engine 在 `assistant/message` 时缓冲 `messageText`（`rule-engine/src/match.ts:106-117`, 与 TUI 提取同形: 仅收 `type === "text"` 的块并 `join("")`）, 按回合存 `state.buffers`。
- `#buffer`（`rule-engine/src/engine.ts:588-594`）: `text.length === 0` 才跳过; 否则 `text.slice(0, TEXT_BUFFER_LIMIT)` 入列, `TEXT_BUFFER_LIMIT = 20_000`（`engine.ts:67`）——**按单条 step 正文截断**。
- `turn/end`（`engine.ts:562-572`）: 仅当 `reason ∈ {completed, max-tokens}`（`INJECTABLE_TURN_REASONS`, `engine.ts:77-80`）才派发; 载荷 = 该回合各条缓冲 `join("\n")`; 异常收尾（其它 reason）不派发。
- 仅在「有消费者或文本类规则」时才缓冲（`#needsText`, `engine.ts:596-601`）。

链路 ③（插件提示 → 会话区呈现）:

- 消费者返回 `{ text, summary }`（md-table-check: `src/checker.ts:213-247`）, rule-engine 按 `delivery` 注入; md-table-check 缺省 `delivery: "followup"`、`dedupeInRecord: 0`（不限次）。
- TUI 显示侧: `noticeSummaryOf`（`normalize.ts:60-70`）仅在 `source.form === "notice"` 时折成一行摘要（`summary` 优先, 否则正文首行, ≤120 字符）; 非 notice 形态按普通消息显示全文。

#### S2 候选差异点（静态初判）

| # | 差异点 | 来源 | 影响面 |
| --- | --- | --- | --- |
| 1 | 单条 step 正文超 20 000 字符被截断: 插件只见前缀, 会话区显示全文 | `engine.ts:67` / `588-594` | 插件判定可能漏检截断后的表格 |
| 2 | 纯空白 step: TUI 整条丢弃, rule-engine 仅在长度 0 时跳过 → 插件文本可能多出空白串 | `dsh.ts:338-348` vs `engine.ts:588-594` | 行号与文本细节可能偏移 |
| 3 | 多 step 拼接: 插件面用 `\n` 连接, 会话区显示为独立正文块 | `engine.ts:564` vs `dsh.ts:486-491` | 跨 step 的表格不被识别为同一张 |
| 4 | 末步未定型: 实时帧已显示, `assistant/message` 未到达 → 会话区有、插件面无 | `dsh.ts:1335`+ vs `engine.ts:504-508` | 收尾异常时插件完全不派发 |
| 5 | 注入提示的会话区呈现是摘要行, 逐字正文只在模型上下文 | `normalize.ts:60-70` | 用户看不到完整提示正文 |

#### S3 离线夹具复演（`tests/displaySurface.test.ts`（原 `tmp/three-surface-check.ts`））

构造事件序列（`assistant/message` × N + `turn/end`）同时喂真实 adapter 与真实 rule-engine（消费者 = 真实 md-table-check）, 逐字节比对 ① 显示文本与 ② 插件实收文本:

| 用例 | ① 显示（判定） | ② 插件实收（判定） | 逐字节 |
| --- | --- | --- | --- |
| 单 step | 全文（报 1） | 全文（报 1） | 相同 |
| 多 step（表跨 step） | 两段直接相接、表被拆（不报） | 两段以 `\n` 连接（报 1） | 不同 |
| 空白 step | 跳过空白 step（报 1） | 保留 `   ` 行（报 1） | 不同 |
| replace 覆盖 | 丢弃被覆盖 step（不报） | 仍缓冲该 step（报 1） | 不同 |
| 超长 step（坏表在第 20000 字符后） | 20088 字符（报 1） | 截断到 20000（不报） | 不同 |
| 异常收尾（`reason=aborted`） | 照常显示（报 1） | 空串（不报, 未派发） | 不同 |
| ③ 注入呈现 | notice 形态（带 `summary`）→ 显示 `表格列数提醒` | 插件原文 157 字符 | 显示为摘要行, 非全文 |

#### S4 真机历史日志实测（`tmp/three-surface-log-scan.ts`（真机巡检, 一次性） / `tmp/three-surface-probe.ts`（真机逐回合, 一次性））

扫描 `~/.dsh/sessions` 下 5 份真实 `session.v4.jsonl.zstd`（共 238 条 `assistant/message` / 41 条 `turn/end`）:

- 单条 step 正文 > 20000 字符: 0 条（本次样本未出现）。
- `surfaceOp: "replace"` 事件: 0 条（本次样本未出现）。
- **纯空白 step 正文: 193 / 238 条（81%）** —— 与工具调用同行的 `"\n\n"`; 逐个 `turn/end` 复算, 22 个回合里 **12 个**的 ① 显示文本与 ② 插件文本不一致, 差值 = 空白 step 条数 × 1~2 字符（例: 6 step 回合显示 825 字符 / 插件 840 字符, 插件文本以 15 个换行开头）。
- `turn/end` reason 非 {completed, max-tokens}: `aborted` 1 条（该回合插件面为空串）。

#### S5 精确实测: 真实 adapter vs 真实 engine（`tmp/three-surface-adapter-vs-engine.ts`（已并入差分对拍） / `tests/displaySurface.test.ts`（原 `tmp/three-surface-display-probe.ts`））

不依赖静态阅读, 直接用真实 TUI adapter 与真实 rule-engine 跑同一串事件并打印两侧文本:

| 场景（真实形态: 工具调用 step 的正文为 `"\n\n"`） | ① 显示（真实 adapter） | ② 插件（真实 engine） | 差异 |
| --- | --- | --- | --- |
| 2 个空白工具 step + 正文 | 18 字符（`"\n\n\n\n答复正文第一段。\n\n第二段。"`） | 20 字符（同前缀 + 每 step 边界多 1 个 `\n`） | 首个不同在第 4 字符 |
| 无空白 step 的对照 | 14 字符 | 14 字符 | 逐字节相同 |
| 空白工具 step + 坏表正文 | 39 字符, 含表格 | 40 字符, 含表格 | 同一张表 |

显示面补充实测（`tests/displaySurface.test.ts`（原 `tmp/three-surface-display-probe.ts`）, 8 条断言 7 通过）: `surfaceOp=replace` 的正文**不进入显示**; **纯空白正文照常进入显示**（`"   \n"` 被输出为 stream 事件）; 两条 step 的显示文本**直接相接、无分隔符**; 同条消息多个 text 块直接相接; 无 text 块不产生正文; 已流式部分只补缺失后缀; 无 chunk 时整条输出; `extractTextBlocks` 不 trim。注入侧（真实 `noticeSummaryOf`）: notice 形态 → 一行摘要 `表格列数提醒`（非全文）; 无 `summary` → 正文首行截断 ≤120 字符; 非 notice → `undefined`（调用方显示全文）。

真机日志反查（22 个回合逐回合比对两种重建口径）: `插件文本 == 各 step 原文用 "\n" 连接` **全部成立**; 而「各非 replace step 原文直接相接」比插件文本少 `(step 数 - 1)` 个字符（例: turn 3 有 20 step → 少 19; turn 11 有 6 step → 少 5）。

**更正（推翻先前结论）**: S3「空白 step: 显示面丢弃」与「① 显示文本 = 非空白 step 直接相接」的重建口径**不成立**; S4「12/22 回合不一致源于显示面跳过空白 step」的**解释错误**。正确口径: ① 显示 = 各非 replace step 原文直接相接（空白 step 照常计入）; ② 插件 = 各 step 原文用 `"\n"` 连接（每个 step 边界多 1 个 `\n`）。差异 2 随之由「口径不一致（高频）」下调为「**仅分隔符差异**（N step 多 N-1 个换行, 判定结论不受影响）」。

### 决策

（决策项用数字, 选项用 abcd, 选定项写明字母; 结论均由脚本实测得出）

1. 单 step 超 20000 字符截断（差异 1）: 结论 = **缺陷（可致漏检）**。选项: (a) 另开 `rule-engine/docs/BACKLOG.md` 条目（选定）; (b) 本任务内改引擎; (c) 只记录。理由与证据: 夹具用例「坏表在第 20050 字符后」显示面报 1、插件面不报（`tests/displaySurface.test.ts`（原 `tmp/three-surface-check.ts`））; 巡检 559 条真实 `assistant/message` 未出现超限样本（最长 2875 字符）, 属低频但会让消费者漏检。代价: rule-engine 侧约 0.5 天, 不由本任务实施。
2. 纯空白 step（差异 2）: 结论 = **口径不同但低风险（有意不同）**, 该差异只是 step 之间的 `\n` 分隔符: 显示面 = 各非 replace step 原文直接相接; 插件面 = 各 step 原文用 `\n` 连接（N step 多 N-1 个换行）。选项: (a) 保持现状, 仅在 `rule-engine/README.md` 写明拼接口径（选定）; (b) 另开条目讨论去掉分隔符。理由: 两侧判定结论在实测中一致; 去掉分隔符会让跨 step 的表格在插件侧不再成立。证据: `tmp/three-surface-adapter-vs-engine.ts`（已并入差分对拍） 两个口径均与真实输出一致; 真机会话 35 个回合逐回合断言「插件面 == 各 step 原文 `\n` 连接」全部成立（34 成立 / 0 不成立 / 1 未收尾）。
3. 多 step 拼接方式（差异 3）: 结论 = **有意不同**, 与第 2 项同源（`\n` 连接是整回合正文的既定口径; 跨 step 的表在显示侧本就不成立, TUI 逐块建表）。处置: 不改, 随第 2 项一并写入 README。
4. `replace` 事件（差异 4）: 结论 = **潜在误报（缺陷）**。TUI 丢弃被覆盖正文（`tests/displaySurface.test.ts`（原 `tmp/three-surface-display-probe.ts`） 实测显示为空）, rule-engine 仍缓冲 → 插件可能要求修正屏幕上不存在的内容（夹具实测: 显示面不报 / 插件面报 1）。选项: (a) 另开 `rule-engine/docs/BACKLOG.md` 条目, 在引擎侧对齐 TUI（选定）; (b) 保持现状。代价: 约 0.5 天 + 需先确认宿主 replace 语义; 巡检 559 条真实事件未出现该形态（0 条）, 优先级低于第 1 项。
5. 非 completed / max-tokens 收尾不派发（差异 5）: 结论 = **有意不同（符合设计）**。夹具与真机各 1 条 `aborted` 均未派发; 属「异常收尾不唤醒消费者」。处置: 不改。
6. TUI 思考 / 正文分离: 结论 = **正确**（13 条断言全 ✓, `tests/reasoningSeparation.test.ts`（原 `tmp/tui-reasoning-separation.ts`））: 思考不入正文通道、不入 `assistant-text` 载荷; 「完整消息里的 reasoning 不回补思考通道」与设计一致（`TUI/docs/DESIGN.md:395`）。处置: 不改; 「非流式 provider 思考不可见」不单独立项（无用户可见缺陷证据）。
7. 注入提示的会话区呈现（差异 6）: 结论 = **有意不同**: notice 形态折叠为一行摘要 `表格列数提醒`; 无 summary 时取正文首行截断 ≤120 字符; 非 notice 形态返回 undefined（调用方显示全文）。处置: 不改。
8. 本任务产出物: (a) 只出结论与建议条目, 不改产品代码（选定）; (b) 一并修引擎。理由: 项目级条目范围是「核对」; 两处引擎改动交由独立条目裁定与实施。

### 规划

核对方式约束（用户 2026-10-16 指令）: 涉及 TUI 的检查**一律用临时脚本取精确结果**, 不得以模型阅读代码作为结论。

任务拆分（P1–P5 已完成; P6 收尾待提交点裁定后执行）:

- P1 落地核对范围与方法（已完成）: 按「调研」S1–S6 复核链路清单与差异候选, 明确 ① 显示面 ② 插件面 ③ 呈现面各自的口径基线（哪些属有意不同）。
- P2 离线夹具（脚本, 已完成）: 真实 adapter + 真实 rule-engine 同跑同一事件序列, 逐字节比对; 覆盖单 step / 多 step / 空白 step / replace / 超长 / 异常收尾 6 类, 并补 ③ 提示呈现的 notice 断言。
- P3 真机核对（脚本, 已完成）: 扫 `~/.dsh/sessions` 统计差异点频率; 对指定会话逐回合复算两侧文本（重建逻辑按 S5 的口径）。
- P4 思考 / 正文分离核对（脚本, 已完成）: 覆盖 S6 的 13 条断言, 并确认「非流式 provider 思考不可见」的展示口径。
- P5 结论与立项（已完成）: 按「决策」候选逐条定稿（一致 / 有意不同 / 缺陷）, 需要改动的写成条目并交其他 agent 接取（落点待裁定: rule-engine 包内 vs 项目级）; 可选项: 实时真机会话探针是否独立成任务。
- P6 收尾: 补齐「测试与证据」「偏差」, 追踪文档移入 `docs/archived/`, 清理 BACKLOG 条目与 `tmp/` 脚本（保留与否见「决策」9④）。

计划改动文件清单:

- `docs/implementation/2026-10-16-three-surface-text-consistency.md`（本文件; 收尾移入 `docs/archived/`）
- `docs/BACKLOG.md`（本条目状态: 接取时标「进行中」, 收尾标「完成」并清理移除）
- `rule-engine/docs/BACKLOG.md`（**待裁定**: 若「决策」1/4 采纳 (a), 按结论追加条目; 目前为空, 未登记）
- `tmp/three-surface-*.ts` / `tests/reasoningSeparation.test.ts`（原 `tmp/tui-reasoning-separation.ts`）（核对脚本; 保留 / 删除见「决策」9④）
- 其余产品代码（`TUI/` / `rule-engine/` / `md-table-check/src`）默认不改; 若用户裁定「本任务内一并修」再补入清单

明确不做:

- 不改 `TUI/`、`rule-engine/`、`md-table-check/src` 的产品代码（除非用户在「决策」8 改判）
- 不改 `docs/STATUS.md`（用户择时更新）
- 不做「顺手优化」

### 实现记录

- 2026-10-16 接取条目开工（条目已标〔进行中〕, 追踪文档已提交 `fb59bf2`）。
- 2026-10-16 P2 离线夹具: 修正 `tests/displaySurface.test.ts`（原 `tmp/three-surface-check.ts`） 的 stale 用例名后重跑（6 用例）, 并新增 `tmp/three-surface-adapter-vs-engine.ts`（已并入差分对拍） 用真实 adapter / engine 校验两侧口径（两口径均与真实输出一致）。
- 2026-10-16 P3 真机核对: 重写 `tmp/three-surface-probe.ts`（真机逐回合, 一次性）（断言「插件面 == 各 step 原文 `\n` 连接」）并对本会话日志跑 35 个回合（34 成立 / 0 不成立 / 1 未收尾）; `tmp/three-surface-log-scan.ts`（真机巡检, 一次性） 巡检 5 份日志 559 条消息 / 61 个回合。
- 2026-10-16 P4 思考 / 正文分离: `tests/reasoningSeparation.test.ts`（原 `tmp/tui-reasoning-separation.ts`） 13 条断言全 ✓; `tests/displaySurface.test.ts`（原 `tmp/three-surface-display-probe.ts`） 修正 1 条与实测相反的旧断言（纯空白正文照常进入显示）后 8 条断言全 ✓。
- 2026-10-16 差分对拍（补充取证）: 新增 `tmp/three-surface-differential.ts`, 用独立复刻的两侧模型与真实实现同输入对拍; 首轮暴露复刻模型 2 处错误假设（把显示面误当作「丢弃纯空白 step / 丢弃仅有工具调用的 step」, 实际口径是按 step 键查已输出后只补后缀, 整条空正文才不输出）, 修正后 7 个定向用例 + 300 条与 2000 条随机序列全部一致。顺带实测到引擎的一处缺省口径: `turn/end` 不带 `reason` 时按 `completed` 处理（照常唤醒）, 已写入 `rule-engine/README.md`。
- 2026-10-16 **脚本转正**: 按用户要求把一次性核对脚本按用途转成正式测试 —— `md-table-check/tests/displaySurface.test.ts`（显示面与注入呈现）、`reasoningSeparation.test.ts`（思考 / 正文分离）、`surfaceDifferential.test.ts`（三面差分对拍, 含确定性随机序列 300 + 2000 条）; 并把 TUI 口径核对并入 `tests/tuiParity.test.ts` 新增「互证 ⑤」; 四个文件在 TUI 源码缺失时整体跳过（沿用 `tuiParity.test.ts` 的降级策略）。`tmp/` 下对应脚本随之删除。
- 2026-10-16 P5 结论: 两条应修项（超长截断 / replace）写成 `rule-engine/docs/BACKLOG.md` 条目; 「step 分隔符」口径写成 `rule-engine/README.md` 说明（均按「决策」1 / 2 / 4 的选定项执行）。

### 偏差

- 无（P1–P5 按规划执行; 期间只修正了两处脚本自身的 stale 断言 / 模型, 不涉及产品代码）。

### 测试与证据

测试已转正为 `md-table-check/tests/` 下的四个文件（`npm --prefix md-table-check test`, 51 例全绿）; 下表的命令栏给转正前的一次性脚本路径与等价命令。

| 脚本 | 命令（在仓库根） | 结果 |
| --- | --- | --- |
| `tests/surfaceDifferential.test.ts`（原 `tmp/three-surface-differential.ts`） | `npm --prefix md-table-check test` | **独立复刻模型 vs 真实实现差分对拍**: 8 个定向用例（单 step / 多 step + 空白 + 工具块 / replace / 异常收尾 / reason 对象形态 / reason 缺省 / 多 text 块与无 text 块 / 超限截断）全部一致; 随机序列 300 条与 2000 条均 **0 处不一致** |
| `tests/displaySurface.test.ts`（原 `tmp/three-surface-check.ts`） | `node --experimental-transform-types tmp/three-surface-check.ts` | 6 用例: 单 step 两面逐字节相同; 多 step / 空白 step / replace / 超长 / 异常收尾 5 例不同; 「超长」显示报 1 / 插件不报, 「replace」显示不报 / 插件报 1; 提示原文 157 字符 → 显示摘要 `表格列数提醒` |
| `tmp/three-surface-adapter-vs-engine.ts`（已并入差分对拍） | `node --experimental-transform-types tmp/three-surface-adapter-vs-engine.ts` | 显示面口径与插件面口径**均与真实输出一致**（0 处不符）; 真实形态 2 个空白 step: 显示 18 字符 / 插件 20 字符（差 2 个 `\n`） |
| `tests/displaySurface.test.ts`（原 `tmp/three-surface-display-probe.ts`） | `node --experimental-transform-types tmp/three-surface-display-probe.ts` | 8 条断言全 ✓（replace 不进显示 / 纯空白照常进显示 / step 直接相接 / 流式只补后缀 / notice 折叠为摘要 等） |
| `tmp/three-surface-log-scan.ts`（真机巡检, 一次性） | `node --experimental-transform-types tmp/three-surface-log-scan.ts` | 5 份日志 / 559 条 `assistant/message` / 61 个 `turn/end`; 超 20000 字符 0 条（最长 2875）; replace 0 条; 纯空白正文 466 条; 非 {completed,max-tokens} 1 条（`aborted`） |
| `tmp/three-surface-probe.ts`（真机逐回合, 一次性） | `node --experimental-transform-types tmp/three-surface-probe.ts <日志> [回合]` | 本会话 35 个回合: 口径断言 34 成立 / 0 不成立 / 1 未收尾; ①② 逐字节不同的回合数 = 含空白 step 的回合数 |
| `tests/reasoningSeparation.test.ts`（原 `tmp/tui-reasoning-separation.ts`） | `node --experimental-transform-types tmp/tui-reasoning-separation.ts` | 13 条断言全 ✓ |
| `tests/tuiParity.test.ts`「互证 ⑤」（原 `tmp/tui-parity-check.ts`） | `node --experimental-transform-types tmp/tui-parity-check.ts` | 13 条断言全 ✓（任务 B S4 的口径核对证据） |

残留检查: 产品代码（`src/`）未改动; 新增 3 个测试文件与 `tuiParity.test.ts` 的 1 个用例（测试代码, 见「变更清单」）。

**未验证项（如实记录）**: 本 worktree 的 `node_modules` 不存在（worktree 建后未安装依赖）, `tsc` 不可用 → `npm --prefix md-table-check run check` 与全仓 `npm run check` **未运行**; 已运行的是 `npm --prefix md-table-check test`（node 类型擦除, 51 例全绿）。请在有依赖的环境补跑 `npm install` 后执行 `npm run check`。

提交检查点（任务 A 实现/测试后）: 按 `docs/WORKFLOW-STANDARD.md` §5 询问用户是否提交; 因本次改动全为文档与条目定义（无产品代码、无测试用例）, 建议合并到任务关闭后一次提交。

### 变更清单

| 变更 | 位置 | 说明 |
| --- | --- | --- |
| 新增测试（脚本转正） | `md-table-check/tests/displaySurface.test.ts` | 显示面与注入呈现 11 例 |
| 新增测试（脚本转正） | `md-table-check/tests/reasoningSeparation.test.ts` | 思考 / 正文分离 9 例 |
| 新增测试（脚本转正） | `md-table-check/tests/surfaceDifferential.test.ts` | 三面差分对拍 3 例（含随机序列 300 + 2000 条） |
| 扩展现有测试 | `md-table-check/tests/tuiParity.test.ts` | 新增「互证 ⑤」成表判据与不等时的走向（原 `tmp/tui-parity-check.ts` 的断言） |
| 文档 | `md-table-check/README.md` | 测试文件清单与降级说明（三份 → 六份） |
| 文档 | `rule-engine/README.md` | `assistant-text` 的 `\n` 拼接与 20000 截断口径、`reason` 缺省按 `completed`、观测口径与 TUI 的差异说明 |
| 条目 | `rule-engine/docs/BACKLOG.md` | 新增 2 条（20000 截断漏检 / replace 语义不一致） |
| 追踪文档 | 本文件 | 调研 S1–S6、决策定稿、证据表 |
| 保留的一次性脚本 | `tmp/three-surface-log-scan.ts` / `tmp/three-surface-probe.ts` | 真机日志巡检与逐回合复算（依赖 `~/.dsh/sessions` 实机数据, 不入库） |

## 任务 B：md-table-check 漏检形态筛查

### 目标

逐个核查 BACKLOG 条目列出的 8 个待查形态, 给出「报 / 不报」结论并留下可回归的证据; 应报而漏报者补判定与单测; 确认不报的形态写进 README 或注释。

### 调研

#### S1 现状判定链路（读源码）

- 判定入口 `md-table-check/src/checker.ts:139` `checkTables`：逐行扫描, 围栏外「本行可切出单元格 + 下一行为分隔行样」即候选表, 再逐行比对列数（`checker.ts:165-198`）。
- 切分口径 `splitCells`（`checker.ts:30-58`）：`\` 转义吞下一字符、`|` 切分、剥除行首尾空单元格、逐格 `trim`; 与 TUI `TUI/src/app/layout/table.ts:72-100` 逐行等价。
- 围栏守卫：本包 `FENCE_RE`（`checker.ts:61`）与 TUI `TUI/src/app/layout/markdown.ts:775` 同正则; TUI 在 `build-box.ts:695` 用 `!inFence` 挡住表格分支。
- 放宽项：TUI 要求分隔行与表头列数**相等**才认表（`table.ts:143-149` `isTableStart`）, 本插件故意不要求 —— 正是要报的情形。

#### S2 形态矩阵实测（本 worktree 实跑, 脚本 `tmp/probe.ts` / `tmp/probe2.ts`, 已删）

命令：`node --experimental-transform-types tmp/probe.ts`。下表 `tableTotal` = 报出的问题表数, `lineTotal` = 不一致行数。

| 形态（条目编号） | 用例要点 | 实跑结果 | 结论 |
| --- | --- | --- | --- |
| ① 仅数据行列数不符 | 表头 / 分隔行 2 列, 数据行 3 列 | `tableTotal=1 lineTotal=1` | 报 ✓ |
| ② 同一回复多张表 | 两张坏表隔一行说明; 隔三行正文; 三张 | `2 / 2`、`2 / 2`、`3 / 3` | 逐张报 ✓ |
| ② 相邻两表（无间隔） | 坏表后紧跟另一张坏表 | `tableTotal=1 lineTotal=2` | 合成一张报（与 TUI 同判：TUI 也把连续带竖线行收进同一张表） |
| ③ 表格在末尾无尾随空行 | 末行即数据行, 无末尾 `\n` | `1 / 1` | 报 ✓ |
| ④ 转义竖线 | 数据行的竖线写成 `\|`（三格） | `1 / 1` | 报 ✓（转义不切分） |
| ④ 行内代码含竖线 | 表头里用反引号包住含竖线的片段（字面 4 格）, 分隔行 / 数据行各 3 格 | `1 / 2` | 误报（见 S3, 微缺口） |
| ⑤ 表格在围栏内 | 反引号栅与波浪号栅包裹的坏表 | `0 / 0` | 不报 ✓（应不报） |
| ⑥ 分隔行带对齐标记 | 表头 3 列, 分隔行写 `:--` 与 `:-:` 共 2 格 | `1 / 1` | 报 ✓（因列数 2≠3; 对齐标记本身不触发） |
| ⑦ 表头与分隔行一致但少于数据行 | 2 列表 + 3 列数据行; 3 列表 + 2 列数据行 | `1 / 1`、`1 / 1` | 报 ✓（TUI 会忽略多格、补空缺格） |
| ⑧ 分隔行不足 2 单元格 | 表头 2 格 + 分隔行 1 格 + 数据行 2 格 | `1 / 1` | 报 ✓ |
| ⑧ 单列表且列数一致 | 表头 / 分隔行 / 数据行各 1 格 | `0 / 0` | 不报 ✓（列数一致, 本就不该报） |
| ⑧ 单列表数据行多格 | 表头 1 格 + 分隔行 1 格 + 数据行 2 格 | `1 / 1` | 报 ✓ |
| 附: 表头与分隔行之间有空行 | 表头 2 格 + 空行 + 分隔行 2 格 + 数据行 3 格 | `0 / 0` | 不报 ✗（见 S3, 缺口一） |
| 附: 引用块内表格 | 三行均带 `> ` 前缀 | `0 / 0` | 不报（TUI 亦不认表：`markdown.ts:886` 的引用分支走行内解析, 不建表 → 口径一致） |
| 附: 列表项内表格 | 两空格缩进的表格 | `1 / 1` | 报 ✓ |

#### S3 两处需裁定的缺口

**缺口一：表头与分隔行之间有空行 → 不报。** 条目现象里那次「重新列表」回复的失败形态即此（模型输出的表格常在表头后空一行）。TUI 只把**相邻**两行当表头 + 分隔行（`build-box.ts:697-701` 取 `local[li + 1]`）, 因此这种块整块退回原始竖线文本（用户可见的「排版失败」）, 而本插件同样不报 —— 两侧都沉默。

**缺口二（微）：行内代码里的竖线按字面切分。** `splitCells` 不做代码跨度感知, 所以表头 `` | `a | b` | c | d | `` 被切成 4 格: 表头 4 格 / 分隔行 3 格 + 数据行 3 格 → 报 2 处, 而该表在 GFM 下是 3 列表（代码跨度内的 `|` 不切）。TUI 用同一 `splitCells`, 所以它也不认这张表（3≠4 整表退回）。误报的代价是**多报一处**而非漏报, 且这种写法本身在仓库文档里很少见。修它需要重写切分并同步 TUI, 破坏「与 TUI 同口径」的验收基准。

##### S4 与 TUI 表格处理逻辑的口径核对

对照对象: `TUI/src/app/layout/table.ts`（`splitCells:72-100` / `isDelimCell:116` / `isTableStart:143-149` / `parseTableAt:156-184` / `tableBox:377-400`）与 TUI 的两处接入点（`build-box.ts:695-720` 带 `!inFence` 守卫; `pipeline/boxes.ts:295-303` 以游标整体跳过栅内内容）。

**同口径的部分**: 单元格切分（`\` 转义吞下一字符、`|` 切分、剥除行首尾空单元格、逐格 trim）——实跑 9 条夹具无差异; 分隔格正则 `:?-+:?`; 围栏正则（本包 `checker.ts:61` 与 TUI `markdown.ts:775` 同式）; 数据行收集终止条件（`splitCells` 为 null 或长度 0 即表结束）。

**有意不同的部分**: ① 成表判据——TUI 要求分隔行与表头列数**相等**（`isTableStart`）, 本插件只要求分隔行样; ② 列数不等时的走向——分隔行不等时 TUI 整表退回纯文本、本插件报出; 数据行不等时 TUI 照常认表但**静默丢格**（实测: 2 列表 + 3 格数据行丢 1 格, 相邻两表丢 2 格）, 本插件报出。

**两边都不认（口径一致）**: 围栏代码块内、引用块内、表头与分隔行之间空行、伪表格（缺分隔行）。

**同源缺口**: 行内代码里的竖线两侧都按字面切分（都不做代码跨度感知）, 口径自洽但与 GFM 不同（见 S3 缺口二）。

**判定层之外的差异（本插件不涉及）**: TUI 另做列宽求解与宽度不足退回（`tableBox` / `fitCols:251-264`）、数字列自动右对齐（`isNumericCell:135-137`）、宽度未知或紧凑模式不建表; 本插件只数列数, 无宽度概念。

**结论**: 未发现判定层的实质不一致; 差异集中在「成表判据 + 不等时的报告」, 与 README 声明的唯一放宽项吻合。

**可复现验证脚本**（临时, 放项目根 `tmp/`, 只读）: `tests/tuiParity.test.ts`「互证 ⑤」（原 `tmp/tui-parity-check.ts`）; 运行 `node --experimental-transform-types tmp/tui-parity-check.ts` → 13 条断言全 ✓（0 处不符）, 含上方各条证据 （splitCells 9 条夹具无差异、分隔行不等 isTableStart=false、数据行多 1 格 TUI 丢 1 格、围栏 / 引用块 / 空行分隔两侧均不认）。

### 决策

> 结论来自 S1–S4（决策项用数字, 选项用字母）; 选定项已按项后理由执行。

1. 缺口一（空行分隔的表头 / 分隔行）怎么处理？（已按 (a) 执行: 条目已登记, 不再补判定）
   - (a) **不做检出**, 本次只把结论写进 README 与追踪文档, 另开 BACKLOG 条目（选定）
   - (b) 本次一并补判定, 把「表头 + 空行 + 分隔行」也当候选表
   - (c) 只写注释, 文档不记
   - 理由：本插件现有文案与 `summary` 全按「列数不一致」写（`checker.ts:224-245`）, 而缺口一的表格**列数一致**、只是没被认成表格; 硬套现有文案会与事实不符, 要新增提示类别与措辞, 属新裁定, 超出本条目范围。选 (a) 既不留信息黑洞（README + 新条目）, 又不擅自扩语义。若用户裁定做 (b), 则在实现阶段补判定与新文案。
2. 交付物落点？（已按 (a) 执行：README 形态表 + `checker.test.ts` 断言）
   - (a) README 增加「已核查形态（含明确不报）」小节 + 在 `tests/checker.test.ts` 补齐未覆盖形态的断言（选定）
   - (b) 只写 README, 不加测试
   - (c) 只写测试, 不动 README
   - 理由：条目验收 ① 要求结论落进 README 或注释, 验收 ② 要求应报漏报者补单测; 已有测试覆盖了 ①⑤⑥⑦⑧ 的一部分但未按形态编号标注, 补齐后每个形态都有可回归断言, 比注释更耐久。
3. 缺口二（行内代码竖线）怎么处理？（已按 (a) 执行: 不修, 断言钉住多报一处）
   - (a) 不做（保持与 TUI 同口径切分）, 只登记结论（选定）
   - (b) 本次实现「代码跨度感知切分」并同步改 TUI
   - 理由：改切分要同时改 TUI `table.ts` 才不破坏互证, 属跨模块改动（按规范应由用户分出独立 worktree 另开任务）; 现缺口代价仅是多报一处, 收益低于成本。
4. 非表格区域是否加「预先筛掉不可能成表的行」的优化？（已按 (a) 执行: 不加）
   - (a) 不加（选定）
   - (b) 加预筛（如要求行首为 `|`）
   - 理由：TUI 的表格分支在**相同位置**做无预筛判定, 加预筛会让本插件与 TUI 判定出现双向偏差, 超出本条目范围。
5. 新发现的条目如何登记？（已按 (a) 执行: 2 条已在 `md-table-check/docs/BACKLOG.md`）
   - (a) 在 `md-table-check/docs/BACKLOG.md` 追加 2 条（缺口一、缺口二）, 交由其他 agent 接取（选定）
   - (b) 只写进本追踪文档
   - 理由：按流程「途中发现的新问题 → 写进追踪文档 + BACKLOG 追加新条目」。
6. 测试补齐范围（哪些未覆盖形态本次要补断言）？（已按 (a) 执行）
   - (a) 按「应报形态 + 已裁定口径固定」两栏补齐（选定）：① 应报形态：② 相邻两表（断言与 TUI 同判为一张、不一致行数为 2）、③ 末尾无尾随换行、④ 行内代码含竖线、⑧ 单列表子形态三态（列数一致不报 / 数据行多格报 / 分隔行 1 格报）、形态 ① 与 ② 的**组合**（表头 3 / 分隔行 2 / 数据行 4 → 两处不一致且按行号排序）、表格位于回复首行（显式断言 `headerLine = 1`）; ② 已裁定口径固定：⑧ 与缺口二的「不做」结论、附加形态「表头与分隔行间空行 / 引用块内表」均**不报** → 用不报断言钉住口径, 防将来改动反向引入误报。
   - (b) 只补应报形态, 不补「不报」断言
   - (c) 不补测试, 只写 README
   - 理由：选 (a)。只补应报侧会留下回归缺口：这次裁定的「不报」正是将来最容易因「顺手加判定」而被打破的部分, 用断言写死比注释可靠。
7. 实测正确但缺组合 / 缺命名的形态要不要单独立用例？（已按 (a) 执行）
   - (a) 要（选定）：分隔行与数据行**同时**不符、表格位于首行两个场景各自立名, 不蹭其他用例。
   - (b) 不立, 认为已被现有用例间接覆盖
   - 理由：这两处目前只是行为正确（实跑核验）, 断言层面无名字、无计数校验; 回归时读不到「这是有意为之」的证据。
8. 引用块内表格 / 列表项缩进表要不要进 README 形态表？（已按 (a) 执行）
   - (a) 都进（选定）：引用块标注「不报, TUI 亦不认表（口径一致）」, 列表项标「报」。
   - (b) 只进引用块一条
   - 理由：两者都在 S3 中实测过, 写进表里才能回答「这两个形态查过吗」。

### 规划

#### P1 测试用例（本次补测清单, 逐条可回归）

编号沿用 BACKLOG 的形态 ①–⑧; 「附」为本次实测新增的形态。每条 = 输入要点 → 预期 → 证据来源（S2 = 已实跑实测; P6 = 本次要补的断言）。

01. 形态 ① 仅数据行列数不符（表头与分隔行一致）: 表头 / 分隔行 2 列 + 数据行 3 列 → 报 1 处数据行不一致。证据: S2 已实测（`tableTotal=1 lineTotal=1`）, 已有断言「数据行多格 / 缺格」。
02. 形态 ①+② 组合（分隔行与数据行**同时**不符）: 表头 3 列 / 分隔行 2 列 / 数据行 4 列 → 报 2 处, 按行号顺序为分隔行、数据行, 且不出「另有」行。证据: S2 已实测（`lineTotal=2`, 行号 2、3）; 本次按 D7 立独立用例。
03. 形态 ② 同一回复多张表（隔行）: 两张坏表中间隔一行说明（或隔三行正文, 乃至三张）→ 逐张报, `tableTotal` 与 `lineTotal` 分别计数。证据: S2 已实测（`2 / 2`、`3 / 3`）, 已有断言「多表汇总」。
04. 形态 ② 相邻两表（无间隔）: 坏表后紧跟另一张坏表 → 与 TUI 同判为**一张表**、2 处不一致（不拆成两张）。证据: S2 已实测（`tableTotal=1 lineTotal=2`）, 本次按 P6 补断言。
05. 形态 ③ 表格在回复末尾（无尾随空行）: 末行即数据行, 文本末尾无换行符 → 照常报出。证据: S2 已实测, 本次按 P6 补断言。
06. 形态 ④ 转义竖线: 数据行的竖线写成 `\|` → 不切分, 列数一致即不报; 与表头不等时照常报。证据: S2 已实测, 已有断言「`\|` 转义不切分」。
07. 形态 ④ 行内代码含竖线（缺口二）: 表头里用反引号包住含竖线的片段（字面 4 格）, 分隔行 / 数据行各 3 格 → 报 2 处（多报一处）。这是已裁定口径（D3(a) 保持与 TUI 同口径）, 断言写死当前结果。证据: S2 已实测（`tableTotal=1 lineTotal=2`）。
08. 形态 ⑤ 表格在围栏代码块内: 反引号栅与波浪号栅包裹的坏表 → 不报; 且闭栅后的真表格照常报。证据: S2 已实测, 已有断言「围栏代码块内的表格 → 不报」。
09. 形态 ⑥ 分隔行带对齐标记: 分隔行写 `:--` / `:-:` / `--:`（列数与表头一致）→ 不报（对齐标记本身不触发）。证据: S2 已实测, 已有断言「列数一致的表格 → 不报」与互证 ③。
10. 形态 ⑦ 表头与分隔行一致但均少于数据行: 2 列表 + 3 列数据行; 3 列表 + 2 列数据行 → 都报。证据: S2 已实测, 已有断言「数据行多格 / 缺格」与互证 ④（TUI 容忍丢格）。
11. 形态 ⑧ 分隔行不足 2 单元格: 表头 2 格 + 分隔行 1 格 + 数据行 2 格 → 报 1 处（分隔行）。证据: S2 已实测, 已有断言「分隔行列数少于表头」与互证 ②。
12. 形态 ⑧ 单列表且列数一致: 表头 / 分隔行 / 数据行各 1 格 → 不报（列数一致, 本就不该报）。证据: S2 已实测, 本次按 P6 补断言。
13. 形态 ⑧ 单列表数据行多格: 表头 1 格 + 分隔行 1 格 + 数据行 2 格 → 报 1 处（数据行）。证据: S2 已实测, 本次按 P6 补断言。
14. 表格位于回复首行（前面无空行）: 表头即文本第 1 行 → 照常识别, 断言 `headerLine = 1`（不被前置上下文影响）。证据: S2 已实测（该形态本就不是漏检）; 现有用例散落在四处, 本次按 D7 立显式命名用例。
15. 附: 表头与分隔行之间有空行（缺口一）: 表头 2 格 + 空行 + 分隔行 2 格 + 数据行 3 格 → 不报（已裁定不做, D1(a); 与 TUI 同为不认表）。用不报断言钉住口径。证据: S2 已实测（`0 / 0`）。
16. 附: 引用块内表格: 三行均带 `> ` 前缀 → 不报（TUI 引用分支走行内解析、不建表 → 口径一致）。用不报断言钉住口径。证据: S2 已实测（`0 / 0`）。
17. 附: 列表项内表格: 两空格缩进的表格（正文 + 坏表）→ 报 1 处。证据: S2 已实测（`1 / 1`）, 本次按 D8 也进用例。

不报口径汇总（回归防线, 共 5 条）: 第 8（围栏内）、9（对齐标记且列数一致）、12（单列表列数一致）、15（表头与分隔行间空行）、16（引用块内表）条; 第 7 条则是「多报一处」的已裁定口径, 同样写死。

任务拆分（P1 为本节第一部分）：

- P2 核对与 TUI 表格处理逻辑的一致性: 对照 `TUI/src/app/layout/table.ts`（`splitCells:72-100` / `isDelimCell:116` / `isTableStart:143-149` / `parseTableAt:156-184` / `tableBox:377-400`）与 TUI 两处接入点（`build-box.ts:695-720` 带 `!inFence` 守卫、`pipeline/boxes.ts:295-303` 以游标跳过栅内内容）,逐条核对切分 / 分隔格 / 成表判据 / 数据行收集 / 围栏守卫, 并用同文本实跑两侧判定（含丢格计数）。结论: 切分与围栏口径完全一致（9 条夹具无差异）, 差异集中在成表判据与不等时的报告（分隔行不等 → TUI 退回纯文本; 数据行不等 → TUI 认表但静默丢格）, 均属设计意图; 行内代码竖线两侧同源（都不做代码跨度感知）。详见「调研」S4。
- P3 形态矩阵实测（已完成, 见 S2）
- P4 判定保持不动（按 D1(a); 即本任务不改 `checker.ts` 判定与文案）
- P5 README 增加「已核查形态」表（D2(a)）, 含 ①–⑧ 与 3 个附加形态的「报 / 不报」结论及原因
- P5（按 D6 / D7 展开）断言补齐, 全进 `tests/checker.test.ts`：
  - 应报侧：② 相邻两表（与 TUI 同判为一张, 2 处不一致）; ③ 末尾无尾随换行; ④ 行内代码含竖线; ⑧ 单列表三态; 形态 ①+② 组合（表头 3 / 分隔行 2 / 数据行 4）; 首行即表格（`headerLine = 1`）。
  - 不报侧（钉口径）：⑧ 单列表列数一致; 缺口二（行内代码竖线多报属已裁定口径, 断言写死当前结果）; 表头与分隔行间空行; 引用块内表。
  - 报出侧补充：列表项缩进表（按 D8 也进用例）。
- P7 `tests/main.test.ts` / `tests/tuiParity.test.ts`：按 D2(a) 只在必要处补一条互证（相邻两表与 TUI 同判）; 若判断为不必则不写（偏差节记明）
- P8 验证：`npm --prefix md-table-check run check`、`npm --prefix md-table-check test`、`npm --prefix md-table-check run build`; 真机复验 ≥2 个形态（验收 ④）
- P9 关闭：README 与追踪文档定稿、追踪文档移入 `docs/archived/`、BACKLOG 清理已完成条目（本条目）并保留 2 条新条目

计划改动文件清单：

- `docs/implementation/2026-10-16-three-surface-text-consistency.md`（本文件「任务 B」一节; 收尾整体移入 `docs/archived/`）
- `md-table-check/docs/BACKLOG.md`（接取标「进行中」、追加 2 条新条目、收尾移除已完成条目）
- `md-table-check/README.md`（「已核查形态」小节与边界说明）
- `md-table-check/tests/checker.test.ts`（形态断言补齐）
- `md-table-check/tests/tuiParity.test.ts`（按 P7 结论, 可能改）
- `md-table-check/tests/main.test.ts`（按 P7 结论, 可能改）

明确不做：

- 不改 `md-table-check/src/checker.ts` / `src/main.ts`（D1(a)、D3(a)、D4(a) 下无须改动; 若用户改判 D1(b) 则改 checker 的候选判定与文案）
- 不改 TUI 任何文件（缺口二的跨模块方案不做）
- 不改 `docs/STATUS.md`（用户择时更新）
- 不做「顺手优化」（预筛、文案润色、上限调整）

## 任务 C：rule-engine 检查流程

### 目标

核对 rule-engine 从「会话事件进入」到「注入送达」的处理流程是否正确、口径是否自洽: 事件到节点的映射、回合正文缓冲、`turn/end` 触发条件、规则与消费者收集、节流与去重、注入送达与重入红线、以及 `evaluate` / 注册面 / 规则持久化。逐条给「符合设计 / 缺陷 / 有意不同」结论, 并留可复现证据。约束同任务 A: 检查一律用临时脚本取精确结果, 不以阅读代码作结论。

### 调研

#### S1 处理流程与入口（代码位置, 待脚本核实）

- 入口 `RuleEngine.handle(session, event)`（`rule-engine/src/engine.ts:493`）按 `event.type` 分派, 覆盖 9 类事件: `assistant/message` / `turn/start` / `user/message` / `step/start` / `step/end` / `tool/call` / `tool/result` / `turn/end` / `compaction/end`（`engine.ts:504-580`）。
- 回合正文缓冲: `assistant/message` → `messageText`（`match.ts:106-117`）→ `#buffer`（`engine.ts:588-594`, 单条上限 `TEXT_BUFFER_LIMIT = 20_000`, `engine.ts:67`）; `#needsText`（`:597-601`）决定是否缓冲。
- 触发: `turn/end` → reason ∈ {completed, max-tokens} 才 `#dispatch("assistant-text")` 与 `#dispatch("turn-end")`, 异常收尾只 `#touchScale`（`engine.ts:558-574`）。
- 判定与派发: `#dispatch`（`:623`）收集规则段（`#collectRules`, `:664`）与消费者段（`#collectConsumers`, `:705`）, 统一走节流 / 去重后交 `#write`（`:777`）→ `Injector.inject`。
- 消费者面: `registerConsumer`（`:280`）返回 dispose; 只读判定面 `evaluate`（`:416`）/ `test`（`:445`）; 规则增删改 `add` / `update` / `remove`（`:327-414`）。
- 注入面: `inject.ts`（`buildInjectionMessage:59` / `createAgentInjector:98`）负责推迟宏任务与 host 调用; 文件头载明「不得在 `Session.append` 同步窗口内调 `agent.followup()`」的重入红线。
- 接线层过滤: 子代理会话不参与（`main.ts:41` `isSubagentSession`）。
- 已由任务 A 的实测量到的两处: 单 step 超 20000 截断; `surfaceOp: "replace"` 仍入缓冲（显示侧丢弃）。

### 实现记录

- 2026-10-16 开工, 先做 **P3 `turn/end` 触发矩阵**: 新增 `rule-engine/tests/turnEndMatrix.test.ts`（4 例）, `npm --prefix rule-engine test` 全绿（92 例, 含新增 4 例）。
- 2026-10-16 **P3 实测发现 1 个缺陷**: `reason` 只有「非空字符串」按字面判定; 对象形态（`{ kind: "aborted" }` 等）与 `null` / 数字 / 布尔一律回退为 `completed` → **异常收尾仍会唤醒消费者与规则**, 而同语义字符串 `"aborted"` 正确不唤醒。已登记 `rule-engine/docs/BACKLOG.md` 第 3 条, 并在测试里以「已知缺陷固定」用例钉住现状（修复后反转断言）。
- 2026-10-16 **P1 事件 → 节点映射**: 新增 `rule-engine/tests/nodeMapping.test.ts`（3 例）; 实测到一处既有设计: 同一消费者同时注册 `assistant-text` 与 `turn-end` 时, `turn/end` 只唤醒 `assistant-text`（同尺度 end 对齐合并把 `turn-end` 吞掉）, 只注册 `turn-end` 的消费者不受影响 —— 已在用例里固定。
- 2026-10-16 **P2 缓冲边界**: 新增 `rule-engine/tests/bufferBoundary.test.ts`（6 例）; 固定截断阈值（19999 / 20000 原样, 20001 截到 20000）、空白与换行串照常入缓冲（只跳过长度 0）、多 step `\n` 连接、跨回合隔离; 并固定一条**依赖**: `*-end` 节点的对齐 flag 只由 `*-start` 清, 缺 `turn/start` 时只有第 1 个回合会唤醒（用例「bookkeep 清零点」）。
- 2026-10-16 **P4–P7**: 新增 `rule-engine/tests/throttleAndReadonly.test.ts`（6 例）—— 持久化只读降级（版本不符告警 / `add()` 报「未能落盘」/ 磁盘不改写）、只读面（`list` / `status` / `summaries`）无副作用、`dedupeInRecord` = 1 跳过与 = 0 照旧、每回合上限按注册顺序取第一段、`delivery: "inject"` 请求的路径与来源、无 `summary` 时由正文**空白折叠**出摘要。
- 2026-10-16 另核实两条口径: `turn/end` 的 `reason` 缺省（事件不带 `data` / `data` 非对象）按 `completed` 处理属既有设计（README 已写明）; 真正畸形事件（无 `type` / 空 `type` / 未知 `type` / 无会话 id）安全跳过、不产生注入。

### 偏差

- 无（P1–P7 按规划执行; 未改 `rule-engine/src` 产品代码）。

### 决策（待裁定候选）

> 结论待任务 C 的 P1 / P2 / P4–P7 实测补; 决策项用数字、选项用 abcd。

1. P3 发现的缺陷（非字符串 reason 被当成 completed）: (a) 按上述条目交 rule-engine 侧实现（选定）; (b) 本任务内顺手修; (c) 只记录。理由与任务 A 的处置一致: 本项目级条目的范围是「核对」, 改动交独立条目。
2. P2 发现的依赖（缺 `turn/start` 时后续回合不唤醒）: (a) 视为宿主要求、只在测试与 README 固定（选定）; (b) 另开条目让引擎在缺 `turn/start` 时兜底清 flag。理由: 宿主每回合必发 `turn/start`（`engine.test.ts` 既有用例同口径）; 兜底会改变对齐合并语义, 需单独设计。
3. 结论落点: (a) 缺陷写 `rule-engine/docs/BACKLOG.md`（已执行）; 口径写本追踪文档 + `rule-engine/README.md`（已执行）。

### 收尾

- 核对结论: 1 个缺陷（非字符串 reason, 已登记条目）、1 条依赖（缺 `turn/start`, 已在测试与 README 固定）、其余为既有设计或已覆盖。
- 新增测试 3 个文件（`nodeMapping` / `bufferBoundary` / `throttleAndReadonly`）+ 此前的 `turnEndMatrix`，共 15 例; `npm --prefix rule-engine test` → **107 例全绿**。
- 未做: 追踪文档归档与 BACKLOG 条目清理（与任务 A / B 的归档一起, 待用户确认关闭）。

2. 检查结论的落点: (a) 缺陷写 `rule-engine/docs/BACKLOG.md`、口径差异写 `rule-engine/README.md`（推荐）; (b) 全部只写本追踪文档; (c) 跨包问题写项目级 `docs/BACKLOG.md`。

### 规划

核对方式约束（同任务 A）: 一律用临时脚本取精确结果, 不以模型阅读代码作为结论; 脚本放项目根 `tmp/`, 只读, 收尾按裁定清理。

- P1 事件到节点的映射核对（脚本）: 逐事件类型喂入, 断言触发节点与载荷（`assistant-text` / `user-message` / `tool-call` / `tool-result` / 边界类节点 / `compaction`）; 覆盖未知 type 与非法 data。
- P2 回合正文缓冲核对（脚本）: 同回合多 step 的拼接、单条超限截断、纯空白与空串、跨回合隔离、缓冲修剪（`#pruneBuffers`）与 `#needsText` 的开关行为。
- P3 `turn/end` 触发矩阵（脚本）: reason ∈ {completed, max-tokens, aborted, error, 缺省, 非法值} 各自的派发结果; 确认「异常收尾不唤醒」是否符合设计并有测试。
- P4 规则面核对（脚本）: `assets` / `sources` / `predicates` / `regex` / `keywords` / `directWrite` 的匹配; 边界类节点文本为空时的匹配; 规则增删改与 `evaluate` / `test` 的只读性（不注入、不改状态）。
- P5 节流 / 去重核对（脚本）: `cooldownTurns` / `cooldownMs` / `maxInjectionsPerTurn` / 同回合同正文去重 / `dedupeInRecord`（含 `messagesOf` 缺失时的降级）/ `directWrite` 跳过判断。
- P6 消费者与注入链路核对（脚本 + 假 Injector）: 注册 / 注销 / 多消费者合并成一条; `delivery` 三种路径; 注入请求的正文与 `summary` / `summaries`; 重入红线（同步窗口内不直接 `followup`）。
- P7 持久化与加载核对（脚本）: `stateDir` 运行时层落盘 / 重载 / 只读降级（`readOnly`）与告警; `RULE_ENGINE_STATE_DIR` 覆盖。
- P8 结论与立项: 汇总「符合设计 / 缺陷 / 有意不同」; 需要改动的写成条目（落点见「决策」1）; 与任务 A 的差异 1 / 4 合并处理, 不重复立项。
- P9 收尾: 补「测试与证据」「偏差」, 追踪文档归档, BACKLOG 条目清理。

计划改动文件清单:

- `docs/implementation/2026-10-16-three-surface-text-consistency.md`（本文件「任务 C」一节）
- `rule-engine/docs/BACKLOG.md`（按「决策」1 的裁定追加条目）
- `rule-engine/README.md`（口径说明, 若裁定需要）
- `tmp/rule-engine-*.ts`（核对脚本, 收尾按裁定清理）
- 产品代码默认不改（`rule-engine/src`）; 若用户裁定「本任务内一并修」再补入清单

明确不做:

- 不改 `rule-engine/src` 的产品代码（除非用户改判）
- 不改 `docs/STATUS.md`
- 不重复任务 A 已覆盖的「三面文本一致性」结论（只引用）

### 实现记录

- 2026-10-16 接取条目（状态〔进行中〕）。
- 2026-10-16 P5 断言补齐: `tests/checker.test.ts` 新增「漏检形态筛查」用例组 8 条（形态 ①+② 组合 / ② 相邻两表 / ③ 末尾无尾随空行 / ④ 行内代码竖线 / ⑧ 单列表三态 / 首行即表格 / 不报口径钉住 / 列表项缩进表）; `tests/tuiParity.test.ts` 互证 ⑤ 已在上一条提交补入。
- 2026-10-16 P4 README: 新增「已核查形态（2026-10-16）」表（15 行, 含明确不报的形态与原因）。
- 2026-10-16 P5 补: 新增 `tests/formMatrixSnapshot.test.ts` —— 形态矩阵做成 snapshot 式断言（19 个形态的判定串 + 提示全文整体固定）; 并用变异验证过它确实会红（临时把「分隔行列数不符」的判定加上 `>= 2` 条件 → 8 个用例变红, 含本快照; 还原后 61 例全绿, `git status` 无 `src/` 改动）。
- 2026-10-16 P8 验证: `npm --prefix md-table-check test` → **61 例全绿**; `check` / `build` 因本 worktree 缺 `node_modules`（无 `tsc`）未运行（见「偏差」）。
- 2026-10-16 P9 收尾（部分）: BACKLOG 条目「漏检形态筛查」标「完成」并移除; 原「条目详情 1」随之删除; 2 条缺口条目保留为待办（分别对应本任务已裁定不做的两项）。追踪文档与任务 C 同一份, 归档与条目清理待任务 C 完成后一并执行。

### 偏差

- 验收 ④「真机复验 ≥2 个形态」**未做**真机注入级复验: 未新起真机会话造表。已做的替代验证是形态矩阵实跑（本 worktree, 覆盖 8 个待查形态 + 3 个附加形态）与 TUI 口径互证（`tests/tuiParity.test.ts`）; 结论以 README「已核查形态」表 + 断言承载。
- `npm --prefix md-table-check run check` / `run build` 未运行: 本 worktree 无 `node_modules`（worktree 建后未装依赖, `tsc` 不在 PATH）。测试用 node 类型擦除运行通过（59 例）; 建议在装了依赖的环境补跑 `npm install` + `npm run check`。

### 测试与证据

- `npm --prefix md-table-check test` → `tests 61 / pass 61 / fail 0`（新增 `formMatrixSnapshot.test.ts` 2 例, 加上此前 8 条形态用例与互证 ⑤）。
- 变异验证（证明快照有效）: 临时改 `src/checker.ts` 的「分隔行列数不符」判定（加 `delim.length >= 2`）→ `tests 61 / pass 53 / fail 8`, 含「形态矩阵快照」「形态 ⑧ 单列表三态」「围栏代码块」等; 还原后 61 例全绿, `git status` 确认 `src/` 无残留改动。
- README 新增「已核查形态」表（15 行）; 形态结论与断言一一对应。
- 残留检查: 本任务只改 `md-table-check/README.md`、`md-table-check/tests/checker.test.ts`、`md-table-check/tests/tuiParity.test.ts` 与本追踪文档; 未改 `src/`。

### 收尾

- 回写: `md-table-check/README.md`（已核查形态表）、`md-table-check/docs/BACKLOG.md`（条目标完成并移除）。
- 未做: 追踪文档归档（与任务 C 同一份, 待任务 C 完成后移入 `docs/archived/`）。
- 遗留: 2 条缺口条目（空行分隔表 / 行内代码竖线）留在 `md-table-check/docs/BACKLOG.md` 待办区。
