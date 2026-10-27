# @dsh-toolset/md-table-check

> **状态：2026-10-23 起缺省关闭（下线）。** 本插件的前提是「TUI 只在表头与分隔行列数相等时才渲染表格」，
> 该前提已随 TUI `#3` 修复失效（TUI 改为分隔行列数**只许少不许多**、缺列按左对齐补齐，见
> `TUI/docs/SPEC.md` §3.2 / §15.6）；继续检查只会产生「TUI 本就能渲染」的噪音提示。代码保留，
> 要临时启用把 `cordis.patch.yml` 的 `enabled` 改回 `true`（或 profile 用户 patch 覆盖）。

DSH（DeepSeek Harness）进程内插件：检查**助手回复正文**里的 markdown 表格列数是否一致。不一致时经
`rule-engine` 消费者面注入一条汇总提示，要求模型更正后重新回复。**只报不改** —— 不改回复正文、
不改任何文件、不碰 TUI 渲染。

## 为什么需要

> **注意：本节描述的前提已于 2026-10-23 失效**（TUI 已容错列数不等），保留原文以示本插件的由来。

TUI 只在「表头行 + 分隔行」单元格数**相等**且分隔行每格形如 `:?-+:?` 时才把整块当表格渲染
（`TUI/src/app/layout/table.ts:141-149`）；不等则整表**退回纯文本**，用户看到的是原始竖线文本
（观感即「排版失败」）。即便成对，数据行多格会被静默忽略、缺格会被补空（`parseTableAt:168-176`），
内容丢格却无人报错。仓内原本没有任何自动检查。

## 行为

- 只检查 `assistant-text` 节点（`turn/end` 时派发的整回合助手正文），**只针对回复正文**。
- 表格候选 = 围栏外「表头行 + 分隔行样」；分隔行**不要求**与表头列数相等（这正是要报的情形）。
- 只检查列数不一致：分隔行 / 数据行逐行与表头列数比对。
- 判定与 TUI 同口径重写（`\|` 转义不切、剥除行首尾空单元格、围栏内行跳过），差异仅上面那条放宽。
- 每条回复**汇总一条**提示：表头行号 + 表头摘录 + 期望列数，以及每个不一致行的行号、角色、实际列数。
- 缺省上限：每条最多列 5 张表、每张最多列 3 行；超出以「另有 N 处不一致未列出。」收尾。

注入正文示例（`summary` 恒为 `表格列数提醒`）：

```text
[md-table-check] 上一条回复正文里的 markdown 表格列数不一致（本提示只针对回复正文，与仓库文件无关）：
- 表 1（表头在第 12 行）：`| 包 | 作用 | 状态 |` 期望 3 列
  - 第 13 行（分隔行）：2 列
  - 第 14 行（数据行）：4 列
请修正这些表格后，把上一条回复完整重发一次；不要修改仓库里的任何文件或文档。
```

## 配置

bundle 契约：`name` / `inject: ["ruleEngine"]` / `Config` / `apply`；`ctx.ruleEngine` 不可用时写 stderr
告警并静默降级（不让宿主启动失败）。缺省**开启**（`cordis.patch.yml` 里 `enabled: true`）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否检查；`false` 时仍注册消费者但 `decide` 恒返回 null |
| `sources` | `["assistant-text"]` | 唤醒节点（整回合助手正文） |
| `delivery` | `"followup"` | 注入路径：作为新回合投递给模型 |
| `dedupeInRecord` | `0` | 按记录去重上限；0 = 不限次（每次出现不一致都注入） |
| `maxTables` | `5` | 每条反馈最多列出几个表格（`0` 口径见下「上限为 0 的口径」） |
| `maxRowsPerTable` | `3` | 每张表最多列出几行不一致（同上） |

`src/checker.ts` 另外导出纯函数 `checkTables` / `renderFeedback` / `splitCells` / `hasCellPipe` 与
`CheckOptions.headerExcerptLimit`（缺省 60，`0` 口径见下「上限为 0 的口径」）；判定核心无依赖、无 IO，可被展示层单独复用。

## 边界（明确不做）

- **宽度不足**导致的 TUI 退回（属终端与窗口，非回复缺陷）。
- **伪表格**（有竖线但缺分隔行）识别 —— 正文里带竖线的普通行很常见，误报代价高于收益。
- 自动改写回复正文或任何文件；TUI 侧展示 / 命令面。

## 已核查形态（2026-10-16）

逐形态实跑并落断言（`tests/checker.test.ts` 的「漏检形态筛查」用例组 + `tests/tuiParity.test.ts` 互证 ⑤ + `tests/formMatrixSnapshot.test.ts` 的 20 形态快照）:

| 形态 | 结论 |
| --- | --- |
| 仅数据行列数不符（表头与分隔行一致）/ 表头与分隔行一致但**少于**数据行 | 报（TUI 会忽略多格 / 补空缺格） |
| 分隔行与数据行**同时**不符 | 报两处, 按行号排序（分隔行在前） |
| 同一回复多张表（隔行 / 隔多行）/ 相邻两表（无间隔） | 逐张报, 受 `maxTables` 上限约束；相邻两表与 TUI 同判为**一张表**（连续带竖线的行收进同一张表） |
| 表格在回复末尾（无尾随空行）/ 位于回复首行（前面无空行） | 报；首行时照常检查（表头行号 = 1） |
| 单元格含转义竖线 `\|` / 数据行、分隔行含转义竖线 `\|` | 不切分, 列数一致即不报；按实际格数判（`1 \| 2` 是 1 格）；分隔行的格子不是 `:?-+:?` 形状时整块不算表 → 不误报 |
| 表头含**行内代码里的竖线** | 按字面切分 → 多报一处（**已裁定不修**: 保持与 TUI 同口径, 不做代码跨度感知; **代价** = 代码跨度内的 `|` 会多报） |
| 表格位于围栏代码块内 / 围栏变体（```` ```js ```` info string / 1-3 空格缩进围栏 / 四反引号 / `~~~`）/ 围栏**混用标记**（```` ``` ```` 开 / `~~~` 闭） | 围栏内不报, 闭栅后照常检查（`FENCE_RE` 与 TUI 同源; 4 空格缩进不算围栏 —— 只认 0-3 空格; 混用标记也能闭合: 栅栏行**无条件翻转**, 与 TUI `build-box.ts:702-708` 同口径） |
| 分隔行带对齐标记（`:--` / `:-:` / `--:`） | 对齐标记本身不触发; 只看列数 |
| 分隔行不足 2 单元格（极短表） | 报; 单列表且列数一致时不报 |
| 表头与分隔行之间**有空行** | **不检出**（不算表; TUI 亦不认表）—— 2026-10-16 已裁定不检出 |
| 行尾裸 `\`（转义吞字符到行尾） | 不抛; 切分与 TUI 同形（`splitCells("a\\") === null`、`hasCellPipe("a\\") === false`） |
| 引用块内的表格 / 列表项内缩进表格 | 不报（TUI 引用分支走行内解析, 口径一致）/ 报 |

### 上限为 0 的口径（2026-10-16 起：0 = 不设上限）

- 三个上限参数（`maxTables` / `maxRowsPerTable` / `headerExcerptLimit`）**统一**：`0` = **不设上限** —— `maxTables: 0` 列出全部问题表格、`maxRowsPerTable: 0` 列出每张表的全部不一致行、`headerExcerptLimit: 0` 表头摘录不截断；未设 / 负数 / `NaN` 等非法值回退缺省 `5` / `3` / `60`。
- 实现 = `src/checker.ts` 的 `limitOrInfinity()`（有限非负数按值、`0` 取 `Infinity`、非法值回退缺省）。

## 开发

```sh
npm run check            # 类型检查（两个 program：主 tsconfig + tests/tsconfig.json）
npm run build            # 编译到 dist/（只编本包源与常规测试, 不往他包 src/ 落产物）
npm run check:no-cross-emit  # build 后自检：rule-engine/src 与 TUI/src 里没有未跟踪产物
npm test                 # 八份测试：判定 / 形态矩阵快照 / 与 TUI 源码互证 / 接线 / 真实 rule-engine 端到端注入 / 显示面与注入呈现 / 思考与正文分离 / 三面差分对拍
```

测试文件（`tests/`）：

| 文件 | 覆盖 |
| --- | --- |
| `checker.test.ts` | 判定核心：切分口径 / 列数不一致 / 上限裁剪 / 渲染文案 / 围栏边界与变体 / 裸反斜杠 / 转义竖线行 / 上限为 0 |
| `main.test.ts` | rule-engine 消费者接线：配置归一 / 注册与非缺省四字段透传 / `decide` 两态 / 降级路径（无 ctx、无 `registerConsumer`、注册抛错） |
| `integration.test.ts` | 真实 rule-engine 端到端注入：装载真实 rule-engine 插件 → 取其 `provide("ruleEngine")` 消费者面 → 本插件 `apply` 注册 → 真实注入器送达宿主（坏表 1 次 / 好表 0 次 / 两回合各 1 次） |
| `formMatrixSnapshot.test.ts` | 形态矩阵快照：20 个形态的判定结果（表数 / 行数 / 表头行号 / 期望与实际列数）与提示文案整体固定, 形态结论漂移即变红 |
| `tuiParity.test.ts` | 与 TUI 表格模块互证：切分逐条同口径（含行尾裸 `\`）、成表判据、不等时的走向（退回纯文本 / 丢格）、围栏守卫（正则取 TUI 的 `FENCE_RE`） |
| `displaySurface.test.ts` | 显示面与注入呈现实测：`replace` 跳过、纯空白照常显示、step 直接相接、流式补后缀、notice 折叠为摘要 |
| `reasoningSeparation.test.ts` | 思考 / 正文分离：三条通道分离、`assistant-text` 载荷不含思考、完整消息的 reasoning 不补发 |
| `surfaceDifferential.test.ts` | 三面差分对拍：独立复刻两侧模型 vs 真实 adapter / rule-engine，定向用例 + 确定性随机序列（300 + 2000 条）+ 超限截断 / 非法 reason 的告警断言 |

`tuiParity.test.ts` / `displaySurface.test.ts` / `reasoningSeparation.test.ts` / `surfaceDifferential.test.ts`
用动态 `import` 加载 `TUI/src/app/adapter/dsh.ts`（及 `normalize.ts` / `layout/markdown.ts` 的 `FENCE_RE`）；
TUI 源码不在时（独立分发场景）其用例自动跳过。`integration.test.ts` /
`surfaceDifferential.test.ts` / `reasoningSeparation.test.ts` 直接 import `rule-engine/src/*.ts`，
故**不在**主 tsconfig 的 program 里：

- 主 `tsconfig.json`：`include` = `src` + `index.ts` + 常规测试，`exclude` 掉上述三个跨包用例；
  `rootDir: "."`、`outDir: "dist"` 不变 —— build 不会往 `rule-engine/src/` 落产物。
- `tests/tsconfig.json`：`extends` 主配置、`rootDir` 上移到仓库根、`noEmit`，`include` 整个 `tests/`，
  把跨包用例重新纳入类型检查（`npm run check` 依次跑两个 program）。
- 未用 project references：`rule-engine` 的 `tsconfig.json` 没有 `composite: true`，加引用需要改他包配置
  （超出本包改动范围），故只取「`rootDir` 上移」这一半。

`surfaceDifferential.test.ts` 内的两个复刻模型是**按当前实现口径重述**的独立实现 —— 任一侧实现口径变化时
该文件会变红，属有意的漂移提醒（需重新复刻并对拍）。

接线：根 `package.json` 的 check/build 链、`scripts/test-parallel.sh`、`scripts/install.sh`
（`canonical_pkgs`）与根 `README.md` / `AGENTS.md` 的包清单；条目见 `md-table-check/docs/BACKLOG.md`，追踪文档见
`md-table-check/docs/archived/`。
