# 待修复问题清单（TUI P1–P9 修复批次，已完成归档）

> 归档说明：本清单为 TUI 侧一轮集中修复的问题记录（P1–P9），**全部条目已修复并验证**（`npm run check` / `npm run test` / `npm run demo -- --smoke` 全绿；另做过一次只读独立核对）。仅作历史记录，**不是现状来源**——现状口径见 `TUI/docs/SPEC.md`、`TUI/docs/IMPLEMENTATION.md`、`TUI/README.md`。

> 用途：本轮集中收集「已确认要修」的具体问题（缺陷 / 回归 / 体验问题），按用户口述顺序记录。
> 与 `DEVELOPMENT-BACKLOG.md` 分工：功能级待办与开放项在待办清单；本文件只记本轮修复批次的问题条目，修完标注落点与验证方式。
> 流程：用户口述条目（以「记录」触发落盘）→ 本文件追加或更新条目（**只记录，不改代码**）→ 用户确认「可以」后统一修复 → 回填落点与验证。
> 状态取值：待修复 / 修复中 / 已修复 / 已取消 / 待确认（细节未定，需用户补充）。

## 1. 条目索引

| # | 问题 | 严重度 | 状态 |
|---|------|--------|------|
| P1 | 状态提示符位置的修改（状态栏最左 → 用户输入块首行左侧） | 体验 | 已修复 |
| P2 | 水平状态栏分隔符统一为圆点（去掉组间竖线与小圆点） | 体验 | 已修复 |
| P3 | 行尾真空只作用于两个 pane 的文字行（历史区标记线紧贴边框） | 体验 | 已修复 |
| P4 | 活动区工具行续行缩进由 4 列改为 2 列 | 体验 | 已修复 |
| P5 | 活动区流式思考被空行打断（宿主每步的空白文本块） | 缺陷 | 已修复 |
| P6 | 活动区 step 分割线加时间戳（`hh:mm:ss #XX`） | 体验 | 已修复 |
| P7 | Mode 块符号化并迁入标题栏（含 Ctrl+S 切换垂直状态列） | 体验 | 已修复 |
| P8 | 会话压缩期间算作 active（现在只有 toast，状态仍显示空闲） | 缺陷 | 已修复 |
| P9 | 恢复会话后历史区工具记录丢失、只剩空行（改为按 step 概要恢复） | 缺陷 | 已修复 |

## 2. 条目详情

<!-- 编号 P1、P2…按录入顺序；未采纳的备选方案写在对应条目下方的 HTML 注释里备查。 -->

### P1 · 状态提示符位置的修改

- **现象**：状态提示符（`✓` / `✗` / `● ○` / `△` / `?`）现在渲染在水平状态栏最左，与会话历史里各条用户输入分离——从历史区看不出「这条输入是什么结果」，且符号只反映会话级最后一次提交的状态。
- **触发 / 复现**：启动 TUI 提交任意输入即可看到：符号恒在状态栏首行最左，输入块左侧为空白。
- **期望**：
  - 状态栏最左的符号段整体**移除**（符号 + 其后 `" │ "` 分隔一并去掉），环境组自首列（保留 1 列留白）起。
  - **每个**用户输入块**首行**左侧显示该条输入自身的执行结果，位置就是块左侧缩进腾出的空白里，紧贴文本首字符左侧并隔 1 个空格（`符号 + " " + 文本`）。用户块排版（折行、整块右对齐、右缘 `┃`、左 gutter 留白）**不变**。
  - 取值：成功 `✓` 绿（`green`）／失败 `✗` 红（`red`）／**中止 `■` 实心方块 灰（`gray`）**／无终态 `?` 默认前景。
  - 只有**最新活跃块**显示进行中 `●`/`○`（沿用现有虚拟 token 交替机制）与等待交互 `△`（黄）；历史块只显示各自终态，不交替、不出现 `△`。
  - 排队块（灰 `┃` 未发出）不显示符号。
- **影响面**：`TUI/src/app/layout.ts`（`STATUS_SYMBOL` / `STATUS_SYMBOL_COLOR`、`renderStatusLine` 的 lead 段与 `maxSegW` 的 5 列占位）、`TUI/src/app/layout/build-box.ts`（user 块首行前缀，落在既有左侧 spacer 空白里）、`TUI/src/app/state.ts`（需新增 per-block 状态记录，现仅有会话级 `inputStatus`）；文档 `TUI/docs/design/DESIGN.md` §状态区、`TUI/README.md`、`TUI/docs/design/AUDIT-colors.md`；冻结帧基线 `TUI/tests/fixtures/focus-frame-legacy.json` 需重新生成。
- **口径补充**：turn 中止归 `■` 灰（原议空心方块，已改）；`?` 用于「已进历史区但未收到终态」的块。
- **状态**：已修复

### P2 · 水平状态栏分隔符统一为圆点

- **现象**：水平状态栏里两种分隔符并存——**组间**是 1 列 `│`（border 色，由 Box separator 产出，并在状态栏上/下横线画 `┬`/`┴` 与竖线「相接成格」）；**组内**逻辑段之间是 1 列 `·`（默认前景色，无空格），如 `time·git·cwd`。
- **期望**：
  - 分隔符**全部统一为 `•`（U+2022，较大圆点）**：组间由 `│` 换成 `•`，组内原 `·` 一并换成 `•`；均为 1 列、无空格、默认前景色（与组内圆点同色，不再用 border 蓝）。
  - 状态栏内部不再有竖线：`statusBarSeamCols()`（只认 border 色段里的 `│`）自然扫不到 seam，状态栏上/下横线的 `┬` 交点随之消失，无需专门改。
  - 来自**别处竖线**的交点保留：D 列（状态列右缘）与内部分隔列（历史/活动区之间）的 `┴` 不属于状态栏分隔符，维持现状。
  - 折行口径不变：折行处不留尾巴圆点，续行行首不加圆点（维持现有 1 空格留边）。
  - 范围：只动**水平状态栏**；竖直状态列（Mode 块由 P7 移除，其余内容不动）与各面板框线均不动。
- **影响面**：`TUI/src/app/layout.ts`（`dotJoin` 的 `·`（:2046）、行组装的 Box `separator: { char: "│" }`（:2090）、`maxSegW` 里组间 1 列 gap 的预算口径、`statusBarSeamCols`（:2103）、`buildStatusSeparator`（:2420）与 `topSeams`（:2624））；文档 `TUI/docs/design/DESIGN.md` §状态区（组间框线与 `┬`/`┴` 相接成格的描述）、`TUI/README.md`（状态栏分隔说明）、`TUI/docs/design/AUDIT-colors.md`（分隔列与框格连接字 `│ ┤ ┬ ┴` 的列举）；冻结帧基线 `TUI/tests/fixtures/focus-frame-legacy.json` 与状态栏相关测试需同步更新。
- **关联**：与 P1 同属状态栏改造。P1 移除最左符号段（含其后的 `" │ "`）后，状态栏里剩下的竖线就只有组间分隔符，P2 把它一并换掉。
- **状态**：已修复

### P3 · 行尾真空只作用于两个 pane 的文字行

- **现象**：为字符宽度估算误差设计的兜底留白，实现成了「按 pane 缩文字宽」——横向排列两 pane 各让 1 列、纵向排列两 pane 各让 2 列（`TUI/src/app/layout.ts:486` 的 `paneTextWidth(paneW, stacked)`）。后果：横向排列时历史区用户块的 `┃` 与内部分隔竖线之间空出 1 列（实测 `cols=100`：`┃@63`、分隔线 `│@65`）；纵向排列时文字右缘比可用位置少 1 列（`┃@96`，本可到 97）。
- **期望**：
  - 兜底留白改为**行尾属性**：历史区 / 活动区的**文字行**最多写到 `cols-3`，最后的 2 列（`cols-2`、`cols-1`）**完全不写**（不是补空格）。
  - **横向**：历史区文字宽 = `dialogueW`（不再 −1），用户块 `┃` **紧贴内部分隔竖线**（间隔 0）；活动区文字宽维持 `activityW-1`（右缘到 `cols-3`）。
  - **纵向**：两个 pane 文字宽 = `paneW-1`（不再 −2），文字右缘到 `cols-3`；右侧没有边框线，直接接真空。
  - **横线照旧顶满**到最右列：标题栏下划线、回合分隔线 `╌`、状态栏上/下边框、活动区分隔线不受影响。
  - 范围：只改历史区 / 活动区的**文字行**；状态栏文字、输入区、按键提示区、状态列不动（补不补空格随意）。
- **实测数值**（`cols=100`，现状 → 目标）：纵向两 pane 文字宽 64 → 65；横向历史 31 → 32（`┃` 63 → 64，紧贴 `│@65`）、活动 32 不变。文字宽变化会带动两 pane 的折行位置。
- **影响面**：`TUI/src/app/layout.ts`（`PANE_TEXT_MARGIN_COLS`（:482）与 `paneTextWidth`（:486）、`frameGeometry` 里 `dialogueTextW` / `activityTextW` 的取值（:828）、文字行拼装处的补齐与行尾处理 `padTo`）；文档 `TUI/docs/design/DESIGN.md:154`、`TUI/docs/IMPLEMENTATION.md:134`（「横向各让 1 列、纵向各让 2 列」的口径）；`tests/pane-text-margin.test.ts`（`paneTextWidth` 断言与「文字不落在留白列」）与冻结帧基线 `TUI/tests/fixtures/focus-frame-legacy.json`。
- **关联**：与 P1 同处用户块首行（`┃` 与符号的相对位置需一起验证）；与 P2 同属顶部区域框线口径（本条保留横线顶满到最右列）。
- **状态**：已修复

### P4 · 活动区工具行续行缩进 4 → 2

- **现象**：活动区里工具调用行（含参数内显式换行）的续行统一悬挂缩进 4 列（`TOOL_CONT_INDENT = 4`）。实测（`cols=100`、纵向、活动区正文起列 33）：工具行首行 @33、**续行 @37**。活动区其它行的续行不是空格缩进——思考与模型正文的续行是把 `┃` 前缀重复到行首（仍在 33），不属本条。
- **期望**：工具行续行悬挂缩进改为 **2 列**（续行 @35）；参数内显式换行后的各行同口径。思考 / 模型正文续行、markdown 列表悬挂缩进均不动。
- **影响面**：`TUI/src/app/layout/content-rules.ts:50`（`TOOL_CONT_INDENT` 常量与「统一 4 空格对齐」注释）、同文件 `wrapToolCallText`（:59，续行折行宽度按同一常量扣减）、`TUI/src/app/layout/build-box.ts:181`（工具节点 `hanging: TOOL_CONT_INDENT`）；断言 `TUI/tests/content-rules.test.ts:95`（`TOOL_CONT_INDENT === 4`）与 `TUI/tests/tool-call-wrap.test.ts` 的缩进用例；文档 `TUI/docs/SPEC.md:110`（映射表 `hanging:4` / `TOOL_CONT_INDENT=4`）；含工具行折行的冻结帧基线（`TUI/tests/fixtures/*.json`）按需重生成。
- **关联**：与 P6 同属活动区排版（两条都改活动区行的边缘）。
- **状态**：已修复

### P5 · 活动区流式思考被空行打断

- **现象**：活动区里流式思考文本被空行打断，例如 `┃I need to check the docs to` 之后出现 3 条空行，再接 `┃fix the title link.`。
- **根因**：宿主**每个 step 都发一个「只有换行」的文本块**——实测本会话日志（`~/.dsh/sessions/…/session.v3.jsonl.zstd`）181 个 step、190 个文本分片里 **154 个就是 `"\n\n"`**；TUI `appendStream`（`TUI/src/app/state.ts:720`）按字面落行：`"\n\n"` 被 `split("\n")` 成 3 个空串，而上一行是 `thinking`（kind 不同、不合并）→ 往 buffer 塞 **3 条空 assistant 行**，活动区照原样渲染；若这段空行后面直接跟最终正文（中间无工具行），还会被 `markFinalSummary` 标成 final 进历史区。
- **期望（本轮只做降级版 A′）**：**仅当流式分片整段为空白、且上一行是异 kind（思考 / 工具 / notice / 用户行 / 分隔线）或 buffer 为空时，丢弃该分片**（不产生空行）。同 kind 内部的空白分片维持现状（软换行 / 段落空行语义不变）；**不做段尾空行清理**。
- **复现**（临时脚本，修复后已清理）：曾用 `tmp/repro-thinking-break.mjs` 复现；现由 `TUI/tests/p5-blank-chunk.test.ts` 覆盖。
- **影响面**：`TUI/src/app/state.ts` 的 `appendStream`（:720 起的分片落行逻辑；过滤放在 state 层，不动 adapter 与宿主）；测试补 state 层用例（`TUI/tests/app.test.ts` 现有 appendStream / 活动区渲染断言附近），含该场景的冻结帧基线按需重生成。
- **状态**：已修复

<!-- 备查：讨论中未采纳的完整方案 A（2026-09-24），本轮只做 A'（见 P5 期望），需要时再上：
     步骤 1：仅空白分片照旧累加空行（保住段内语义： "a" + "\n\n" + "b" = a / 空 / b；"a" + "\n" + "b" = a / b）。
     步骤 2：当同一 kind 的连续行段被「终结」时，丢掉它【尾部】的空行（段内空行不动）。终结 = 出现异 kind 行、turn 开始/结束、活动区清理。
     三例（现状 → A）：思考A + "\n\n" + 思考B：3 空行 → 紧接；正文 para1 + "\n\n" + para2：不变（段内空行保留）；正文… + "\n\n" + 工具行：留空行 → 紧接。
     与 B（一律丢弃仅空白分片）的区别：B 会把同一条回复内的段落空行也丢掉、两段并成一段，A 只在段尾丢。
     副作用：回复末尾空行被吃掉（无信息损失）；工具行之后正文的前导空行被丢（本就是要的效果）；只作用于同 kind 尾部空行，用户块 / 分隔线 / notice / 排队块不受影响；需在异 kind 与回合边界各做一次 O(尾部空行数) 检查；会改动含空行的冻结帧基线与渲染断言。
     降级版 A'（本轮采纳）：只做「仅空白分片 + 上一行异 kind → 丢弃」，不做段尾清理；代价是「正文尾部 "\n\n" 后跟工具行」这类仍会残留空行。 -->

### P6 · 活动区 step 分割线加时间戳

- **现象**：step 分组头没有时间信息。现状是合成行——`state.ts:865 appendStepToolLine` → `tool-line.ts:39 stepHeaderLine(step)` 产出文本 `"step N"`，`build-box.ts:170` 渲染成 `╌╌ step N ` + 尾部 `╌` 铺满；该行只存在于实时活动区（不进 buffer 持久化、恢复历史不重建），因此只影响进行中的回合。
- **期望**：行格式改为 **`╌╌ hh:mm:ss #XX ` + 尾部 `╌` 铺满**——前缀仍是 2 个 `╌` 加 1 空格，`XX` 为 step 号原样（不补零），24 小时制 `hh:mm:ss`；例：`╌╌ 22:31:05 #3 ╌╌╌╌╌…`（线型沿用现有 `╌`，不换字符）。
- **时间来源**：优先宿主事件 `time`（事件信封必填字段，`docs/host/DSH-CTX-API.md:42`，Unix epoch 毫秒，按本地时区格式化）；取不到时回退 `Date.now()`（只会发生在 mock/demo 合成事件与测试直接 push 的事件上）。**不设 `--:--:--` 占位**。
- **落地路径**：`step/start` 归一化（`adapter/dsh.ts:1635`）补上 `time` → `DshEvent` 的 `step` 分支增时间字段（`adapter/types.ts`）→ App 的 `case "step"`（`index.ts:1012`）透传 → reducer 存入 `state.stepGroup`（字段定义 `state.ts:428`、写入 `state.ts:1771`）→ `stepHeaderLine(step, time)` 产出 `"22:31:05 #3"` → `build-box.ts:170` 的 step 正则与 `content-rules.ts:99` 的 `"step "` 前缀判定同步改。
- **影响面**：`TUI/src/app/layout/tool-line.ts`、`TUI/src/app/layout/build-box.ts`、`TUI/src/app/layout/content-rules.ts`、`TUI/src/app/state.ts`、`TUI/src/app/adapter/dsh.ts` 与 `adapter/types.ts`、`TUI/src/app/index.ts`、`TUI/demo/mockAdapter.ts`（4 处 step 事件走回退分支即可）；测试：step 分组头相关用例与含 step 行的冻结帧基线；文档 `TUI/docs/design/DESIGN.md:213`（接口对照里的「分组头 `step N`」）、`TUI/README.md:88`（`╌╌ step N ╌╌╌…`）需同步。
- **关联**：与 P4 同属活动区排版；本行时间戳是界面上**第一个按行的时间标记**（现状只有状态栏环境组的本机时钟）。
- **状态**：已修复

### P7 · Mode 块符号化并迁入标题栏

- **现象**：状态列的 Mode 块以**文字**罗列各状态变量——`plan ✓ | bell ✓ | verbose ✓` / `preset fff | symbol-unify ✓` / `policy ask auto` / `sandbox ro wr full` / `permission ro wr full`（实测状态列文字宽 31 时占 **6 行**）；其中 `permission` 的取值由 `sandbox` + `policy` 组合决定，属冗余展示。
- **期望**：
  - **符号化原则**：符号 = 状态变量，颜色 = 取值；不再显示可选项列表与缩写。各项取值如下（字形均为 Nerd Font 图标，本机 `Maple Mono NF CN` 已验证；BMP 与 plane 15 均可用，宽度实测各 1 列）：
    | 项 | 符号与颜色 |
    |----|-----------|
    | `sandbox` | `ro` 绿 `fa-box`（U+ED75）／`wr` 黄 `fa-box_open`（U+ED95）／`full` 红 `fa-box_open`／其它值 灰（先如此，遇到自定义值再说） |
    | `policy` | `ask` 黄 `md-chat_question_outline`（U+F1739）／`never` 绿 `md-chat_remove_outline`（U+F1414） |
    | `plan` | `fa-route`（U+EDA6）：`on` 默认前景／`off` 灰 |
    | `verbose` | `md-text_long`（U+F09AA）：同上 |
    | `symbol-unify` | `md-spellcheck`（U+F04C6）：同上 |
    | `bell` | `md-bell_ring_outline`（U+F009F）：同上 |
    | `preset` | `md-puzzle_outline`（U+F0A66）**+ preset 名字**（如 ` fff`），统一默认前景色 |
    | `permission` | **不再显示** |
  - **迁入标题栏开头**（历史区顶部那一行；下划线行不变）：
    ```
     fff  ◇ ◇ ◇ ◇ ◇ ◇   <2 空格>  会话标题
    ──────────────────────────────────────
    ```
    顺序 = `preset`（符号 + 名字）→ 六个状态符号（`sandbox` `policy` `plan` `verbose` `symbol-unify` `bell`）→ 2 空格 → 标题文本；**段间与符号组内部一律用空格**（不用圆点）；空标题仍显示灰色 `<title>` 占位以保持行稳定。
  - **宽度不足时的让位顺序**：① **先隐藏 `preset`**（整体，含名字）→ ② 再截断标题（可截到空）→ ③ 仍放不下则六个符号**整体**让位 → ④ 沿用现有的「极矮终端先收下划线、再整栏省略」。
  - **Mode 块整体移除**：垂直状态列不再有 `Mode` 标题行与上述各项（Goal / Todo / Jobs 块保留）。
  - **水平状态栏不新增任何内容**（本条与状态栏改造 P1/P2 无交叉）。
  - **Ctrl+S 切换垂直状态列**：切换显示 / 隐藏，**初始显示**；隐藏时该列宽 0、分隔竖线（D 列）不再绘制、历史区变宽需重排；切换状态**随会话持久化**（写 `tui-state.json`，与 `verbose` / `symbol-unify` 同口径）；按键提示行加 `[Ctrl+S]状态列`。
- **现状取证（实测，`cols=100`）**：Mode 块 6 行；`charWidth` 对所用图标均返回 1；标题行渲染在 `layout.ts` 的 `rc === 0` 分支、现以 `truncateToWidth(rawTitle, contentW)` 截断；raw 模式已关 `IXON`，`Ctrl+S`（0x13）可作为按键到达 App，不与现有 `Ctrl+D`/`Ctrl+L`/`Ctrl+J`/`Ctrl+C` 冲突；`SessionUiState`（`adapter/session-ui-state.ts:22`）已有 `verbose`/`symbolUnify`/`modes` 字段，可加一个布尔字段承载状态列开关。
- **影响面**：`TUI/src/app/layout.ts`（`modeBlock`（:1144）退役；标题行 `rc === 0` 分支改为「preset + 符号组 + 标题」三段拼接与按让位顺序的截断；`titleRows` 与极矮兜底路径；状态列宽为 0 时的几何/拼接路径）、`TUI/src/app/state.ts`（新增状态列可见性状态与 action）、`TUI/src/app/adapter/session-ui-state.ts`（`SessionUiState` 增字段）、`TUI/src/app/index.ts`（Ctrl 分支加 `Ctrl+S`（:1556 一带）、会话状态恢复与落盘（:615-660）、提示行文本）；文档 `TUI/docs/design/DESIGN.md:151`（状态列 Mode 块描述）、`TUI/README.md:72-74`（会话标题栏说明）、`TUI/README.md:88` 一带、必要时 `TUI/docs/SPEC.md`；冻结帧基线 `TUI/tests/fixtures/focus-frame-legacy.json` 与状态列/标题栏相关测试需重生成或更新。
- **关联**：与 P4/P6 同属状态列与活动区之外的顶部区域改造；与 P1/P2 **无交叉**（早先草案曾计划迁入水平状态栏，已废弃）。
- **状态**：已修复

### P8 · 会话压缩期间算作 active

- **现象**：宿主 `compaction/start` → `compaction/end` 期间，TUI 只发两条 toast（「正在压缩上下文…」/「压缩完成」，`state.ts:1660`），**不改任何活跃状态**——`agentStatus` 仍是 idle、`inputStatus` 不变，这段时间界面上看不出「正在忙」。
- **期望**：压缩进行期间把该会话视为 **active**（与 agent 正在跑同义），压缩结束后恢复原状。
- **口径待定（修复时确认）**：哪些行为按 active 处理——① 状态符号显示「进行中」（黄 `●`/`○` 交替，而非绿/红/`?`）；② 新提交消息走**排队**（`agentBusy()`）；③ `Ctrl+D` 退出守卫不触发（该守卫要求 idle）；④ `Esc` 的中断语义；⑤ 与 P1（用户块状态符号挂在最新用户块）、P7（标题栏符号区）的交互。
- **相关判据点**：`TUI/src/app/index.ts:1550`（Ctrl+D 守卫）、`:1599`、`:1855-1857`（`agentBusy()`）、`:1904`（发送时排队判据）；`TUI/src/app/state.ts:902`（`statusFor`：忙时不接受绿/红结果覆盖）、`:1660`（compaction reducer）。
- **影响面**：`TUI/src/app/state.ts`（compaction reducer 与活跃状态判据）、`TUI/src/app/index.ts`（上述四处判据）；测试需补 compaction 期间的行为断言。
- **状态**：已修复

### P9 · 恢复会话后历史区工具记录丢失、只剩空行

- **现象**：加载保存的会话（resume / `/session` 切回）后，此前的**工具调用记录全部丢失**，历史区只剩成片空行。
- **根因**（已核实）：恢复读面用的是 `readSurface`（**当前模型表面**，只含 user/assistant 消息，`adapter/dsh.ts:911`），且 `normalizeHistoryMessages`（`:275`）用 `extractTextBlocks`（`:258`）**只取 `type === "text"` 的内容块**、其余（`tool-call` 等）按注释省略；只在工具调用的 step 其文本块为空（即流式里的 `"\n\n"`，见 P5）→ `surfaceToBuffer`（`commands.ts:63`）照样按行 push，历史区出现空行。**注意：宿主侧记录是完整的**——`tool/call` / `tool/result` 是独立事件且带 `seq`/`time`，`readSession(id)` 返回完整可重放日志；官方 web 端（`dsh-client-ui-trajectory`、`dsh-client-ui-chat`）也是自己在客户端折叠这些事件，但那层不是公共 seam，TUI 需自实现精简版。
- **期望（概要级恢复）**：每个 step 折成**一行摘要**，复用活动区 step 线型（与 P6 同族）：
  ```
  ╌╌ 22:31:05 #3 ╌╌ read ×2, bash ×1 ╌╌╌…
  ```
  - 内容 = 时间（`step/start` 的 `time`，缺失则省略）＋ 步号 `#N` ＋ 该步工具调用**名字去重计数**；失败结果标 `✗N`；
  - **不带参数摘要、不带结果详情、不含 thinking**；无工具调用的 step（纯思考 / 纯正文）不出行；
  - **空文本不再产出空行**（独立于粒度，必须一起修）；
  - **不做**逐条工具行的完整还原（参数/结果内容不恢复）。
- **数据来源**：改用 `readSession`（完整事件日志）或 `listEvents`（可按 seq/时间/类型过滤）替代 `readSurface`；工具名取 `tool/call`、失败取 `tool/result` 的 `ok`、分组与时间取 `step/start`（`turn/start` 可用于回合归属）。
- **影响面**：`TUI/src/app/adapter/dsh.ts`（读面选择 `:911`、`normalizeHistoryMessages` / `extractTextBlocks`）、`TUI/src/app/commands.ts`（`surfaceToBuffer` 的 kind 收窄与空行处理）、`HistoryMessage` 类型可能需扩展（携工具摘要与 step 信息）；测试补 resume 场景断言（含「只含工具调用的 step 恢复成一行摘要、无空行」）；文档如需提及恢复口径再补。
- **关联**：与 **P6** 共用 step 行的形态与时间来源（恢复行与实时行应尽量一致）；与 **P5** 同源（空文本块的来源都是宿主每步的 `"\n\n"`）。
- **状态**：已修复

## 3. 修复记录

> 修复批次：A（P4/P5/P6）→ B（P2/P3/P1）→ C（P8/P7）→ D（P9），每批 `npm run check` + 相关测试后进入下一批；全部完成后重生成冻结帧基线并跑全量测试。

| # | 落点（源码） | 测试/验证 |
|---|--------------|-----------|
| P4 | `layout/content-rules.ts`（`TOOL_CONT_INDENT = 2`，注释与 `wrapToolCallText` 折宽同步） | `tests/content-rules.test.ts`、`tests/tool-call-wrap.test.ts`、`tests/app.test.ts`（tool-call 续行 2 空格）；`TUI/docs/SPEC.md:110`、`:212` |
| P5 | `state.ts` `appendStream`（`dropBlankChunk` 丢弃异 kind 纯空白分片；`streamBreak` 断行标志，避免两段思考粘连） | 新增 `tests/p5-blank-chunk.test.ts`（5 例）；临时复现脚本核对（空行消失、思考两行相邻；脚本已清理） |
| P6 | `layout/tool-line.ts` `stepHeaderLine(step, time)`、`app/clock.ts` `clockHms`；adapter `step` 事件带 `time`（`:1643`）；`layout/build-box.ts` step 分支、`content-rules.ts` `isStepHeader`（原 `"step "` 前缀退役） | `tests/step.test.ts`（10 例，含缺 `time` 回退当前时刻）、`tests/layout4.test.ts`、`tests/content-mapping.test.ts`、`tests/adapter.dsh.test.ts` |
| P2 | `layout.ts` `dotJoin`（`·`→`•`）、状态栏行组装的 `separator: { char: "•", color: "plain" }`；`layout/fill.ts` 新增 `"plain"`（默认前景）语义 | `tests/layout4.test.ts`（状态栏断言：含 `•`、不含 `│`）；冻结帧基线重生成 |
| P3 | `layout.ts` `paneTextWidth(paneW, reserve)` 与 `frameGeometry`（横向历史不留白、活动与纵向各让 1 列）；顺带修复 `buildContentRows` 第 4 个参数未传——活动 pane 原先按**对话**文字宽折行 | `tests/pane-text-margin.test.ts`（4 例，含「文字不落在留白列」） |
| P1 | `state.ts` `BufferLine.status` / `TurnEndReason` / `markUserBlockStatus`（turn-end 按 reason 打终态）；`index.ts` `case "turn-end"` **转发 adapter 的 `reason`**（独立核对时发现的断链：不转发则真实路径永不打标）；`layout.ts` `USER_BLOCK_SYMBOL` + `userBlockSymbolResolver`（活跃块 ●/○/△、其余 ?）；`layout/build-box.ts` 用户块首行 2 列前缀；状态栏符号段移除 | `tests/layout4.test.ts`、`tests/app.test.ts`（符号位置/取值/配色；含真实事件路径回归：临时回退 `index.ts` 转发后该用例失败）；`tests/p8-compaction-active.test.ts`（压缩中显示运行中） |
| P8 | `state.ts` `compactingBySession` / `isCompacting`；`index.ts` `agentBusy()` 并入压缩、`canExitOnCtrlD()` 守卫；adapter `compaction` 事件带 `sessionId` | 新增 `tests/p8-compaction-active.test.ts`（4 例：标记/隔离/符号/退出守卫）、`tests/adapter.dsh.test.ts`（事件形状） |
| P7 | `layout.ts` 移除 Mode 块（`modeBlock`、`SWITCH_ON/OFF`）、新增 `TITLE_ICON` + `titleBarSegments`（preset + 6 符号 + 标题，含让位顺序）；`frameGeometry`/`buildTopRegion` 支持状态列隐藏；`state.ts` `statusColumnVisible` + `status-column` action（**隐藏时把焦点移开 + Tab 循环跳过该列**，否则 0 宽面板会被 focusFrame 画出退化边框压掉内容首列；`frameGeometry`/`focusFrame` 亦有防御）；`index.ts` **Ctrl+S** + 提示行；`adapter/session-ui-state.ts` 快照字段 `statusColumn` | 新增 `tests/title-bar.test.ts`（9 例：组合/顺序/沙箱四态色/开关 on-off/让位顺序/图标单列/Ctrl+S 显隐与隐藏态无退化焦点框/快照往返）、`tests/status-column.test.ts`（15 例）、`tests/policy.test.ts`（11 例） |
| P9 | `adapter/dsh.ts` `normalizeHistoryMessages` 事件折叠（`step/start` 分组、`tool/call` 名字去重计数、`tool/result` 失败计数、`step/end` 收口，空消息丢弃）；`commands.ts` `surfaceToBuffer` 映射 `role:"step"` → `BufferKind:"step"`；`layout/build-box.ts` step 行渲染（`╌╌ ` 前缀 + 尾部 `╌` 铺满） | 新增 `tests/resume-summary.test.ts`（2 例）、`tests/adapter.dsh.test.ts`（3 例 P9）；真实会话日志核对：1629 事件 → 372 条消息、229 行 step 概要、**0 条空消息** |

**基线与环境改动**：`TUI/tests/fixtures/focus-frame-legacy.json` 按新渲染重生成（`TUI/scripts/freeze-focus-frame.mts`，15 场景）；`tests/helpers/screenEmu.ts` 改为按**码点**解析（星平面 Nerd Font 图标原被当两个 UTF-16 单元，导致模拟屏假性折行）。

**冒烟脚本随改（`TUI/demo/main.ts`）**：11 条断言按新口径重写——① 状态符号断言从「状态栏最左」改为「用户块首行」（`? / ✓ / ■ / △ / ●○`，并新增可驱动的 aborted 场景）；② Mode 块断言改为标题栏图标组（按码点，含「状态列不再有 Mode 块」反向断言）；③ step 头断言改为 `hh:mm:ss #N`；④ policy/preset 徽标断言改为标题栏图标的着色与 `preset 图标 + 名字`；⑤ 通知类断言改为**按整帧取证**（新增冒烟期整帧捕获：stdout 只有增量行，折行文本会被其它行插入打断）；⑥ 混合内容顺序断言不再假定上下排列（P1 让状态栏少占 5 列 → 80 列下状态栏由 2 行变 1 行 → `activityPlacement: auto` 在该尺寸改选左右排列）。结果：`SMOKE_PASS 41 / SMOKE_FAIL 0`。

**独立核对**（子代理只读复核，逐条按源码/实测给结论）：P1–P8 全部**符合**；抽查有效（故意改坏 `state.ts` 的 P5 判据 → 对应用例确实失败，还原后 sha256 一致、无残留）。核对发现并已修复 1 处低危偏差：**活跃块**原先取「最后一个 status 未定的 user 行」（会往前找到上一回合 `blocked` 收尾的老块，使其长期闪 ●/○/△），现收紧为「**最后一条**用户输入且终态未定」，并加用例（`tests/app.test.ts`，忙时老块只显示 `?`）。另自查修复 1 处 P7 缺陷：状态列隐藏但焦点仍在 status 时会画出 0 宽退化焦点框压掉内容首列——现隐藏即移开焦点、Tab 循环跳过该列，并在 `focusFrame` 前置防御（回归用例见 `tests/title-bar.test.ts`）。

**验证**：`npm run check`（0 error）、`npm run test`（TUI **1078 通过 / 0 失败** + 12 个插件全绿）、`npm run build`、`npm run demo -- --smoke`（**SMOKE_PASS 41 / SMOKE_FAIL 0**）；真机 `dsh --profile fff` 人工确认（P1 符号、P2 圆点、P3 贴线、P4 缩进、P5 无空行、P6 时间戳、P7 标题栏 + Ctrl+S、P8 压缩排队、P9 resume 概要行）。
