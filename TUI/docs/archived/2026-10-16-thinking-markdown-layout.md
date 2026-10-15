# 思考内容排版（块级元素 + 围栏代码块）（接取条目：TUI/docs/BACKLOG.md「思考内容也进行排版（块级元素 + 代码块；行内 markdown 留后续）」）

状态：关闭　　开启：2026-10-16　　关闭：2026-10-16
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

活动区的思考行复用正文的 markdown 排版管线：

1. **块级元素** —— 标题 / 无序列表 / 有序列表 / 引用 / 分隔线 / 任务列表按正文同规格出行（去标记、上色、续行悬挂缩进）。
2. **围栏代码块** —— 思考里的 fenced 块单独样式（不再按普通文本原样露出围栏记号）。
3. **保留思考特有形制** —— 紫 `┃` 前缀与 `minWidth` 缩进、空思考行跳过、与正文互切时插 1 行空行、`/verbose think|tool|step` 档位过滤、`/collapse` 紧凑模式压单行，语义均不变。

## 调研

来源：源码实读（下述 `file:line` 为本工作区当前内容）、既有文档（`SPEC.md` / `DESIGN.md` / `README.md`）、既有测试与夹具。

### 1. 现状：思考行走「纯文本单节点」路径

- `src/app/layout/build-box.ts:192` `buildBox` 的入参：`opts.activityLevel` → `actLevel`（`:211`，缺省 `think`）、`opts.activityCompact` → `compact`（`:209`）、`actPaneW = opts.activityWidth ?? width`（`:212`）、`actText(s, prefixCols)`（`:214`，紧凑模式按 `actPaneW` 压单行）。
- 思考分支 `:474-494`（当前实现）：
  1. `:476` 若在正文 run 内则 `bodyRun.transparent += 1`（穿透行记账）；
  2. `:478` 空思考行 `continue`（流式增量换行锚点）；
  3. `:480` `actLevel !== "think"` 时 `continue`（`/verbose` 档位过滤）；
  4. `:482-488` 建 **`StyledText`**：`styled([{ text: actText(line.text, 1) }], { prefix: { text: "┃", style: { fg: "brightMagenta" }, minWidth: USER_MIN_LEFT_GUTTER + 2 } })`；
  5. `:490` `noteActKind("thinking", rowMeta)`（类型间隔：仅「思考 ↔ 正文」互切插 1 行空行，`noteActKind` 定义在 `:226-240`）；
  6. `:492` 推入 `activityLeaves`。
- `styled()` = `StyledText`（`box.ts:160`）→ fill 侧走 `fillStyled`（`fill.ts:403`）：只做 `splitAndWrapSegments`（`:441`）按列宽折行，**不解析 markdown**；前缀占列在 `:410-412` 扣掉。
- 紧凑模式（`/collapse`）与 `actText` 也是这条路径的一部分：压单行用的是活动 pane 宽，前缀另扣 1 列。

### 2. 对照：正文行走的 markdown 路径

- 正文行建 **`Paragraph`**（`box.ts:140` `text()`）→ fill 侧 `fillParagraph`（`fill.ts:354`）：`wrap:false` 走物理行切分、`fillBg` 走 `wrapCodeLine`（灰底补齐）、其余 `wrapAssistantLine(p.text, bodyW)`（`:388`），其中 `bodyW = rect.w − prefixW − suffixW`（`:361-363`）。
- `wrapAssistantLine`（`markdown.ts:839`）→ `assistantLineRows`（`:849-913`）**块级分类顺序**：分隔线（`─`×w，灰 `border`）→ 任务列表（`[x] ` + 删除线）→ 标题（去 `#`、`bold` + `brightCyan`）→ 引用（隐藏多余 `>`、保留 `> ` 前缀、整体不加斜）→ 普通列表（无序统一 `• `、有序保留数字前缀）→ 行内 markdown。列表与任务列表的续行经 `wrapListRows`（`:822-831`）做悬挂缩进（续行补前缀同宽空格、折宽扣前缀）。
- **围栏代码块**在 build-box 的 assistant 分支自持状态 + 逐行前瞻：`:586-691`（fence 开关行隐藏；紧凑模式只出语言行；非紧凑模式收取围栏内代码行、逐行加行号右缩进并按 `wrapCodeRows` 预折、续行靠右对齐、超宽用 `↩`/`↪` 标记），收取后 `li = closed ? j : local.length - 1`、`inFence = !closed`；**未闭栅**（流式中）时后续行按 `fillBg: true` 直接出灰底（`:754-756`）。
- markdown 表格另在 assistant 分支处理（`:695-722`）：需要可用宽（`width` 未知不识别）、紧凑模式非 final 不建表。

### 3. 行来源：思考行已按物理行拆好，围栏块形状与正文同构

- `src/app/layout/pipeline/rows.ts:261` `boxToLines`：非 user 文本按 `\n` 拆物理行（`:385-388`），并按旧口径剥掉前导 / 拖尾空行（`:377-384`）；因此**思考行每行一条、文本内无内嵌换行**（`user` 才整段一行）。
- `box.shape === "code"` 单独产行（`:326-341`）：` `lang `/ 代码行… /` ` `，每行 `kind` 由 `kindOf`（`:436`，`source === "reasoning"` → `thinking`）确定。
- 结论：思考里的 fenced 块在 build-box 看来就是「连续的 `thinking` 行：fence 开关行 + 代码行 + fence 开关行」，与 assistant 分支前瞻所依赖的形状一致，可在同一分支内复用同一套判定与收取逻辑。

### 4. 不得回归的既有语义（改动须逐条对齐）

- 空思考行跳过（`build-box.ts:478`）；档位 `actLevel !== "think"` 整类不显示（`:480`）。
- 类型间隔只认「思考 ↔ 正文」（`noteActKind`，`:226-240`）；notice / step / shell / 空行不算边界。
- 正文分片连排的穿透记账（`:476` 与 `:723-753`）不因思考行改形态而变。
- `/collapse` 紧凑模式：活动区条目压 1 行（`actText`，`:214`）；`tests/activity-verbose.test.ts` 断言「行数 = 条目数」。
- 后处理对节点类型的要求：`absorbActivityBlank`（`:880`）/ `stripTrailingNewline`（`:902`）/ `nodePlainText`（`:925`）同时支持 `text` 与 `styled`；`lineUpBlockBars`（`:971-982`）**只处理 `user` / `assistant`**（思考不受影响）。
- 活动 pane 宽度：`buildContentRows`（`:1050-1061`）为两个 pane 分别 measure / allocate / fill，活动 pane 用 `activityWidth`；横向排列时两 pane 宽度不同（`SPEC.md` C 节）。

### 5. 文档现状（本次需同步的旧口径）

- `SPEC.md:113`（§3 内容元素映射表）：「思考 | `text(prefix:{┃,紫}, indent:1)` | 左侧紫色竖线区分」——只写前缀，未写是否解析 markdown。
- `SPEC.md:131-155`（§3.1 消息分块排版）+ `:384`（Paragraph 行为）描述的是**正文**的 markdown 两级解析与块级映射表。
- `README.md:183`（模型正文渲染一节）**明写**「只作用于最终回答，**思考过程不渲染**」——本次改动后该句必须改写。
- `DESIGN.md:178`（活动区）讲了档位 / 类型间隔 / 正文分片连排，未提思考行的排版路径。

### 6. 测试与夹具锚点

- 会**失效待改**：`tests/layout4.test.ts` 用例「markdown 子集扩展：• 列表/有序列表/任务完成/引用隐藏 >/thinking 不渲染」——末两处断言「thinking 保持纯文本（markdown 只作用于最终正文）」（`:1844-1861`、`:1866-1868`）。
- 需实测确认**不受影响**：`tests/content-mapping.test.ts:177` 的双轨场景 `thinking-notice@w40g4`（思考文本为纯 ASCII 散文 `reasoning...`，无 markdown 记号；双轨比对含 `ansi` 与 `kind`，须实测逐行等价——若因节点类型切换产生差异，属于「冻结基线重冻」范畴，须先取得用户明确许可）。
- 与思考相关的其余回归面：`tests/activity-level.test.ts`（档位）、`tests/activity-verbose.test.ts`（紧凑行数）、`tests/activity-type-gap.test.ts`（类型间隔 / 正文分片连排）、`tests/pipeline-frame.test.ts`（边界空行竖线）、`tests/layout4.test.ts`（活动 pane 布局）。
- `tests/focus-frame.test.ts` 的冻结场景不含 thinking（已核查场景键：`focus-null` / `focus-history` / `focus-activity` / `focus-status` / `panel-*`）。

### 7. 样式素材（供裁定 3 取舍）

- 标题：`bold` + `brightCyan`（`markdown.ts:793` / `:881`）；引用：`> ` 前缀、正文不加斜（`:891-898`）；任务列表：`[x] `/`[ ] ` + 已完成删除线（`:859-874`）；无序列表：统一 `• `（`:901-910`）；分隔线：`─`×w、前景 `border`（`:851-855`）；代码行：`wrapCodeLine` 主题灰底 `bg:"code"` 并补齐到内容区宽（`:805-815`）。
- 思考当前唯一样式 = 紫竖线前缀；正文是蓝竖线前缀（`brightBlue`）。若块级样式沿用正文配色，思考与正文的区分只剩竖线颜色；若整体降一档（灰色系），区分更强但需新增一套「思考内语义色」。

## 决策

> 条目「接取时裁定」三项，2026-10-16 由用户裁定；选项与理由如下（未选选项保留备查）。

**决策项 1：折行宽度基准**（思考行排版以哪个宽度做块级折行与悬挂缩进）

- 选项 a（**选定**）：**交给 fill 自动**——思考行也用 `Paragraph`，正文宽 = `rect.w − 前缀列`（`fill.ts:361-363`），无需在 build-box 传宽；紧凑模式仍按 `actPaneW` 压行。
- 选项 b（未选）：**build-box 显式预折**——与工具块 / 正文代码块同口径，把 `opts.activityWidth ?? opts.width` 扣掉前缀后传进排版入口。
- 理由：与正文行内路径同源，少一处宽度口径分叉；活动 pane 宽经 `rect.w` 天然正确（横向排列下两 pane 宽度不同），显式预折反而要自行挑宽。
- 附加确认（用户 2026-10-16 追问后裁定）：**回合区不做历史区那套左右对称收窄**——`messageGutter`（默认 4）只落在历史 pane（用户块左缘留白 + 回复右缘 `finalSpace`）；思考行折行宽 = 活动 pane 文字宽 − 左竖线 1 列（比历史区正文宽 4 列）是预期口径，已写入 `SPEC.md` §15.4。

**决策项 2：分类逻辑入口与行内 markdown 范围**

- 选项 a（**选定**）：**直接复用 `wrapAssistantLine`**——思考与正文、面板（`panel.ts:161-186` 的 `panelMarkdownRows`）完全同口径；**行内 markdown 顺带生效**（比条目首期范围多一项：粗体 / 斜体 / 行内代码 / 链接 / 图片占位 / 删除线 / 下划线 / 转义），`markdown.ts` / `fill.ts` / `box.ts` 接口不动。
- 选项 b（未选）：**抽参数化入口**——块级分类共用、行内解析按开关关闭（思考行内记号原样保留）；需在 `markdown.ts` 加开关（含缓存键）、在 `fill.ts` 或 `Paragraph` 上增加分派字段（并同步 `SPEC.md` §2），改动面比 a 多 1 至 3 个文件。
- 理由：复用优先、与既有两条 markdown 路径（正文 / 面板）一致；行内解析只认成对记号（`INLINE_RE`），未闭合 / 歧义的 `**` / `*` 原样保留，思考文本的误改风险低。范围扩张一项已如实记入「偏差」。

**决策项 3：块级样式档位与代码块形态**

- 选项 a（未选）：**沿用正文配色 + 围栏内行灰底**——围栏内行只上 `fillBg` 灰底、不加行号与右缩进（轻量，复用现成 `wrapCodeLine`）。
- 选项 b（**选定**）：**同 a 的配色，代码块与正文完全同规格**——把 assistant 分支的「行号 + 右缩进 + 预折 + `↩`/`↪` 标记」抽成模块级公共构建器 `codeBlockRows`，正文与思考共用。
- 选项 c（未选）：**整体降一档（灰色系）**——需新增思考内语义色映射（本次不做）。
- 理由：两个 pane 里代码块形态一致更易读，抽公共构建器后两处不会再各自漂移；代价是正文围栏分支被重构，要求逐字节不变（由既有 fence 用例与双轨夹具守住）。

## 规划

> 计划改动文件清单按\*\*裁定结果（决策项 1 = a / 2 = a / 3 = b）\*\*定稿；复述通过后动手（用户 2026-10-16 答「继续」）。

### 任务拆分

1. `build-box.ts` 思考分支改走 markdown：非紧凑路径建 `Paragraph`（前缀保持 `┃` + `brightMagenta` + `minWidth`），紧凑路径保持现状（`StyledText` + `actText` 压单行）。
2. 抽出模块级公共构建器 `codeBlockRows(code, lang, avail, bar)`（语言标记行 + 逐代码行：行号 / 右缩进 / 预折 / 窄窗省略行号列），assistant 分支改为调用它（**正文行为逐字节不变**）。
3. 思考内围栏：同分支内逐行前瞻收取围栏内代码行（遇闭栅或非 thinking 行停止），fence 开关行隐藏；思考侧预算 `avail = max(8, (opts.activityWidth ?? opts.width) − 1)`。
4. 类型间隔与穿透记账顺序对齐现状（`noteActKind` 对思考行一律调用，含被隐藏的 fence 行）。
5. 更新失效断言（`tests/layout4.test.ts` 的「thinking 不渲染」用例）。
6. 新增用例（新建 `tests/thinking-markdown.test.ts`）：块级逐行 + 前缀仍紫 + 行内 + 列表折行缩进 + 围栏形态 + 档位 / 紧凑 / 类型间隔回归（6 例）。
7. 文档同步：`SPEC.md`（§3 映射表、§3.1 适用范围、§15.4 留白边界、§15.5 新增一小节）、`DESIGN.md`（活动区）、`README.md:183`。
8. 途中发现的新问题按规则登记新条目（`#9`），不在本任务内改。

### 计划改动文件清单

| 文件 | 改动 |
| --- | --- |
| `TUI/src/app/layout/build-box.ts` | 抽出 `codeBlockRows`（正文 / 思考共用）；思考分支改走 markdown（`Paragraph` + 围栏前瞻）；新增思考前缀与代码块预算常量 |
| `TUI/tests/thinking-markdown.test.ts` | 新建：块级元素 / 行内 / 列表折行缩进 / 围栏代码块与未闭栅 / 档位与紧凑与间隔（6 例） |
| `TUI/tests/layout4.test.ts` | 改写「thinking 不渲染」断言为「思考行同 markdown 子集」（用例名同步） |
| `TUI/docs/SPEC.md` | §3 映射表思考行；§3.1 思考行同口径；§15.4「只作用于历史 pane」；§15.5 新增「活动区思考行的 markdown 排版」 |
| `TUI/docs/DESIGN.md` | 活动区（`:178`）补思考行 markdown 口径 |
| `TUI/README.md` | `:183` 思考行同口径渲染 markdown 子集（表格除外） |
| `TUI/docs/BACKLOG.md` | 条目〔进行中〕标记 + 接取 / 裁定注记；按「途中发现新问题」追加 `#9` |
| `TUI/docs/implementation/2026-10-16-thinking-markdown-layout.md` | 本追踪文档 |

裁定 2 = a 与 3 = b 的落地方式已并入上表：`markdown.ts` / `fill.ts` / `box.ts` **未改**（复用现成入口），公共构建器落在 `build-box.ts` 模块级。

### 明确不做

- 思考内的 **markdown 表格**（跨行列宽约束，成本最高，条目列为后续可选项）：按普通行渲染。
- 思考行的**嵌套 markdown**（多层引用 / 嵌套列表）——沿用正文现状（`README.md:183` 已声明不支持）。
- `/collapse` 紧凑路径的重做（保持单行压缩现状：fence 记号仍原样压行）；`/verbose` 档位语义不动。
- **回合区不加历史区那套左右对称收窄**（用户 2026-10-16 明确「回合区不用做这个效果」）——`messageGutter` 仍只作用于历史 pane。
- 工具块 / notice / shell / 历史区正文的排版不动；不做「顺手优化」（含正文代码块取宽口径问题，只登记为 `#9`）。
- 思考内的行内 markdown：**随复用一并生效**（用户裁定 2 = a），记入「偏差」。

## 实现记录

1. `build-box.ts` 新增模块级 `CodeBar` 类型与 `codeBlockRows(code, lang, avail, bar)`——正文 / 思考共用的围栏代码块构建器（语言标记行 + 逐代码行：行号 2 列 + 空白 1 列 + 代码、续行再缩进 4 列并靠右对齐、`↩` / `↪` 标记、窄窗 < 23 列省略行号列、宽未知退化为单节点）；逻辑逐行照搬原 assistant 分支的构建段，仅改为返回节点数组。
2. assistant 围栏分支改为调用该构建器（`bar` 蓝 `brightBlue`、`avail = width − 1`），采集与消费口径（`li = closed ? j : local.length - 1`、`inFence = !closed`）原样保留。
3. 思考分支重写：空行跳过与档位过滤仍在最前；`compact` 走原 `StyledText` + `actText` 单行路径；非紧凑路径先 `noteActKind("thinking")`（保证类型间隔空行插在内容之前），再按 `FENCE_RE` 分派——fence 开关行隐藏并逐行前瞻收取围栏内 thinking 行（遇闭栅或非 thinking 行停止，闭栅行被收录消费）、普通行建 `Paragraph(prefix: thinkingBar)`。
4. 新增常量：`thinkingBar`（紫 `brightMagenta`、`minWidth = USER_MIN_LEFT_GUTTER + 2`）与 `thinkAvail = actPaneW <= 0 ? undefined : Math.max(8, actPaneW − 1)`；`markdown.ts` 的 `FENCE_RE` 改为导入复用（新增 import）。
5. 测试：新建 `tests/thinking-markdown.test.ts`（6 例）；`tests/layout4.test.ts` 的「markdown 子集扩展 …/thinking 不渲染」用例改名为「…/thinking 同口径渲染」，断言改为「`**粗**` 被消费 → `粗 在 thinking` + bold SGR + 原文记号不再出现」。
6. 文档：`SPEC.md`（§3 映射表思考行、§3.1 加「思考行同口径」段、§15.4 加「只作用于历史 pane」条、§15.5 新增「活动区思考行的 markdown 排版」小节）、`DESIGN.md:178`（活动区补思考行 markdown 口径）、`README.md:183`（改为正文与思考行同口径渲染，注明差异）；`BACKLOG.md` 按「途中发现新问题」追加 `#9`。

## 偏差

1. **范围扩张（经用户裁定）**：条目把「行内 markdown」列为后续可选项，本次按裁定 2 = a 复用 `wrapAssistantLine` 而**一并生效**（粗体 / 斜体 / 行内代码 / 链接 / 图片占位 / 删除线 / 下划线 / 转义）；仍未做的是 markdown 表格（按普通行渲染）。
2. **思考内 fence 状态位未实现**（规划里写的是「思考围栏状态 + 未闭栅后续行按 fillBg 直出」）：实现时确认该状态在非紧凑路径**不可达**——前瞻已把围栏内行全部收录、闭栅行被 `li = j` 消费，未闭栅则 `li = local.length - 1`；与 assistant 分支同构（其 `inFence` 实际只服务紧凑模式的 fillBg 直出）。故按最小实现删掉该状态位与直出分支，未闭栅改为「前瞻收录到末行」。证据：`tests/thinking-markdown.test.ts` 的「未闭栅」用例显示围栏内行仍带行号与灰底（与正文同口径）；思考紧凑路径不跟踪 fence（与改动前一致，条目要求「紧凑语义不变」）。
3. **assistant 分支的两处内联 fence 正则未统一为 `FENCE_RE`**：新思考路径用 `markdown.ts` 导出的 `FENCE_RE`，assistant 侧保留原内联正则（接受集相同）以免正文路径出现无谓 diff；统一留待后续。
4. **正文代码块取宽口径的问题只登记不改**：实现中发现非 final 正文的围栏代码块用对话 pane 宽算预算（横向排列下列宽错位；表格分支已按 pane 分派），按「计划外不做顺手改」只登记为 `#9`。
5. **失效断言实际只有 1 处**（规划写「两处」）：`tests/layout4.test.ts` 的旧注释重复写了一行、断言块只有 1 个；已按 1 处改写（用例名同步）。
6. **真机目视未做**（与既往任务同）：profile `fff` 的 `link:` 指向主检出，本次改动合并后才在真机生效；替代证据见「测试与证据」的代码级取证 + 全量测试 + demo 冒烟。

## 测试与证据

命令与结果（全部在本工作区实跑）：

1. `npm run check`（TUI，`tsc --noEmit`）：exit 0。
2. `sh scripts/test.sh tests/thinking-markdown.test.ts`：6 例全绿（块级 / 行内 / 列表折行缩进 / 围栏代码块 / 未闭栅 / 档位与紧凑与间隔）。
3. `npm test`（TUI 全量）：`tests 1617 / pass 1617 / fail 0`（改动前 1611，新增 6 例）。
4. `npm run build`（TUI，`tsc -p tsconfig.json`）：exit 0。
5. `npm run demo -- --smoke`：42 个 `SMOKE_PASS`、0 个 `SMOKE_FAIL`、末行 `SMOKE_OK`；冒烟帧里可见活动区思考行的紫 `┃`（SGR `38;2;228;188;255`）。
6. **双轨对照**：`tests/content-mapping.test.ts` 的 `thinking-notice@w40g4` 场景（纯文本思考行 `reasoning...`）逐行等价**通过**（比对含 `ansi` 与 `kind`）——说明节点由 `StyledText` 换为 `Paragraph` 未改变纯文本出行；**未触及冻结基线，无需重冻**。
7. **代码级取证**（临时脚本 `tmp/thinking-render.mts`，跑完即删）：同一组思考行（标题 / 无序 / 有序 / 引用 / 任务 / 围栏代码块 / 分隔线 / 行内粗体与行内代码）在活动 pane（宽 48）的出行：
   - 非紧凑：`┃先看要点：` / `┃方案`（bold + 青）/ `┃• 复用正文管线` / `┃1. 抽出公共构建器` / `┃> 注意围栏` / `┃[x] 已确认`（删除线 SGR 9）/ `┃   ts`（斜体 SGR 3）/ `┃ 1 const a = 1;`（灰底 `48;2;39;35;54` + 行号）/ `┃───…`（分隔线铺满）/ `┃行内粗体 与 code`（bold + 行内代码灰底），共 10 行 = 11 行输入 − 2 个 fence 开关行 + 1 个语言行；每行首段均为紫 `┃`。
   - 紧凑 `/collapse`：11 行、逐行原样压行（`┃## 方案` / `┃- 复用正文管线` / ```` ┃```ts ```` …），与改动前语义一致。
   - 档位 `tool`：0 行（思考整类不显示）。
8. 残留检查：临时脚本与运行日志在 `tmp/`（gitignored），关闭前删除；`git status` 的改动范围见「收尾」。

## 收尾

- **回写的文档**：`SPEC.md`（§3 映射表思考行、§3.1「思考行同口径」段、§15.4「只作用于历史 pane」、§15.5 新增「活动区思考行的 markdown 排版」小节）、`DESIGN.md:178`（活动区补思考行 markdown 口径）、`README.md:183`（模型正文与思考行同口径渲染、注明差异）。`STATUS.md` 未改（对照文档由用户择时更新）。
- **遗留项**：`#9`（非 final 正文代码块按对话 pane 宽预折，横向排列列宽错位）已登记进 `TUI/docs/BACKLOG.md`，交其他 agent 接取；`#7` / `#8` 两条 0.1 天的文档旧口径条目与本次无关，仍在清单。
- **归档**：本追踪文档移入 `TUI/docs/archived/2026-10-16-thinking-markdown-layout.md`；`TUI/docs/implementation/` 随之清空（git 不跟踪空目录，目录删除）。
- **BACKLOG 条目清理**：`#4`「思考内容也进行排版（块级元素 + 代码块；行内 markdown 留后续）」已标记完成并**从清单移除**，关闭注记追加到「排序注记」块（含提交号 `c9db3c4` 与剩余编号说明）。
- **提交**：代码与测试提交 `c9db3c4`（4 文件，+506 / −74）；收尾提交含本次文档（`SPEC` / `DESIGN` / `README` / `BACKLOG` / 归档移动）。真机目视按既往口径留到合并后（profile symlink 指向主检出）。
- **临时文件**：`tmp/` 下的取证脚本与日志已删除（`tmp/` 本身为 gitignored 临时目录）。
