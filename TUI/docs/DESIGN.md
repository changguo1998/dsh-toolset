# DSH TUI 插件设计

> 职责：TUI 的机制取舍与设计依据（为什么这样实现）
> 不负责：逐条实现细节（见 `TUI/docs/IMPLEMENTATION.md`）
> 过期条件：无

> 类型：**[design]**——架构设计：术语与模块划分、Box 排版模型、四区域布局、DSH 事件接入、规划与边界。
> 配套：`README.md`（使用与配置）、`SPEC.md`（规范性接口与算法）、`IMPLEMENTATION.md`（实现要点）、`COMMANDS.md` / `COMMANDS-SPEC.md`（命令面）、`REFACTOR.md`（模块拆分约定）。

## 项目目标

为 DeepSeek Harness（DSH）开发轻量级、高性能的终端 UI 插件，作为进程内集成的交互前端：复用 DSH 核心服务（会话管理、Agent 驱动、工具调用等），提供 Web UI 和 CLI 之外的第三种交互方式。

## 技术选型

- 语言 TypeScript（与 DSH 核心一致），运行时 Node.js，依赖仅 `chalk`（ANSI 颜色控制）。
- 不采用 Ink / Solid-TUI 等框架，自研极简渲染层。理由：流式输出本质是「增量文本追加 + 偶尔整帧重绘」；渲染层以**变化行游程重写**为核心（逐行比较，连续变化行各成一段、段间独立定位重写，不清屏），无组件树与布局引擎。防闪烁机制（区间重写 / 帧段切分 / DEC 2026 同步输出 / 覆盖式全帧 / 渲染期光标隐藏）见 `IMPLEMENTATION.md`「增量渲染与防闪烁」。
- 代价是输入解码需手写 ANSI 转义序列解析（方向键、Home/End、Ctrl 组合、bracketed paste）——node 无 stdlib 键盘解析，这是自研相对用 Ink 的真正成本。
- **绘制节律**：`paint()` 标脏 + 同一 tick 合帧（microtask 冲刷，一 tick 一帧），事件 burst 不逐事件重绘；真实链路另有跨回合帧率上限（默认 10Hz）。排版侧折行 / 宽度走有界缓存（`TUI_LAYOUT_CACHE=0` 可关）。详见 `IMPLEMENTATION.md`「排版缓存与绘制合帧」。
- `node-pty` 已评估、暂不引入（除非 TUI 需直接开 shell，否则会话由 DSH 管理）。

DSH 适配层接口以**官方源码研读**为准（契约沉淀于仓库根 `docs/host/DSH-CTX-API.md`，基线 `dsh-v0.1.5-rc.3`）：

- 进程内宿主为 vendored `@deepseek-ai/cordis`（Context / Service / Fiber），插件导出 `apply(ctx)`；
- 订阅会话事件：`ctx.on('session/event', (session, event) => …)`（带 `seq` 连续契约）；
- 审批应答链：`ctx.on('approval/request', (req, next) => …)`，返回 `ApprovalOutcome`，须在 open turn 内；
- 发消息：进程内 `agent.followup(...)`；agent 状态是 agent 层事件 `agent/status`，不在 session 事件词汇表内。

## 术语：渲染 vs 排版

| 术语 | 含义 | 归属 |
|---|---|---|
| **渲染（rendering）** | 把已成型的画面写到终端：帧重绘（delta / 整帧）、光标定位、主题色序列化、终端控制（raw mode / resize / 退出恢复）、键盘解码。**不理解内容与布局**，不感知 DSH | `src/renderer/` |
| **排版（presentation，layout）** | 把状态 / 内容组织成带语义样式的行：分区、换行、宽度计算、markdown 解析、面板构图、焦点框线。决定画面长什么样，产出渲染层的输入 | `src/app/layout.ts`、`src/app/layout/`、`src/app/components/` |

名词纪律：layout 系代码不称「渲染」，只称「排版 / 布局」；「渲染」专指 renderer 的字节上屏。

画面生产链（单向）：

```
逻辑(state) --AppState--> 排版(layout/components) --行+语义样式--> 渲染(renderer) --字节--> 终端
```

职责分域（「排版」≠ app 全部；app 内含逻辑 / 排版 / 控制 / 外部边界四个角色）：

| 域 | 职责 | 文件 |
|---|---|---|
| 逻辑 | 状态模型与纯状态转换 | `state.ts`、`*-transition.ts`、`commands.ts` |
| 排版 | 状态 → 带语义样式的行 | `layout.ts`、`layout/*`、`components/*` |
| 渲染 | 行 → 字节上屏 | `renderer/*` |
| 控制 | 副作用编排（adapter / notice / paint / 异步） | `index.ts`（App） |
| 外部边界 | DSH 事件归一化与回调 | `adapter/*` |

样式链路已收敛：样式序列化由渲染层 `renderer/theme.ts` 独占，排版层仅持有 `ColorName` 语义；Box 排版管线（`layout/box|measure|fill|build-box|focus-frame|panel`）落地，面板组件改为 Box 生成器，焦点框线为全局 `focusFrame` 覆写。契约见 `SPEC.md`。

## 文件结构（单包分目录）

```
TUI/
  package.json           # type: module, bin: tui.js
  tsconfig.json
  bin/tui.js             # shebang + import('../dist/main.js')
  src/
    main.ts              # 组装: renderer + app + DSH adapter；插件参数归一化与注入
    renderer/            # 框架层：不感知 DSH、不 import app
      terminal.ts        # raw mode 开/关、resize 监听、退出清理
      input.ts           # stdin 键解码：ANSI 转义序列 → 结构化 key 事件
      screen.ts          # 帧缓冲 + delta/整帧重绘 + 段级序列化
      theme.ts           # 内置兜底 truecolor 调色板 + ANSI 槽位映射
      theme-config.ts    # 启动解析 tui.config.json 的 theme 段
      index.ts           # 公共 API
    app/                 # 应用层：只依赖 renderer 公共 API
      state.ts           # 状态模型 + reducer（会话/缓冲/审批/系统状态/滚动/面板）
      layout.ts          # 几何唯一来源 frameGeometry + 四区域帧组装
      layout/            # Box 排版管线：box/measure/fill/build-box/focus-frame/panel/
                         #   table/markdown/tool-line/content-rules/primitives/cache/help
      status.ts          # 系统状态区数据源：StatusTicker 合并节流读取 cwd/git/time
      commands.ts        # 纯函数：本地命令目录/路由/补全/决策
      question-transition.ts / model-transition.ts   # 问答 / 模型选择纯状态转换
      components/        # Box 生成器：TextInput、审批、问答、ModelPicker、各列表面板…
      adapter/           # 插拔边界：dsh.ts（ctx 订阅与归一化）、types.ts、normalize.ts
      index.ts           # App：组装层，副作用（adapter 调用 / paint / notice / 异步）都在此
  demo/                  # mock adapter 喂模拟流式文本 + 审批，不接 DSH
  tests/                 # node --test；renderer 解码 / 排版 / adapter fake-ctx
```

依赖方向（单向）：`main.ts → app → renderer`；`adapter → app`（喂状态）。

## 核心接口契约（renderer 公共 API）

排版层向渲染层交付 `FrameRow[]`（每行 = 段序列 `FrameSegment[]`，段携带**语义样式名**；输入行另带 `caret` 硬件光标列），渲染层向 App 交付结构化 `KeyEvent`（`name` + `ctrl`/`meta`/`shift`）。`Renderer` 对外提供：`render(rows, sections?)`（整帧重绘，变化行游程重写为内部优化；`sections` 为帧段表，先按段收敛范围、段内再按游程切分区间）、`refresh(rows, sections?)`（Ctrl+L 强制全帧）、`onKey` / `onResize` / `getSize`、`setTheme(id)`（切换主题并令帧缓存失效）、`close()`（恢复终端退出）。

完整类型与签名（`ColorName` / `FrameStyle` / `FrameSegment` / `FrameRow` / `Renderer` / `serializeFrameRow`）见 `SPEC.md` §11-§14。

## Box 排版模型

Box 统一承担两件事——**屏幕分区**与**内容元素**：屏幕 = 顶区（状态列 ‖ 历史 ‖ 活动）/ 状态区 / 输入区 / 提示区的 Box 嵌套；每一条用户输入、每一条模型回复、一个段落、一个 markdown 表格、一条工具调用记录，各自也是一棵 Box 子树。两者是同一模型、同一套布局算法，只是层级不同：pane 树的叶子挂内容树，内容树的叶子是**缩进段落**。

**核心不变量（叶子语义）**：一个叶子的文字属于同一个缩进段落——叶子内部所有文字（含软换行续行）共享同一缩进基准；缩进不同就是不同叶子。几何属性（`indent`/`hanging`/`prefix`/`wrap`）叶内必须一致，外观属性（fg/bg/bold/…）允许段内变化。**改几何就拆叶子，改样式就用 `FrameSegment`**（理由与例外见 `SPEC.md` §5）。

Box 不是组件树：它是纯数据结构（可穷举的代数类型），无生命周期、无样式继承、无测量回环、无回调——砍的是带行为与继承的引擎，Box 只是「布局代数」。

### 4. 层级：pane 树挂内容树

```
screen = v([
  h([
    statusColumn,                                // 最左状态列（width: ratio 1/3）
    v([ titleBar, h([ history, activity ]) ]),   // 区域：标题栏 + 历史/活动并排
  ]),
  statusBar, input, hint,
])

history 的内容 = v( 消息 Box … )      // 由 state.buffer 派生
activity 的内容 = v( 瞬态行 Box … )    // 思考/工具/notice；面板打开时整体替换
```

- **pane 树**结构固定（四区域）：分区层硬编码于 `buildBox`，尺寸由 `metricsFor` 预算转成 `Width`/`Height` 意图；内容层走「内容元素类型 → Box 构建函数」映射表，新增内容类型 = 加一条映射、不改布局主体（`SPEC.md` §3）。
- **内容树**每帧从 state 派生（纯函数），挂在 pane 的叶子上；在 pane 的 fill 阶段摊平为 `FrameRow[]`，滚动 / 裁剪在行级进行。
- 排版管线：`state --buildBox--> Box 树 --measure/allocate--> rects --fill--> FrameRow[] --renderer--> 终端`（每帧全量重建，纯函数、可复现，见 `SPEC.md` §9）。

### 6. 模块归属

| 文件 | 职责 |
|---|---|
| `layout/box.ts` | 类型：`NodeBase`/`Box`/`Paragraph`/`Width`/`Height`/`Separator`/`PaneId`（纯类型，无行为） |
| `layout/measure.ts` | `measure(node, constraint) -> SizeTable` + `allocate(SizeTable, rect) -> Map<Node, Rect>`（`SPEC.md` §6） |
| `layout/fill.ts` | `fill(ctx, rect)` 摊平：Paragraph 折行 → 行内解析 → 补白 / valign；Box 递归 + separator；`setCell` 切段 |
| `layout/build-box.ts` | `buildBox(state) -> Box`：四分区 pane 树 + 内容映射清单 |
| `layout/focus-frame.ts` | `FocusFrame(ctx, rects)` 段级覆写（整帧一次扫描） |
| `layout/table.ts` | 表格构建器（解析 + 列宽求解 + 压缩/分隔/对齐），产出 Box 子树（`SPEC.md` §3.2） |
| `layout/panel.ts` | 面板场景原语 `panelTitle`/`panelQuestion`/`panelExplanation`/`panelOptions` |
| `layout/markdown.ts` | 块识别 + 行内解析，产出 `FrameSegment[]` |
| `layout/tool-line.ts` | 工具行文本组装（summary/detail 启发式在 adapter 归一化时产出） |

`layout.ts` 保留几何唯一来源 `frameGeometry` 与四区域帧组装（并派生帧段表 `frameSections`）；渲染层 `renderer/index.ts` 按序列化文本逐行比较取变化行游程（先按帧段收敛范围，段内不连续处各自成区间）、`screen.ts` 负责报文组装；`components/*` 为 Box 生成器。模块拆分原则与触发标准见 `REFACTOR.md`。

### 7. 面板：activity 内容树整体替换

面板（审批 / 问答 / 模型选择 / 状态选项 / 各列表族 / 历史会话 / 命令补全）是 activity 的**内容树整体替换**，不是叠加层——不需要 Overlay 构造子。面板组件用 `layout/panel.ts` 的场景原语（`panelTitle` / `panelQuestion` / `panelExplanation` / `panelOptions`）组合成 Box 子树，与正文排版走同一套 fill 摊平，输出统一为段级 `FrameRow[]`。协议与接线点见 `COMMANDS-SPEC.md` §4，原语签名见 `SPEC.md` §7。

### 8. 焦点框线：全局 FocusFrame 覆写

Box 模型**不引入 `box.border` 属性**——三类视觉边界各有机制：兄弟项分隔线 = `separator`（纵向 `v` 行间横线 / 横向 `h` 列间分隔，横向排列的两 pane 内部分隔竖线即其一，与该 pane 的顶/底横线相接成格；状态栏组内 / 组间则改传 `•` + 默认前景，见下「状态区」）；行端竖线 = 摊平时按行附加；**焦点高亮框 = 全局 `FocusFrame` 覆写**。

焦点框是**全局状态驱动的跨区构图**：布局后得到 `Map<PaneId, Rect>`（仅带 `id` 的可寻址分区），顶层 `FocusFrame(ctx, rects)` 纯函数按焦点面板与各区域矩形，在指定行列重写角字与边线（未聚焦的灰线由正常内容机制产出）。防双画由扫描顺序 + 覆盖顺序保证（亮边 > 内容 > 空白占位），每处只替换一次；覆写按字符定位，不切半个 CJK、不改行宽。

之所以不做成「每个 box 自带 border」：共享边（标题栏下划线行兼作 history 顶边、D 列竖线兼作状态列右缘与历史区左缘）不能双画，放叶子上会让每个区域重复判断焦点。规格见 `SPEC.md` §8。

## 四区域布局

屏幕自上而下切分为**顶部区域**（最左详细状态列；右侧会话标题栏 + 对话历史 + 活动区）、**系统状态区**、**输入区 + 按键提示区**。用户可见行为与配置见 `README.md`，此处只记设计口径：

- **高度分配**：顶部高度 = `rows − 状态区 − 输入区 − 提示区 − 分隔行(2)`。输入区 + 提示区为「交互区」：常规终端固定 4 行（输入 3 + 提示 1），矮终端按 `floor(rows/5)` 收缩、至少 2 行。模态面板（审批 / 问答 / 模型选择 / 列表族 / 历史会话）显示于活动区窗口、底部交互区以空白占位，与输入态同高——面板开关不上下调整交互区高度。`buildFrame` 输出顺序：顶部区 → 分隔行 → 状态区 → 分隔行 → 输入区 → 按键提示区。
- **顶部状态列**：最左侧常驻窄列（`statusColumnDivisor`，默认 1/3、最低 20 列，历史区保底 10 列），右缘即分隔竖线（D 列）。块顺序为 **Goal → Todo → Jobs 三块**（P7：原 Mode 块整块迁入标题栏符号组），块间虚线 `╌`；折叠按窗口总高分级尝试（L0 不折叠 → L1 隐藏已完成（Goal 块只保留最近 1 条历史 goal）→ L2 仅进行中（goal 压成标题行）→ L3 进行中压 1 行），仍放不下则行级截断 `…(+N行)`；折叠在 fill 阶段执行（依赖可用高度），内容树与尺寸无关。无数据时整块省略，不留占位文字。`Ctrl+S` 切换该列显隐（P7）：隐藏后状态列宽归 0、右缘分隔竖线与相关连接字不画、历史区吃满整区全宽；显隐随会话写入 `tui-state.json`，切回该会话时恢复。
- **标题栏（P7）**：区域首行三段 = `[preset 拼图图标 + 1 空格 + 预设名] 1 空格 [状态符号组（最多 6 个，空格分隔：沙箱 / policy / plan / verbose / symbol-unify / bell）] 2 空格 [会话标题]`（空标题仍为灰色 `<title>` 占位）。符号是 Nerd Font 私有区字形（`TITLE_ICON`，命中与宽度实测各 1 列），**颜色即语义值**：沙箱 `read-only` 绿 / `workspace-write` 黄 / `danger-full-access` 红 / 其它值灰，policy `ask` 黄 / `never` 绿，四个开关 `on` 绿 / `off` 灰，preset 段默认前景；`permission` 不再显示（值仍随会话快照保存，沙箱取值另经 `sandbox/mode` 出图标）。窄宽按让位顺序收缩：① 去掉 preset 段 → ② 截断标题（保底 8 列）→ ③ 去掉整组符号 → ④ 既有标题栏降级（先收下划线、再整栏省略）。**本项依赖终端字体支持 Nerd Font 私有区字形**，非 Nerd Font 终端会显示豆腐块（见 `README.md`「已知限制」）。
- **历史区**：区域顶部为会话标题栏（标题行 + 下划线；标题取自官方 `session/title` 事件折叠结果，缺失时本地兜底）。正文按显示宽度换行，buffer 上限 `MAX_BUFFER_LINES`（2000 行，超出从头部裁剪）；排版量由**渐进窗口**限定（只物化尾部 3 个回合组），视口位置由**语义锚点**（`DialogueAnchor`，视口顶行 = (buffer 行, 行内换行序号)）解析——两者合计使底部新增、resize 重排、扩窗插入行都不移动锚定内容。滚动条语义：↑/↓ 半屏、PgUp/PgDn 跳用户块、Home 回底并复位窗口、End 扩窗到全部并钉首行。
- **活动区**：固定高度 = 顶部内容高 / `activityHeightDivisor`（默认 2；可经 `activityTopRow` 改为绝对行锚定），长内容超出时按可视行截断、可上滚。内容按时间顺序混合显示、不做类型分组；只有 turn-end 标记 `final` 的最终总结进历史区，其余中间输出与思考留在活动区。面板打开时活动区内容整体替换为面板 Box（非叠加层）。详略两态 `/verbose`：完整折行 / 每条目 1 行。
- **历史区/活动区文字右缘留白（`PANE_TEXT_MARGIN_COLS = 1`，P3）**：留白只作用于**右缘贴着外框列**的文字，且只收窄**文字**排版宽（`paneTextWidth(paneW, reserve)`）——横向排列时历史 pane 不留白（用户块右缘 `┃` 紧贴内部分隔竖线）、横向活动 pane 与纵向排列的两 pane 各让 1 列。**所有横线一概不缩**：标题栏下划线、活动区分隔线、回合分隔线（`╌`）、状态栏上下边框均铺满到屏幕最右列（区域外缘框列在横线行补 `─`/`╌` 不留缺口），焦点框矩形也不变。**活动区**另有两处差异：焦点框不画右边框（顶/底亮线直接铺到最右列收尾，无 `┐`/`┘` 角字），内容行行尾不补空格（行到文字右缘为止）。目的是字形宽度算错（CJK / 组合字符宽度估算偏差）时多出的列落在留白里，不顶到外缘框列、不把整行挤到下一行。
- **排列方式（`activityPlacement`）**：黄金分割比自动选择——比较两种排列下历史 pane 与活动 pane 的宽高比距 φ≈1.618 的对数偏差（取较差 pane），小者胜；判据只用区域正文宽 + 顶部内容高，不含状态列宽。左右排列时历史区在左、活动区在右，两 pane 等高、中间 1 列内部分隔竖线，两侧各保底 20 列（不可行回落上下）。活动区内容**恒底部对齐**（两种排列一致）：流自 pane 底边往上长，填满整块 pane 后才折叠最早内容——折叠点与切片高度同源（`frameGeometry.activityH` 一处算出）。焦点框随之落在内部分隔列。
- **顶部三面板统一焦点滚动**：`Tab` 循环选中 history / activity / status（默认无焦点，全灰占位；内容推进后自动回到无焦点），仅在输入区为空时生效。偏移按各面板符号约定：history / activity 为「距底部」、status 为「距顶部」，均由渲染层 clamp。焦点面板以中性色四边框标记（dark 白 / light 黑），无独立顶部边框行——history 顶边由标题栏下划线行兼作、status 顶边自最顶行起。hint 行不显示焦点标签。
- **状态区**：以**横向 Box 排版**（`h([环境组, LLM组], { separator })`），**组内与组间分隔统一为 `•`**（U+2022，P2：默认前景色、1 列、两侧无空格），超宽按段折行、单组超宽才组内压缩；状态符号自 P1 起**不再由状态区承载**（改渲染在每条用户块首行左侧，见下「用户块状态符号」），故首行行首回到 1 空格留边、也不再有其后的边框色分隔竖线。组间没有边框色竖线后，状态栏上/下横线也就没有组间交点 `┬`（状态列右缘 D 列的 `┴` 保留）。数据流见下。
- **输入区**：提示符单字符 = 当前输入模式符号（`>` 普通 / `$` shell / `/` slash，默认前景色）；多行框按显示宽度换行、续行与首行文本起点对齐，光标行超出时整体跟随滚动。提交语义：普通文本走官方 `followup`（运行中则排队，本机只登记显示），`/` 走命令路由。模式为瞬态：空输入时按 `$`/`/` 切换、提交后自动回退 `>`。
- **turn 分隔**：`turn-begin` 时清掉上一轮瞬态活动行并在 buffer 追加横线行；`turn-end` 不画线、不清思考（思考保留至下回合统一清空）。
- **用户块状态符号（P1）**：每条用户块在**首行左侧留白里**渲染 `符号 + 1 空格`（**独立 2 列格**：符号不参与正文换行，故正文首行与续行同列、正文列不受符号影响；块右缘位置不变；排队块不显示符号）——终态绿 `✓`（success）/ 红 `✗`（failure）/ 灰 `■`（aborted，turn 被中止），由 `turn/end` 的 reason 打标（`BufferLine.status` / `markUserBlockStatus`）；**最新未终态块**在忙时显示黄 `●`/`○`（实心/空心圆按**虚拟总 token** 相位交替）、审批/问答面板打开时显示黄 `△`；其余无终态块（恢复的历史、未收到 turn/end 的块）回退默认前景 `?`。相位机制沿用原状态栏口径（`VIRT_*` 参数与 `RUN_TOGGLE_TOKENS` 不变，只换显示位置）：每次流式更新用**指数加权窗口**（`VIRT_RATE_TAU`，数据量与时长分子分母分别衰减，抗单帧噪声且与 chunk 频率无关）估计真实传输速率，经 **slew 速率限制**（`VIRT_SLEW_RATE`，变化率而非每帧绝对量）逼近并 clamp 到 `[VIRT_SPEED_MIN, VIRT_SPEED_MAX]`（= 切换率范围 `RUN_TOGGLE_FREQ_MIN/MAX`（toggle/s）× `RUN_TOGGLE_TOKENS`）得虚拟速度，估算 token 用流末 usage 真值经 `tokenCalib` 校准，虚拟总 token = ∫虚拟速度 dt，每 `RUN_TOGGLE_TOKENS` 个虚拟 token 切一次（切换率有界、与真实 tps 解耦；无流式数据时虚拟速度按 `VIRT_DECAY_TAU` 衰减回落、虚拟总 token 按衰减中的速度**持续积分**——闪烁频率渐降到最低而不断；run 边界 = 两次用户输入之间，下次用户输入时置 0）。**压缩期间算忙（P8）**：`compaction/start` → `compaction/end` 之间该会话按活跃处理——符号显示运行中 `●`/`○`、新消息走排队、`Ctrl+D` 退出守卫不触发（`Esc` 中断语义不变）。
- **会话流**：模型正文靠左、右缘留 `messageGutter`（默认 6，与用户块左缘对称）；用户消息为整体靠右的收缩块（一次输入 = 一条 buffer 行，显式换行保留在行内，按物理行折行取最大行宽作块宽，块内行首左对齐）。用户块与随后回答之间空一行。每条消息一个 Box 子树，markdown 块各自独立排版。
- **会话生命周期**：`/session` 面板做会话切换（`agents.resume`）、删除与清理；面板为十阶段状态机（`loading-list → list ⇄ loading-view → view`，另接删除 / 清理确认链），每个异步结果带 stale guard（phase 不匹配则 no-op），失败入 error 态不崩溃。清理判据与文件级删除护栏见 `README.md` 与 `IMPLEMENTATION.md`。

### 状态区数据流

`StatusTicker`（`status.ts`）固定间隔 tick，**一次 tick 内合并查询 cwd / git / time**（不重复 fork 子进程），聚合为单个 `Partial<SystemStatus>` 经 `{type:"status"}` reducer 更新；模型 / 上下文长度 / 缓存命中率无数据源时保持占位 `—`。真实查询为 `process.cwd()` + `git status --porcelain --branch`（execFile，1.5s 超时，失败回 `—`），输出经 `parseGitStatus` / `formatGitStatus` 归一为 `分支 ↑N ↓N +N ~N -N`（只统计工作区一侧）。

## DSH 集成

### 展示类配置

展示类配置在 `apply()` 边界由 `normalizeTuiDisplayConfig` 一次性归一化（非法值告警 + 回退默认），经 `main()` → `App` → `initialState` 下传，app 内不再校验：`messageGutter`、`theme`。`toolBootstrap` 属行为开关，在 `apply()` 直接读 `config.toolBootstrap` 透传，不参与 display 归一化。配置项与默认值见 `README.md`。

### 锚定工具引导（两阶段工具锁定-释放）

移植 dsh-anchored-standard（v2，MIT）到 TUI 持有的 agent：

- **目的**：V4 Pro 的能力上限由**首个 API 请求**所见内容决定——首请求用小而任务匹配的认知开局（2-3 工具 + 单一 persona），首次 durable `tool/call` 后解锁全量工具目录，使推理轨迹锚定在任务匹配的支架上。
- **门控**：仅 `deepseek-v4-pro` 应用；flash 与非 deepseek 模型、`toolBootstrap: false` 时 `system-prompt/assemble` 原样透传（零改动）。
- **状态机**（按会话，resume-safe）：任务模式由首个真实 user 消息分类（spec / react / weak），文本在 `agent/inbox/inserted` 捕获、`agent/pre-step` 兜底；promotion 由会话 events 含 `tool/call` 派生，进程内 Set 记忆。
- **首请求**：persona-only section、contexts 清空、工具目录过滤到 core（spec = bash+read+edit / react = bash+read+write / weak = bash+read；`glob`/`grep` 永不进入）。**解锁后**：全量工具目录 + 完整 sections，persona 恒定。
- **健壮性（fail-open）**：缺失 shell、过滤器异常一律降级全量目录并 warnOnce。接入点：`main.ts` setup 中与 `installSessionModelSelection` 并列挂 `installToolBootstrap(agentCtx, { enabled })`，同一条 `system-prompt/assemble` waterfall。

### 事件接入与渲染

对照官方 deepseek-harness `dsh-v0.1.5-rc.3`（= 本机安装宿主）：8 个可消费服务（sessions / agents / approval / userQuestions / llm / commands / sessionQuery / agentDefaultModel）已全部接入；事件词汇表以该 tag 的 `known-event-types.ts` 为准（53 项）。已接入能力按域：

- **工具与用量域**：`tool/call` + `tool/result` → 紧凑工具行（编码代理 TUI 的第一可见性）；usage 状态栏槽位（usage chunk 已解析，零新事件）；`finish` reason 挂 turn-end notice；`compaction/start` + `compaction/end` toast（P8：该区间内会话按活跃处理）；`llm/retry` + `llm/retry-started` 重试透明化。另外，宿主每 step 末补发的纯空白文本块（`"\n\n"`）在「上一行是异 kind 或 buffer 为空」时丢弃（P5），不再在活动区/历史区留下成片空行。
- **状态域**：`goal/change`、`todo/write` → **状态列**详显；`plan/mode`、`sandbox/mode`、审批策略、agent 预设 → **标题栏符号组**（`permission/preset` 只入会话快照、不再显示）；`step/start` | `step/end` turn 内分步（分组头带时间戳）；`subagent/descriptor` 子代理行；`compaction/summary` 摘要 toast。
- **生态域**：`tool-workflow/*`（workflow 行 + 结束 toast）、`command/run` | `command/done`（执行流）、`tool/ptc-dispatch*`（子派发行）、`hook/*`（调用行）、`schedule/change`（到点 toast）、`feedback/record`（确认 toast）、`compaction/prune`（剪除计数 toast）。接入均为 append-only 活动区行 / notice，不引入配对状态。
- **命令域**：`/policy`（审批策略 ask / never 两态切换，写 `ctx.approval.setPolicy`）、`/permission`（预设目录 + 转发宿主写路径）、`/preset`（`agent-preset/selected` 归一化 + `selectAgentPreset` 写路径）、宿主自带 `/compact` 等走 registry 转发。
- **交互请求域**：审批经 `ctx.on('approval/request', …)` 应答链返回 `ApprovalOutcome`；用户提问经 `runtime.on("user-questions/request", answerer)` 注册 waterfall 应答者，归一化为 `DshEvent{type:'question'}` 后在活动区弹问答面板（`Esc` 走 reject ask，不打断运行）。

#### 核心事件映射

| rc.2 事件（载荷已核实） | DshEvent | 渲染 |
| --- | --- | --- |
| `tool/call` `{turn, step, callId, name, arguments}` | `tool-call` `{sessionId, name, summary}` | `<name> <summary>`（summary = arguments JSON 关键字段启发式提取，截断一行） |
| `tool/result` `{message, error?: {name, code}, meta?}` | `tool-result` `{sessionId, ok, detail}` | `✓ <detail 首行截断>`；错误 `✗ <error.name>: <message>`（红） |
| `assistant/message` 的 `usage?: TokenUsage` | `usage` `{sessionId, input, output, cacheRead}` | 状态栏 `ctx N` + `cache N%`（最近一次请求为准，不累计） |
| `turn/end` 的 `reason` | `notice` 增加可选 `tone` | error → 红；max-tokens → 黄「输出达 token 上限」；blocked → 黄「已阻塞」；aborted / interrupted → 蓝；completed 静默 |
| `compaction/start` + `compaction/end` | `compaction` `{phase}` | toast「正在压缩上下文…」/「压缩完成」 |
| `llm/retry` `{retry, maxRetries, delayMs, failure, provider}` | `retry` `{attempt, max, delayMs, code, message?}` | toast「重试 1/2 (1.5s): <code> <message>」 |

#### 状态事件映射

| rc.2 事件 | DshEvent | 渲染 |
| --- | --- | --- |
| `goal/change`（create/edit/pause/resume/complete/block 携带 `GoalSnapshot{id, revision, objective, phase, blockedReason?, maxGoalRounds}` + roundsStarted；clear 携带 cleared + clearedAt） | `goal-change` 判别联合（set / clear） | 状态列 Goal 块按会话累积为历史：index 0 = 当前（标题 `Goal <phase>` + objective；blocked 附黄 tone 原因；phase=complete 时 objective 灰 + 删除线），其后每条旧 goal 为「灰 `Goal <phase>` 行 + objective 灰 + 删除线」；clear 按 id 出栈 |
| `todo/write` `{todos}`（全量快照，last-write-wins） | `todo-write` `{sessionId, todos}` | 状态列 Todo 块（`○` 待办 / `●` 进行中黄 / `✓` 完成灰 + 删除线） |
| `plan/mode` `{active}` | `mode {kind:'plan', value}` | 标题栏 plan 图标（on 绿 / off 灰） |
| `sandbox/mode` `{mode}` | `mode {kind:'sandbox', value}` | 标题栏沙箱图标（ro 绿 / wr 黄 / full 红 / 其它灰） |
| `permission/preset` `{preset}` | `mode {kind:'permission', value}` | **不再显示**（P7；值仍随 TUI 侧会话快照保存，沙箱取值经 `sandbox/mode` 出图标） |
| `step/start` / `step/end` `{turn, step}` | `step {phase:'start'\|'end'}` | 分组头 `╌╌ hh:mm:ss #N ` + 尾部 `╌` 铺满（P6，`stepHeaderLine(step, time)`：本地时区 24 小时制逐段补零、时间缺失只出 `#N`；该 step 首个工具调用时渲染，end 无独立渲染） |
| `subagent/descriptor` `{version, mode, provider, label?, …}` | `subagent {sessionId, label, mode}` | 子代理行（one-shot / continuable 标记），append-only 不配对 |
| `compaction/summary` `{compactionId, summary, shadowedSeqs, shadowedTokenCount, provider, model, usage?}` | `compaction-summary {sessionId, text, raw}` | 仅 toast（首行）；`raw` 存 `state.compactionBySession`（每会话仅最新一条，不改写、不入 buffer） |

#### 渲染语义（状态侧）

- **goal / todo / mode / policy / preset 均按 `sessionId` 隔离**（`goalBySession` / `todoBySession` / `modeBySession` / `policyBySession` / `presetBySession`），切换活跃会话读对应状态，杜绝旧会话泄漏；goal 以会话为单位累积历史（create / 未知 id 入栈、其余事件按 id 原位更新、clear 出栈；非 clear 事件为全量快照，原子无增量），状态列 index 0 当当前展示、其余当旧 goal 展示，全部出栈后省略块。
- **标题栏状态符号组（P7）**：四个开关（`plan` 取 mode 状态、`verbose` / `symbol-unify` 取 `AppState`、`bell` 取启动接线的配置值 `notify.enabled`）与沙箱 / policy 各出一个 Nerd Font 私有区图标，顺序固定 `沙箱 → policy → plan → verbose → symbol-unify → bell`、空格分隔、最多 6 个；**颜色即语义值**（沙箱 ro 绿 / wr 黄 / full 红 / 其它灰，policy ask 黄 / never 绿，开关 on 绿 / off 灰），无数据项整组省略。preset 段为拼图图标 + 预设名（默认前景）。权限预设目录（`ctx.permissionPresets.names`）与 agent 预设目录（`ctx.agentPresets.list`）仍经 `permission-catalog` / `agent-preset-catalog` 事件同步入 state（`permission` 不再渲染，preset 名直接来自 `agent-preset/selected`）。新会话由 adapter 的 Mode 快照（宿主 `permissionPresets.defaultPreset` 捆绑兜底 + plan=off）补发初始事件，与宿主当前模式一致。
- **step**：`step/start` 到来且当前有活动工具组时先 flush 并另起分组头；头文本 = `hh:mm:ss #N`（时间取事件 `time`，本地时区 24 小时制逐段补零、缺失只出 `#N`），渲染层补 `╌╌ ` 前缀与尾部 `╌` 铺满（P6）；无工具调用的 step 不产生输出。
- **恢复会话按 step 概要（P9）**：恢复不还原逐条工具行，而是折叠事件——每个**含工具调用**的 step 折成一行 `╌╌ hh:mm:ss #N ╌╌ 工具名[×次数], …[ ✗失败数] ╌╌╌…`（buffer `kind = "step"`，由 `surfaceToBuffer` 注入、`build-box` 按同一形制品渲染），无工具调用的 step 不出行；参数摘要 / 结果详情 / thinking 不还原；整条空文本不再产出空行。
- **compaction/summary**：只取首个非空文本块首行入 toast（空摘要 → 「压缩完成（无摘要）」）。
- **后台任务 `/jobs`**：宿主 `JobRegistry` 推送全量快照——数据源与 caller 形态按宿主版本择路（0.1.7 起事件走 `jobs.events.subscribe({ owner: sessionId })`、caller 是裸 `sessionId` 字符串；≤0.1.5 事件走 `onJobsChanged(listener)`、caller 是只读 `.id` 的对象，adapter 经 `jobsCallerFor` 探测后传值；事件与订阅都缺时退化为打开面板时拉取一次）。`list(caller)` / `kill(id, caller)` 为 owner-relative；App 事件层再按活跃 sessionId 过滤一道（防迟到事件与切会话串味）。仅只读展示 + cancel，不做 job 创建 / 参数 UI。
- **装配证据**：rc.2 bundle 默认装配含 command-compact / command-feedback / jobs-local / permission-presets / tool-jobs；**`agent-presets` 不在默认装配**——装配了该服务的环境 `/preset` 可用，未装配时提示「agent 预设服务不可用」（fail-safe 正常路径）。**这是官方设计而非缺配置**：TUI 是"没有 preset 的单组合面"（官方 `packages/client/ui-user-questions/README.md` 的 "the TUI composition, which has no presets"、`packages/bundle/web-app/cordis.patch.yml` 的 "composes its agent process-wide"），agent 面由 profile 的 `dsh-base` 行全局装配，改组合落 profile 用户 patch，本项目不为 TUI 挂 preset roster（依据与版本断层见 `../docs/host/AGENT-COMPOSITION.md`）。

#### seq 守卫

adapter / state 为每个 session 记录 `lastSeq`：`event.seq <= lastSeq` → 丢弃（防重复 / 倒序重放）；`event.seq > lastSeq + 1` → 只是间隙（宿主用 `session/end-seed` 标识 seed 边界，TUI 不做补缺，直接接受并更新游标）；非当前活跃会话的事件丢弃。测试覆盖同 seq 重复、倒序、间隙接受、非当前 sessionId 各至少 1 例。

### 审批：界面与审计（审计未接入）

- **角色澄清**：`approval/request` 是瀑布应答链（TUI 已接——弹窗 + 返回 `ApprovalOutcome` 即裁定）；`approval/asked` + `approval/decided` 是同段写日志（审计用，同 id 恰好一 asked 一 decided）。当前 TUI 唯一审批界面 = 弹窗，审计对无界面。
- **界面 vs 数据**：界面不需审计对（弹窗 + tool/result 行已覆盖）；只有事后回溯（事故复盘 / 审批问题诊断 / 策略调优）才需要审计时间线。
- **数据不丢**：审计对随 `session.append` 入会话事件流并落盘，resume 后完整恢复——丢的是展示入口。`readSurface` 做 surface fold（仅 user/assistant/tool result），审计对必然不含；审批历史须另走 `readSession` 全量读（混合日志 / live 会话会抛校验错，需抓错进 error 态）。
- **通路设计（未实现）**：`/approvals` 只读面板 + adapter `readApprovalHistory?()`（readSession 全量 → 过滤 asked/decided → 按 id 配对，孤儿记 pending → 按 seq 升序）。触发时机（出现任一再做）：安全事故复盘、审批问题诊断、ask/never 策略调优、多会话事后审计。

## 信号与退出契约

终端 raw mode 开/关与终端恢复由 `renderer/terminal.ts` 负责，对所有退出路径生效（正常 `close()`、SIGINT / SIGTERM、`uncaughtException` / `unhandledRejection`）；进程退出生命周期归 renderer 拥有，app 只在 renderer 分发的事件里做自己的清理。按键层面 `Esc` 与 `Ctrl+C` 不触发退出（避免误触丢会话），退出走 `/quit`。

## 规划与边界

- **待做**：
  - `session fork` 面板联动（宿主 `sessions.fork` 已接入 `/fork`，进一步的面板形态待定）。
  - tool `meta` diff 展示（+N / −M）——复用 `tool/result.meta` 工具私有展示载荷。
  - `model/selection` 模型切换回放：TUI 切换的模型不落盘，会话仅按次记录 `request/header`（含 provider / model / effort），无 `model/selection` 事件、折叠状态无模型行 → resume 不还原该会话最后模型且可能串味。修复需 TUI 侧自存「会话→模型」映射（核心无 per-session 持久化 API）。详见 `IMPLEMENTATION.md`「/model 命令」。
- **明确不做**：多会话并行（维持单活跃会话）；thinking 展开 / 收起；flex / grid / 自动布局引擎 / 样式继承 / 嵌套滚动；可复用 Panel 基类或带行为的组件节点；Overlay 覆盖层构造子（面板走内容替换）；renderer 侧承载排版职责。
- **deferred（已评估暂缓，非缺失）**：feedback 评价（低频）；嵌套 markdown 与上下标（低频）；`compaction/summary` 持久化（若要做可读历史另立条目）；`session/end-seed`、`session/title-llm-request`、`request/header`、`request/context`（低价值调试向且 payload 复杂，待调试视图需求出现再做）；`team/*`（实验包依赖）；`web/deepseek-search-llm-request`（log-only）；`model/selection`、`subagent/model-selection-policy`、session-log 交付确认（低频 / 内部日志）。
