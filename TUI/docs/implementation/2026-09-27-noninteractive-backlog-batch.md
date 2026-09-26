# 「不需要交互」分组批次：缩进收窄 / 面板符号化 / 面板 markdown / usage 语义 / 锚定门控放宽（BACKLOG: TUI#3, TUI#4, TUI#6, TUI#9, TUI#11）

状态：调研　　开启：2026-09-27　　关闭：（未关闭）

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

接取范围 = `TUI/docs/BACKLOG.md`「不需要交互」分组中的 **#3 / #4 / #6 / #9 / #11** 五条。

范围裁定（2026-09-27 用户）：

- **#8 剔除**（herdr pane 尺寸偏差，已确认外部问题、TUI 侧无可改点）——不在本任务，留在 BACKLOG 作开放项，等 herdr 修复后单独回归。
- **#1 / #2 / #5 / #7 / #10** 属「需要交互」分组，不在本任务。
- **BACKLOG 状态**：2026-09-27 已把 #3 / #4 / #6 / #9 / #11 标「进行中（2026-09-27）」（用户当日改判，先标状态再推进；#8 保持开放项不动）。
- 本次**只建追踪文档并完成开工前调研，尚未进入实现**（用户要求先按流程推进：标状态 → 调研 → 决策）。

## 目标

五条都是「验证时不需要操作」的改动：看渲染结果、跑自动化、重跑冻结基线即可判定。逐条目标：

| 条目 | 目标 | 分组判据 |
| --- | --- | --- |
| #3 | `messageGutter` 默认 **6 → 4**：回复右缘留白与用户块左缘缩进同步收窄 2 列 | 排版默认值 + 断言，看帧即可 |
| #4 | 面板类型标识符号化（单选 `○` / 多选 `□` / 审批 `△`，均黄），选项标记 `*` / `+` 统一为 `✓` | 面板渲染形态，看帧即可 |
| #6 | 问答题干、审批描述、plan-review `detail` 走既有 markdown 子集渲染（与历史区同口径） | 渲染形态，看帧即可 |
| #9 | `/stats` 补「会话累计」口径（现为「最近一次模型调用」），并把两套口径写进文档 | 内部机制 + 文案，跑命令/看文档即可 |
| #11 | 锚定引导两阶段门控由 `isV4ProModel` 放宽到**全部 `deepseek-*` 模型** | 门控判定，单测即可（flash 真机表现另记残留项） |

## 调研

来源：既有文档（`BACKLOG.md` / `SPEC.md` §7.1 / `DESIGN.md` / `IMPLEMENTATION.md` / `README.md`）+ 源码走查（2026-09-27，行号为当日快照）。

### #3 交错缩进

- 默认值在两处且都写死 6：`src/app/state.ts:96`（`DEFAULT_MESSAGE_GUTTER = 6`）与 `src/main.ts:162`（`num(raw?.messageGutter, 6, 0, 20, "messageGutter")` 的配置缺省）。`state.ts:613-616` 只做下限归一（`max(0, floor)`），不设上限；`main.ts` 的合法域是 `0..20`。
- 该值经 `initialState` → `state.messageGutter` 下传到排版：`src/app/layout.ts:762`（历史区 gutter）与 `:1484`。
- 文档口径写死在注释与示例里：`README.md:81`、`README.md:178`（「默认 `messageGutter: 6` 使输入最长折行的左缘与回复正文**第 5 个字符**同列；要让它对齐第 k 个字符，配置 `messageGutter: k+1`」）、`docs/IMPLEMENTATION.md:151`（口径）、`:156`（回归清单）。
- 受影响断言：`tests/main.config.test.ts:18`（`deepEqual(c, { messageGutter: 6 })`）与 `:22-53`（越界/取整回退）、`tests/layout4.test.ts:39 / :1463 / :1605`（含 `DEFAULT_MESSAGE_GUTTER - 1` 的边界用例 `:1605`）、`tests/content-mapping.test.ts`（回复左竖线阈值 w=6/7 关闭、w=8 开启的边界随 gutter 平移）。
- 冻结基线 `tests/fixtures/focus-frame-legacy.json`（w20 四场景）按现口径冻结，必须重跑 `scripts/freeze-focus-frame.mts` 并审查差异。

### #4 面板符号化

- 类型标识常量：`src/app/components/QuestionPrompt.ts:52-55`（`TAG_PLAN = "[审批]"` / `TAG_MULTI = "[多选]"` / `TAG_SINGLE = "[单选]"`）；标题行在第 8 步组装（`QuestionPrompt.ts:347-359`），形态为 ` △ <tag> 请回答（第 n/m 题）`，tag 段黄色、其余默认前景；plan-review 走 ` △ 计划审批（第 n/m 题）`。
- 审批面板标题：`src/app/components/ApprovalPrompt.ts:21`（`APPROVAL_TITLE = " △ [审批] 等待审批 "`，整行黄）。
- 选项标记：`QuestionPrompt.ts:378` 的 `markFor(multi)` 返回 `+` / `*`；自定义兜底项的标记另行硬编码（`QuestionPrompt.ts:243`，`item.custom === "" ? " " : multi ? "+" : "*"`）。选中的「标记 + 光标」位置参与 `optionLead` 与 `optTextStart = numW + 6`（`:145-146`）的列算，故标记字符改宽会移动内容起点。
- `△` / `○` / `□` **已在符号白名单内**（`src/app/symbols.ts:76 / :99 / :103`；`symbols.ts:125` 已把 `⚠` 归一到 `△`），无需新增白名单条目。
- 宽度风险（实现时必须处理）：`○` `U+25CB`、`□` `U+25A1`、`△` `U+25B3` 属 East Asian Ambiguous，部分终端按 2 列渲染；`tests/width-probe.test.ts:95` 正是拿 `\u25CB` 当「实测 2 列」的样例。而面板组件的换行/列宽用的是 `QuestionPrompt.ts` **本地 `chrW`**（不读 `layout/markdown.ts` 的 `setWidthOverrides` 宽度覆盖表），按 1 列计。→ 实现时要么改为经 `charWidth` 取宽，要么实测确认目标终端下三符号均为 1 列，并把结论写进 SPEC。
- 多题形态待落地：新方案要求**多题**时在活动面板最顶行**单独一行**按题序列出全部问题符号（当前题黄、其余灰），**单题**时符号并入标题行；同时**标题行移除「第 n/m 题」导航**。这会使多题面板的标题区由 1 行变 2 行，直接改动两窗分配的上界：`layoutQuestionPanel` 现用 `maxBody = Math.max(0, height - 1)`（`QuestionPrompt.ts:140`，注释「只剩标题行」），各窗口行数、`maxDescScroll`、caret 行号（`row: 1 + descVisible + …`）都以此为基准。
- 既有断言：`tests/app.test.ts:2522 / :2528`（`>* 1. 生产` / `  * 1. 生产` 的着色行）、`tests/question-wrap.test.ts:153`（`>* 1. 长…` 的绿色行定位）、`tests/question-window.test.ts`、`tests/approval-panel.test.ts`、`tests/fixtures/focus-frame-legacy.json`。
- 不在范围：`src/app/layout/panel.ts` 的 `panelOptions` 通用原语（`*` / `+`，ModelPicker / StatusPanel / 其它列表面板仍在用）——#4 只涉及问答与审批两个面板。

### #6 面板 markdown

- 现状是纯文本 + 单一颜色：问答描述窗用 `QuestionPrompt.ts` 内的 `pushDesc` → `wrapPrefixed`（本地 `wrapByWidth` / `chrW`），行模型为 `PanelLine { text, color?, bar? }`（`QuestionPrompt.ts:64-70`）；审批描述窗用 `ApprovalPrompt.ts:39-49` 的 `approvalLines` + `:187` 的本地 `wrapByWidth`，行模型是裸字符串数组。
- 历史区（同口径目标）走 markdown 解析：`src/app/layout/markdown.ts` 导出 `parseInlineMarkdown` / `wrapFrameSegments` / `wrapCodeLine` / `wrapAssistantLine`（`:748`，签名 `(text, width, themeId)`），由 `src/app/layout/fill.ts:395` 在填充阶段按 `bodyW` 调用，`layout/build-box.ts:301` 说明整段交 `wrapAssistantLine` 解析。
- 结构差异：markdown 路径产出 `FrameSegment[][]`（段级样式），面板路径产出「纯文本 + 整行样式」。要复用就得让描述窗行承载样式段——`layout/panel.ts` 的原语（`panelTitle` / `panelQuestion` / `panelExplanation`）已经是 `styled([seg(...)])` 形态，具备承载能力，缺的是「多段 + 行首 `bar` 列」的组合原语。
- 折行 / 滚动 / 滚动条 / 焦点条（左侧 1 列 `bar`）口径**保持不变**；但 **markdown 解析后的行数会变**（标题去 `#`、列表换 `•`、代码块补灰底、引用加竖线、表格行），两窗分配与 `maxDescScroll` 都以同一份 layout 结果为准（单一来源已具备，不需要额外同步）。
- `detail`（plan-review 计划卡片）**一并渲染**（2026-09-27 用户裁定）；审批 `detail`（计划卡片）口径见 `SPEC.md` §7.1。
- 开放项：`panel.source`（问题前正文，青色，`QuestionPrompt.ts:168-183`）当前是灰色历史正文的复述，是否也走 markdown 未裁定——建议保持纯文本（实现时确认）。

### #9 usage 语义

- `state.usage` 由 `usage` 事件写入（`state.ts:1884-1910`，字段 `input/output/cacheRead/contextWindow`；注释见 `:407-412`），语义注释已写明「**最新一次模型调用**」，不是会话累计；`tokenCalib` 校准也只消费当次真值。
- `/stats`（别名 `/usage`、`/context`）读 `state.usage` 出三段文本（`src/app/index.ts:3082-3103`：`本回合 tokens：输入 … · 输出 … · 缓存读 …` + 上下文占比 + 缓存命中率）；命令表描述在 `src/app/commands.ts:247-252`。
- 宿主侧的累计来源 `ctx.tokenMeter`（`token-meter`，已挂载，见 `docs/host/HOST-PACKAGES.md:121`）提供 `measure(session, requestHeader)` / `estimateMessage`，返回 surface / pressure / nodes——是**上下文计量**而非「逐次调用 token 求和」，接入需要 session 句柄与 requestHeader，成本与风险都高于事件侧累加。
- 既有断言：`tests/stats-rename.test.ts:115-196`（路由 + 三段文案 + `contextWindow` 缺失/为 0 不除零 + 无 usage 提示）。
- 文档口径：`docs/COMMANDS.md`（命令清单）、`docs/SPEC.md`（状态栏/`ctx` 段口径）、`README.md`。

### #11 锚定门控

- 门控三处：`src/app/adapter/tool-bootstrap.ts:30-31`（`ToolBootstrapOptions.isTarget`，默认实现见 `:185`）、`:139-141`（`isV4ProModel = /deepseek-v4.*pro/i`，覆盖 `provider/model` 前缀形态）、`:306`（`if (!isTarget(modelId)) return assembled;` 原样透传）。
- persona 已按模型分叉：`tool-bootstrap.ts:106`（`PERSONA_WEAK_FLASH`）、`:120-123`（`personaFor` 在 weak 模式下 `isFlashModel` ? flash : pro），故门控放宽后 flash 会取 `PERSONA_WEAK_FLASH`——需单测固化，并复核该文案是否仍适用。
- 接线：`src/main.ts:257`（`enabled: config?.toolBootstrap ?? true`），`src/app/adapter/dsh.ts:192-199` 从 `tool-bootstrap.ts` 导入 `personaFor / applyPersona / sessionMode / isV4ProModel / isPromotedFromEvents / installToolBootstrap`。
- 文档口径：`README.md:175`（配置注释「默认 true，仅 deepseek-v4-pro 生效」）、`README.md:180`（机制说明末段）、`docs/DESIGN.md:186`（「门控：仅 `deepseek-v4-pro` 应用；flash 与非 deepseek 模型、`toolBootstrap: false` 时原样透传」）；设计前提句（「V4 Pro 的能力上限由首个 API 请求所见内容决定」）在同一节的 `目的` 段。
- 既有断言：`tests/tool-bootstrap.test.ts:104-125`（`personaFor` 分叉、`isV4ProModel` 判定表）、`:279-281`（自定义 `isTarget` 覆盖）。
- 判定形态待定：新谓词按「模型 id 含 `deepseek`」还是按官方模型族白名单（`deepseek-v4*` + `deepseek-chat` / `deepseek-reasoner` 等）？backlog 原文为「全部 `deepseek-*` 模型」→ 取 `/deepseek/i` 一类判定，并保留 `provider/` 前缀形态（现有正则已支持）；`isV4ProModel` 是否保留导出（既有测试引用）在实现时定。

### 补充调研（2026-09-27 第二轮，开工前的针对性调研）

第一轮是桌面调研（源码走查）；本轮针对「开放决策项」补证。已完成部分：

**#3 缩进收窄（实测：只改默认值即可，`USER_MIN_LEFT_GUTTER` 不动）**

- 观察：`USER_MIN_LEFT_GUTTER = 6`（`src/app/layout/content-rules.ts:31`）除作 `userMaxBodyWidth` / `assistantMaxBodyWidth` 的默认实参外，还作 `build-box.ts:245 / :265 / :307 / :377` 的 `minWidth: USER_MIN_LEFT_GUTTER + 2`（= 8）与竖线可见阈值（w ≤ 7 不画线）。
- 实验（把 `DEFAULT_MESSAGE_GUTTER` 与 `normalizeTuiDisplayConfig` 缺省改成 4 后跑 layout4）：正文右缘留白**确实收窄 2 列**、用户块左缘内移 2 列（实测 `uCol` 23 vs 旧口径 25），`minWidth = 8` 未构成顶托（spacer 可收缩到 4）→ **无需改该常量**；竖线阈值与窄列降级语义保持原样（不在本条范围）。
- 结论：本条只改 `DEFAULT_MESSAGE_GUTTER`、`normalizeTuiDisplayConfig` 缺省、受影响的断言与冻结基线。

**#9 会话边界（原「`/clear`」假设作废）**

- `/clear` **在 TUI 不存在**：只有 `/clearscreen` / `/cls`（`src/app/commands.ts:195`，帮助文案 `src/app/index.ts:3547-3549`「清空缓冲(只清显示，不动上下文)」），`/clear` 早被排除（`docs/COMMANDS.md:43` 指向 `COMMANDS-SPEC.md` §7）→ 原决策项「`/clear` 是否清累计」作废。
- `/clearscreen` 走 `clear-buffer`（`src/app/index.ts:2154-2156` → `src/app/state.ts:1254-1255` 的 `clearBuffer`）：**只清显示缓冲、不动上下文** → 累计不清零。
- 会话切换只有两条路径，即累计的重置点：① `history-resume-ok`（`src/app/state.ts:1554-1577`）——`/session` 面板恢复与 App 的 resumeSession 切换共用（`src/app/index.ts:2658-2710`）；② `session-switch`（`src/app/state.ts:1578-1598`，`/new`）。
- 启动：当前无 `--resume`（属需要交互分组 #2，未做），启动即新会话；`history-resume-ok` 是**唯一**的缓冲水合路径（`src/app/state.ts:1568`）→ 累计只需在这两处清零。

**#11 谓词形态**

- 已知模型 id 形态（仓库内出现）：`deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-v4.1-pro` / `deepseek-v4` / `deepseek-v3` / `deepseek-chat` / `deepseek-reasoner`，以及 `provider/model` 前缀形态（`tests/tool-bootstrap.test.ts:117-125` 已含 `deepseek/deepseek-v4-pro`）。
- `isFlashModel = /flash/i`（`src/app/adapter/tool-bootstrap.ts:115-117`）→ 门控放宽后 flash 在 weak 模式下取 `PERSONA_WEAK_FLASH`（`:120-124`）。
- 谓词只作用于模型 id（`agent.options.model`）；`/deepseek/i` 可覆盖上列全部形态，误判面仅限「非 DeepSeek 模型却带 deepseek 字样的 id」（仓库内无此例）。

**#6 面板 markdown 的两个既有约束**

- 面板叶子**有意不做 markdown 解析**：`src/app/components/ApprovalPrompt.ts:66-72` 注释写明「叶子用 styled/text 段序（不做 markdown 解析，避免 `[y]` 等被误解析）」→ #6 只覆盖题干 / detail / 审批描述，**选项正文与底部按键提示保持纯文本**。
- **风险（新增开放项）**：审批描述含「命令：」+ shell 全文，若整段走行内 markdown，反引号 / `*` / `_` / `[ ]` 会被误解析，**命令显示失真会误导审批判断** → 需定口径（建议：命令段原样纯文本，或整段用围栏包裹）。
- 面板调用点集中（头部行数变化影响面可控）：`src/app/layout.ts:1375`（审批）/ `:1388`（问答）/ `:1599`（caret），App 侧滚动上界 `src/app/index.ts:1918` / `:1926`；问答的两窗分配与 caret 行号都在 `layoutQuestionPanel` 单一来源内。
- 冻结基线含面板场景 `panel-question@w60` / `panel-approval@w60`（`tests/fixtures/focus-frame-legacy.json` 的 15 个场景键）→ #4 与 #6 都会改这两帧。

（#4 符号宽度、#6 块级可行性两条由子代理调研，结论如下：）

**#4 符号宽度（子代理调研 + 用户裁定）**

- `charWidth`（`layout/markdown.ts:439`）判定顺序：实测覆盖表（`setWidthOverrides`，优先级最高）> 零宽 > 文本符号例外 > EAW W/F > A 保守 > emoji 保守 > 默认 1；覆盖表仅由启动探针写入（`src/app/index.ts:405-417` / `:450`，真 TTY + CPR，失败回退静态表）。
- `○` `U+25CB` / `□` `U+25A1` / `△` `U+25B3` 均不在静态表内 → **静态宽度 1 列**（`tests/width-eaw.test.ts:48-51`）；三者已在探针探测集 `DEFAULT_RECOMMENDED`（`src/app/symbols.ts:73-109`）内 → 终端实测为 2 列时覆盖表自动生效。
- 面板两处本地 `chrW`（`QuestionPrompt.ts:426-435`、`ApprovalPrompt.ts:207-219`）不读覆盖表；`fill` 对面板行 `wrap:false` 不折行 → 若终端把符号渲染成 2 列而面板仍按 1 列计，面板行会**真溢出**（`tests/helpers/screenEmu.ts:70` 已按 `displayWidth` 记账）。→ 裁定：面板改用 `charWidth`。
- 连带：符号进入选项前缀/标题后，`optTextStart = numW + 6`（`:145-146`）与 `contIndent`（`:149`）的硬编码列算需按显示列计算。

**#6 块级可行性（子代理调研 + 用户裁定）**

- **表格不可行**：列宽在**构建期**算死（`layout/table.ts:399-409` → `cellLeaf` 固定宽），产物是 Box 子树（`:420`），行数须 measure 后才知，而面板是「先折行成行数组再 slice」→ 中段切片会丢表头 `═`、行间 `─`；入口本就要求已知宽度（`build-box.ts:343`）→ **按 `isTableStart` 检出后退回普通文本行**（即既有降级路径）。
- **代码块条件可行**：逐行 `wrapCodeLine(text, avail)`（`markdown.ts:707`），需面板**自持 fence 状态机**（参照 `build-box.ts:322-339`）；补齐宽 = 面板 `avail = width − 2`，且行首 `bar` 列**不得占用补齐列**（否则吃掉 1 个代码字符）。
- **可行**：行内样式（`wrapFrameSegments`）、标题、引用、列表/任务列表（含悬挂缩进）、`---` 分隔线。
- **复用安全**：解析/折行 API 均为纯函数 + 有界 FIFO 缓存（键含主题与宽度），不与历史区串键；面板**不得**调用 `setWidthOverrides` / `clearWidthOverrides`。签名：`wrapAssistantLine(text, width, themeId): FrameSegment[][]`（`markdown.ts:748`）。
- 最小改动：`PanelLine`（`QuestionPrompt.ts:64-70`）增 `segments: FrameSegment[]`，叶子组装为「bar 段 + 该行段」；选项行仍不解析（沿用 `panel.ts:6-8` 口径）。

## 决策

2026-09-27 用户裁定（本任务的设计前提，实现时不再改）：

| 项 | 选项 | 选定 | 理由 |
| --- | --- | --- | --- |
| #8 范围 | 纳入但不实现 / 剔除 / TUI 侧兜底 | **剔除**，留 BACKLOG 开放项 | TUI 侧无可改点（PTY winsize 由 herdr 决定），纳入只会阻塞任务关闭 |
| #9 交付 | 仅文档化 / 仅实现累计 / 两者 | **两者都做** | 口径与数据都要，否则 `/stats` 仍会被误读为累计值 |
| #4 符号间距 | 1 空格 / 2 空格 | **符号后 2 空格** | 与符号的几何留白更清晰 |
| #4 题号导航 | 标题行保留 / 移除 | **移除**（多题时顶部单独一行列全部题符号） | 避免与符号行重复表达题序 |
| #6 detail | 一并渲染 / 保持纯文本 | **一并渲染** | 题干 / detail / 审批描述统一走一条 markdown 口径 |
| BACKLOG 标记 | 建文档即标进行中 / 暂不标 | **已标「进行中（2026-09-27）」**（#3 / #4 / #6 / #9 / #11 五条；#8 不动） | 用户 2026-09-27 改判：先更新 BACKLOG 状态，再按流程推进 |
| #9 累计来源 | 事件侧累加 / 接 `ctx.tokenMeter.measure` | **事件侧累加**（不接 tokenMeter） | `usage` 事件每次调用即真值（求和即累计），零新依赖、可纯函数单测；`tokenMeter` 是上下文计量（surface/pressure），语义不同且需 session + requestHeader。用户 2026-09-27 确认 |
| 计划外文件扩围 | 同步改注释 / 不改 | **同步改**：`src/app/layout/content-rules.ts:28-30`、`tests/content-rules.test.ts:112` 两处注释 | 仅注释、零行为变化；避免「第 5 个字符」旧口径残留误导（用户 2026-09-27 批准，已补进文件清单） |
| #4 符号宽度口径 | 复用 `charWidth` / 保留本地 `chrW` | **复用 `charWidth`**，删除两处本地 `chrW` 副本 | 调研：三符号静态表均 1 列（基线预期不变），终端实测为 2 列时自动跟随，与 fill / 渲染器 / 屏幕模拟器同源 |
| #4 多题符号行 | 只列符号 / 带题号 / 超宽换行 | **带题号**（如 `1○ 2□ 3△`，题号灰） | 题序信息更明确；仍恒占 1 行、超宽截断 |
| #6 支持面 | 全支持 / 仅行内 / 行内 + 块级（除表格） | **行内 + 标题 / 列表 / 引用 / 分隔线 + 代码块（面板自持 fence 状态机）；表格退回普通文本行** | 调研：表格构建期定宽、行数不可预知 → 不可行；其余块级可复用行级 API |
| #6 命令段 | 原样纯文本 / 围栏包裹 | **围栏包裹成代码块** | 视觉与历史区代码块一致；围栏内不解析，避免 shell 命令被行内语法破坏 |

实现侧设计口径（本文件提出，实现开始时复核一次即可推翻）：

1. **#9 会话边界**（累计来源已定见上表，边界按第二轮调研定）：累计在 **`history-resume-ok`（会话恢复/切换）与 `session-switch`（`/new`）两处清零**；`/clearscreen`（`clear-buffer`，只清显示）**不清零**；TUI 无 `/clear`。实现时把该口径写进 `SPEC.md`。
1. **#4 与 #6 连续实现**（同一批面板渲染改动、同一批冻结基线），避免两次重跑基线；顺序上先 #4（形态）后 #6（内容样式），#6 的行数变化在 #4 定稿的窗口分配上叠加。
1. **#11 只做代码 + 单测 + 文档**；flash 真机表现复核（backlog 明确要求）作为残留项交用户人工确认，不阻塞本任务关闭。
1. **实现顺序建议**：#3 → #11 → #9 → #4 → #6（前三条互不干扰、可独立验收；后两条共享基线冻结）。

## 规划

### 任务拆分

1. **#3 缩进收窄**：改默认值（`state.ts` 常量 + `main.ts` 配置缺省）→ 同步 `README.md` / `IMPLEMENTATION.md` / `SPEC.md` 的「第 5 个字符」口径（改「第 3 个字符」，`k+1` 说明随之）→ 修断言 → 重跑冻结基线。
1. **#11 门控放宽**：新增「全部 `deepseek-*`」谓词并替换默认 `isTarget` → 确认 `personaFor` 对 flash 取 `PERSONA_WEAK_FLASH`（补单测）→ 改 `README.md` / `DESIGN.md` 门控口径与取舍说明 → 补非 deepseek 透传、flash 生效用例。
1. **#9 usage 双口径**：`state.ts` 加会话累计字段 + reducer 累加 + 会话边界清零 → `index.ts` 的 `/stats` 增加累计行（文案区分「本回合」与「本会话累计」）→ `commands.ts` 描述 + `COMMANDS.md` / `SPEC.md` / `README.md` → 补单测（含切会话清零）。
1. **#4 面板符号化**：`TAG_*` / `markFor` / 自定义项标记 → 标题行重排（多题符号行 + 去题号导航）→ 两窗分配上界随标题行数变化 → 宽度口径（`charWidth` vs 本地 `chrW`）→ `SPEC.md` §7.1「标题类型标识」「选项行形态」两条 → 修断言 → 冻结基线。
1. **#6 面板 markdown**：新增/扩展面板 markdown 行原语（样式段 + 行首 `bar` 列）→ 问答描述窗与审批描述窗接入（`detail` 一并）→ `SPEC.md` §7.1 → 补用例（标题 / 列表 / 引用 / 行内样式 / 代码块）→ 冻结基线。
1. **收尾**：五条标「完成」→ 本文件移入 `TUI/docs/archived/` → 按需回写 `DESIGN.md` / `README.md`。

### 计划改动文件清单

> 清单外文件不改；确需扩围时先说明原因与影响，由用户裁定后补进清单。

- 代码（TUI）：
  - `src/app/state.ts`（#3 默认值常量；#9 累计字段 + reducer + 会话边界）
  - `src/main.ts`（#3 配置缺省值）
  - `src/app/adapter/tool-bootstrap.ts`（#11 门控谓词与注释）
  - `src/app/adapter/dsh.ts`（#11 若 import / 导出形态调整）
  - `src/app/index.ts`（#9 `/stats` 文案；#4/#6 若面板调用点需同步）
  - `src/app/commands.ts`（#9 `/stats` 描述）
  - `src/app/components/QuestionPrompt.ts`（#4 标识与标记、标题行、两窗上界；#6 描述窗 markdown）
  - `src/app/components/ApprovalPrompt.ts`（#4 标题；#6 描述窗 markdown）
  - `src/app/layout/panel.ts`（#6 面板 markdown 行原语；`panelOptions` 行为不动）
  - `src/app/layout/markdown.ts`（#6 如需导出/扩展解析入口）
  - `src/app/layout/content-rules.ts`（**计划外扩围，用户 2026-09-27 批准**：仅 :28-30 注释口径）
- 测试与基线（TUI）：
  - `tests/main.config.test.ts`、`tests/layout4.test.ts`、`tests/content-mapping.test.ts`（#3）
  - `tests/content-rules.test.ts`（**计划外扩围，同批批准**：仅 :112 注释口径）
  - `tests/tool-bootstrap.test.ts`（#11）
  - `tests/stats-rename.test.ts`（#9；会话边界用例若落在会话相关测试文件，按其既有归属新增，不新建文件）
  - `tests/app.test.ts`、`tests/question-wrap.test.ts`、`tests/question-window.test.ts`、`tests/approval-panel.test.ts`（#4 / #6）
  - `tests/fixtures/focus-frame-legacy.json`（重跑 `scripts/freeze-focus-frame.mts` 产出，勿手改）
- 文档：
  - `TUI/README.md`（#3 缩进口径、#11 门控与配置注释、#9 若涉及）
  - `TUI/docs/SPEC.md`（#3、#4 §7.1、#6 §7.1、#9）
  - `TUI/docs/IMPLEMENTATION.md`（#3 口径与回归清单）
  - `TUI/docs/DESIGN.md`（#11 门控口径与取舍；#9 若涉及状态字段设计）
  - `TUI/docs/COMMANDS.md`（#9 `/stats` 口径）
  - `TUI/docs/BACKLOG.md`（五条状态：开始实现时标「进行中」，完成时标「完成」；#8 不动）
  - 本追踪文档（唯一过程记录落点）
- 可选（仅在确有必要时动）：`demo/mockAdapter.ts` / `demo/main.ts`（面板场景符号与题干样例——若 demo 需要展示新形态）、`TUI/docs/design/`（若宽度口径需要沉淀为内部约定）。

### 明确不做的部分

- **#8**（外部问题）：不实现、不改 herdr-integration，留 BACKLOG 等 herdr 修复后回归。
- **#1 / #2 / #5 / #7 / #10**（需要交互分组）：不接。
- `layout/panel.ts` 的 `panelOptions` 标记（`*` / `+`）**不改**：ModelPicker / StatusPanel / 其它列表面板沿用现状，#4 只覆盖问答与审批。
- 提问上下文 `source`（面板顶部青色正文）暂不渲染 markdown（除非实现时确认要一并）。
- #9 不接入 `ctx.tokenMeter.measure`（理由见「决策」）。
- #11 不改 `coreFor` 的工具分组、不改 persona 文案，只放宽门控与文档口径。
- 状态栏 / help 相关内容（`state.usage` 在状态栏的 `ctx` 槽位口径不变；help 行数问题属 #7，不在本任务）。
- 人工确认（`AGENTS.md`「变更流程」）与 `STATUS.md` 更新不在本任务内（后者由用户择时处理）。

### 验收方式（「不需要交互」口径）

- 每条：`npm run check` + `npm run test:tui -- <相关文件>.test.ts`，最后统一跑 `npm run test:tui` 全量。
- 视觉类改动（#3 / #4 / #6）：重跑 `node --experimental-transform-types scripts/freeze-focus-frame.mts` 审查基线差异 + `npm run demo -- --smoke`（断言 `SMOKE_PASS`）+ `npm run demo` 目视一轮。
- 产物：`npm run build`。
- 真机：`dsh --profile fff` 重启后目视（#11 的 flash 表现复核另记残留项，属人工项）。
- 按 `AGENTS.md`「变更流程」，产物性改动完成后需人工确认效果，通过后才进入提交询问点。

## 实现记录

- 2026-09-27：按 `docs/WORKFLOW.md` §4「开工时」补齐状态——`TUI/docs/BACKLOG.md` 的 #3 / #4 / #6 / #9 / #11 已标 `**进行中（2026-09-27）**`（mdformat-clean，diff 仅 5 行；#8 未动）。

- 2026-09-27：完成第二轮针对性调研（见「补充调研」），据此把 `/clear` 假设作废、固定 #9 的会话边界、定型 #11 谓词方向、记录 #6 的命令段误解析风险。

- 尚未开始写代码：待「开放决策项」定稿后进入实现（顺序 #3 → #11 → #9 → #4 → #6）。

- 2026-09-27 **#3 完成**（代码 + 文档 + 断言 + 基线）：

  - `src/app/state.ts`：`DEFAULT_MESSAGE_GUTTER` 6 → 4（注释同步「第 5 → 第 3 个字符」）；`src/main.ts`：`normalizeTuiDisplayConfig` 缺省 6 → 4 + 两处 JSDoc 默认值。
  - 断言按新默认改：`tests/layout4.test.ts` 3 处（左边界比较改用 `DEFAULT_MESSAGE_GUTTER`、用例名/回归文案「第 5 → 第 3 个字符」「gutter=6 → 4」）+ 1 处已失效的说明性注释；`tests/main.config.test.ts` 默认值 3 处 6 → 4，并把「小数四舍五入」用例输入由 3.6 改为 9.6（新默认值恰为 4，原输入无法区分「四舍五入」与「回退默认」）。
  - 文档同步：`README.md`（会话流口径、配置示例、缺省说明）、`docs/IMPLEMENTATION.md`（口径 / 列口径 / 两侧同源 / 连带 / 回归五行）、`docs/DESIGN.md`（会话流默认值）。
  - 冻结基线：重跑 `scripts/freeze-focus-frame.mts`，差异只在 w20 四场景各 5 行（均为 gutter 效应），w60 与面板场景零差异。
  - **未改（记录）**：`src/app/layout/content-rules.ts` 的 `USER_MIN_LEFT_GUTTER` 值保持 6（窄列降级最小留白 + 竖线阈值，与默认值各自独立，依据见「补充调研」）；其 :28-30 注释与 `tests/content-rules.test.ts:112` 注释按用户 2026-09-27 裁定同步改写（计划外扩围已获批）。

- 2026-09-27 **#11 完成**（代码 + 单测 + 文档）：

  - `src/app/adapter/tool-bootstrap.ts`：`isV4ProModel`（`/deepseek-v4.*pro/i`）→ **`isDeepseekModel`（`/deepseek/i`）**，默认门控随之切换；文件头「门控」段补「取舍」段（原设计前提基于 V4 Pro 测量、放宽后 flash/chat/reasoner 待真机复核）；`:30` 门控选项注释、`:136` 小节标题、`:176` install 函数注释同步。
  - `src/app/adapter/dsh.ts`：re-export 名单 `isV4ProModel` → `isDeepseekModel`（原符号仅由测试引用、无其它调用点）。
  - `src/main.ts`：`:126` 配置注释与 `:255` 接线注释（「仅 deepseek-v4-pro」→「全部 deepseek-\*」）。
  - 文档：`README.md`（配置注释 + 机制段）、`docs/DESIGN.md`（目的段 + 门控段，含放宽取舍）。
  - 单测：`tests/tool-bootstrap.test.ts` 门控判定表改为 `isDeepseekModel`（v4-pro / v4.1 / v4 / v4-flash / chat / reasoner / v3 / `deepseek/…` 命中；空串 / gpt-4o / qwen3-coder / glm-4.6 / `anthropic/claude-…` 不命中）；「非目标模型（flash）原样透传」改为三条——flash 首请求同样锁定目录 + persona-only、flash + weak 任务取 `PERSONA_WEAK_FLASH` 与 weak 目录（bash+read）、非 deepseek 模型原样透传。

- 2026-09-27 **#9 完成**（代码 + 单测 + 文档）：

  - `src/app/state.ts`：新增 `AppState.usageTotals { input, output, cacheRead }`（必填字段，`initialState` 零初始化）；`case "usage"` 逐次求和；`history-resume-ok` 与 `session-switch` 两处清零（`clear-buffer` / `/clearscreen` 不清）。
  - `src/app/index.ts`：`handleStatsCommand` 改双口径四行——「最近一次调用：…」+「本会话累计：…」+ 上下文 +「缓存命中率：…（最近一次）」；无数据提示改「本会话尚未发生模型调用」。
  - `src/app/commands.ts`：`/stats` 描述改「token 用量：最近一次 + 会话累计（同 /usage /context）」（显示宽度与原文相当，避免 help 换行变化引发脆弱断言）。
  - 文档：`README.md`（命令表 `/stats` 行）、`docs/IMPLEMENTATION.md`（`/stats` 落点行 + 清零边界）；`docs/COMMANDS.md` 2.1 只是索引、无需改；`docs/COMMANDS-SPEC.md:124`（`state.usage` 语义 = 最近一次）仍成立、未动；`docs/SPEC.md` 未记录 usage 字段、未动。
  - 单测：`tests/stats-rename.test.ts` 断言改双口径 + 新增「usage 双口径：会话累计 = 事件求和；会话切换/恢复清零、清屏不清零（TUI#9）」；无 usage 提示文案同步；文件头覆盖说明同步。
  - **途中发现（按流程已追加 BACKLOG）**：会话切换后 `state.usage`（最近一次调用）未清零 → 状态栏 `ctx`/`cache` 段与 `/stats` 首行在切换后会显示上一会话数值。已写入 `TUI/docs/BACKLOG.md` **#12**（归「需要交互」组，待其他 agent 接取），本任务按「计划外不改」不动它。

- 2026-09-27 **#4 完成**（代码 + 断言 + 文档 + 基线）：

  - `components/QuestionPrompt.ts`：`TAG_*`（旧 `[单选]` / `[多选]` / `[审批]`）→ 符号常量 `SYM_SINGLE` / `SYM_MULTI` / `SYM_PLAN` + `SYM_GAP`（符号后 2 空格）+ `OPTION_MARK`（`✓`）；新增 `typeSymOf` 与 `buildSymbolRow`（多题符号行：题号灰 + 当前题符号黄、超宽截断补灰 `…`、恒 1 行不折行）；`QuestionLayout` 增 `symbolRow` / `headerRows`（多题标题区 2 行 → `maxBody = height − headerRows`，caret 行号随之）；标题行改 ` △ ○  请回答`（单题）/ ` △ 请回答`（多题），**题号导航移除**；`markFor` 删除、选中标记统一 `✓`；本地 `chrW` / `displayWidth` 副本删除，改 import `charWidth` / `displayWidth`（列宽与 fill / 宽度探针同源）。
  - `components/ApprovalPrompt.ts`：标题 `△ [审批] 等待审批` → ` △ 等待审批`（类型符号与状态标记 △ 合一、整行黄）；本地 `chrW` 副本删除、`wrapByWidth` 改走 `charWidth`。
  - 断言：`tests/app.test.ts`（新增 `strippedFrame` 助手做跨样式段断言；标题 / 符号行 / plan-review 断言改新形态；`>*` / `+` 标记断言 → `>✓` / `✓`）；`tests/question-wrap.test.ts`（`>* 1. 长` → `>✓ 1. 长`）；`tests/question-window.test.ts`（类型标识用例重写为单题三符号 + 新增「多题符号行」用例：形态 / 当前题黄 / 超宽截断；审批标题断言同步）；`tests/approval-panel.test.ts`（标题断言）。
  - 文档：`docs/SPEC.md` §7.1（「标题类型标识」「选项行形态」两条重写）、`docs/IMPLEMENTATION.md`（标题与选项形态）、`README.md`（问答面板段；模型选择面板的 `*` 属 `panelOptions`，未动）。
  - 冻结基线：重跑脚本，差异仅 `panel-question@w60`（` △ [单选] 请回答（第 1/1 题）` → ` △ ○  请回答`）与 `panel-approval@w60`（去掉 `[审批]`）各 1 行，其余 13 场景零差异。
  - 未做（计划内）：`layout/panel.ts` 的 `panelOptions` 标记；提问上下文 `source` 的渲染口径（随 #6 定）。

## 测试与证据

**#3（已完成）**

- `npm run check`（TUI）：通过（`tsc --noEmit`，无输出）。
- `./scripts/test.sh` 全量：**1142 通过 / 0 失败**。改动前对照：4 个 w20 冻结基线场景失败（`focus-null@w20` / `focus-history@w20` / `focus-activity@w20` / `focus-status@w20`），重冻后全绿。
- 实验证据（改动后、重冻前）：`layout4.test.ts`「输入最长折行左缘与回复正文第 5 个字符同列」实测 `uCol = 23`（旧口径预期 25）→ 用户块左缘内移 2 列；「模型正文右缘保留与用户块左缘对称的空位」实测正文行比旧口径长 2 列 → 右缘留白收窄 2 列。
- 冻结基线差异审查（脚本重跑后逐场景比对）：仅 w20 四场景各 5 行变化，内容为用户块折行点与右缘 `┃` 位置随 gutter 变化；w60 场景与面板场景（`panel-*@w60`）零差异。
- `npm run build`：通过；`npm run demo -- --smoke`：`SMOKE_OK`（无 `SMOKE_FAIL`）。
- 残留检查：全仓检索「第 5 个字符 / 默认 6 / gutter=6」→ 源码、测试、当前文档均已清零（仅历史文档 `docs/archived/` 与 `TUI/docs/BACKLOG.md` 的条目原文保留旧表述，后者是条目规格原文、不改）。
- 未验证：真机 `dsh --profile fff` 目视（`AGENTS.md` 变更流程要求的人工确认环节，需用户执行）。

**#11（已完成）**

- `npm run check`（TUI）：通过。
- `./scripts/test.sh tests/tool-bootstrap.test.ts`：21 通过 / 0 失败（含新增 3 条：flash 走两阶段、flash+weak 取 flash persona、非 deepseek 透传）。
- `./scripts/test.sh` 全量：**1144 通过 / 0 失败**（较 #3 时 +2 条：新增 3 条用例、移除 1 条旧门控用例）。
- `npm run build`：通过。
- 残留检查：全仓检索「isV4ProModel / 仅 deepseek-v4-pro」→ 仅 `TUI/docs/BACKLOG.md` 条目原文（规格原文，不改）与历史文档；源码、测试、当前文档均无残留。
- 未验证：flash / chat / reasoner 的真机实际表现（backlog 明确要求的复核项）→ **残留项**，交用户真机验证，不阻塞本任务关闭。

**#9（已完成）**

- `npm run check`（TUI）：通过。
- `./scripts/test.sh tests/stats-rename.test.ts`：10 通过 / 0 失败（含新增的累计与清零边界用例）。
- `./scripts/test.sh` 全量：**1145 通过 / 0 失败**（较 #11 时 +1 条）。
- `npm run build`：通过。渲染与状态栏口径未变（`state.usage` 语义保持「最近一次」），无需重跑冻结基线。
- 未验证：真机 `/stats` 目视（人工确认环节，需用户执行）。

**#4（已完成）**

- `npm run check`：通过；`./scripts/test.sh` 全量：**1146 通过 / 0 失败**；`npm run build`：通过；`npm run demo -- --smoke`：`SMOKE_PASS`。
- 冻结基线差异审查：仅两处面板标题行（见「实现记录」逐场景比对结论），其余 13 场景零差异。
- 新增/重写用例：多题符号行（形态 `1○ 2□ 3△`、当前题符号黄 / 其余灰、窄面板截断为 `…`）、单题三符号（`○` / `□` / `△`）并入标题行、旧 `[单选]`/`[多选]`/`[审批]` 与题号导航的「已移除」断言。
- 未验证：真机面板目视（人工确认环节，需用户执行）。

**#6**：待实现后补齐。

## 收尾

（待实现后补齐：五条状态、文档回写清单、残留项（#11 flash 真机复核）、是否移入 `TUI/docs/archived/`。）
