# DSH TUI 插件设计

> 职责：TUI 的机制取舍与设计依据（为什么这样实现）
> 不负责：渲染 / 排版实现细节（见 `TUI/docs/SPEC.md` §15）
> 过期条件：无

> 类型：**[design]**——架构设计：术语与模块划分、Box 排版模型、四区域布局、DSH 事件接入、规划与边界。
> 配套：`README.md`（使用与配置）、`SPEC.md`（规范性接口与算法）、`COMMANDS.md` / `COMMANDS-SPEC.md`（命令面）、`TUI/docs/design/REFACTOR.md`（模块拆分约定）。

## 项目目标

为 DeepSeek Harness（DSH）开发轻量级、高性能的终端 UI 插件，作为进程内集成的交互前端：复用 DSH 核心服务（会话管理、Agent 驱动、工具调用等），提供 Web UI 和 CLI 之外的第三种交互方式。

## 技术选型

- 语言 TypeScript（与 DSH 核心一致），运行时 Node.js，**零运行时依赖**（源码零第三方 import；颜色走 manual ANSI，`dependencies` 为空）。
- 不采用 Ink / Solid-TUI 等框架，自研极简渲染层。理由：流式输出本质是「增量文本追加 + 偶尔整帧重绘」；渲染层以**变化行游程重写**为核心（逐行比较，连续变化行各成一段、段间独立定位重写，不清屏），无组件树与布局引擎。防闪烁机制（区间重写 / 帧段切分 / DEC 2026 同步输出 / 覆盖式全帧 / 渲染期光标隐藏）见 `SPEC.md` §15.9「增量渲染与防闪烁」。
- 代价是输入解码需手写 ANSI 转义序列解析（方向键、Home/End、Ctrl 组合、bracketed paste）——node 无 stdlib 键盘解析，这是自研相对用 Ink 的真正成本。
- **绘制节律**：`paint()` 标脏 + 同一 tick 合帧（microtask 冲刷，一 tick 一帧），事件 burst 不逐事件重绘；真实链路另有跨回合帧率上限（默认 10Hz）。排版侧折行 / 宽度走有界缓存（`TUI_LAYOUT_CACHE=0` 可关）。详见 `SPEC.md` §15.8。
- `node-pty` 已评估、暂不引入（除非 TUI 需直接开 shell，否则会话由 DSH 管理）。

DSH 适配层接口以**官方源码研读与升级对照**为准（`docs/host/DSH-CTX-API.md` 为 `dsh-v0.1.7-rc.2` 基线复核，0.2.0 对照确认消费面无变化；`0.1.7-rc.2` → `0.2.0-rc.2` 的接口差异与判定见 `docs/host/HOST-UPGRADE-0.2.0-rc.2.md`，更早一次见 `docs/host/HOST-UPGRADE-0.1.7-rc.2.md`）：

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
  bin/tui.js             # 双态启动器：profile 就绪 → 委托 dsh --profile；否则 mock demo
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
                         #   table/markdown/tool-line/content-rules/primitives/cache/help/
                         #   width-table（实测宽度落盘）+ eaw-table（宽度静态表，生成物）
      status.ts          # 系统状态区数据源：StatusTicker 合并节流读取 cwd/git/time
      commands.ts        # 纯函数：本地命令目录/路由/补全/决策
      clock.ts           # 时间格式化叶子（tool-line / status 共用）
      local-shell.ts     # `$` 模式本地子进程执行（非交互、超时与输出截断）
      question-transition.ts / model-transition.ts   # 问答 / 模型选择纯状态转换
      components/        # Box 生成器：TextInput、审批、问答、ModelPicker、各列表面板…
      adapter/           # 插拔边界：dsh.ts（ctx 订阅与归一化）、types.ts、normalize.ts、
                         #   session-paths.ts、session-ui-state.ts、tool-bootstrap.ts
      stderr-bridge.ts   # 运行期 stderr 桥：按行转交活动区（项目级「插件告警改道活动区」方案 A）
      index.ts           # App：组装层，副作用（adapter 调用 / paint / notice / 异步）都在此
  bench/                 # 排版性能基准（npm run bench → bench/layout-bench.mts）
  scripts/               # test.sh（测试包装）/ gen-width-table.mts / freeze-focus-frame.mts / eaw-dump.py
  demo/                  # mock adapter 喂模拟流式文本 + 审批，不接 DSH；smokePty.mjs 为真机 PTY 冒烟
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

- **pane 树**结构固定（四区域）：分区层硬编码于 `layout.ts`（`frameGeometry` 唯一尺寸来源 + `buildTopRegion` / `buildFrame` 分区拼帧），尺寸由 `metricsFor` 预算转成 `Width`/`Height` 意图；`buildBox` 只产两 pane 内容树 + 行元数据，内容层走「内容元素类型 → Box 构建函数」映射表，新增内容类型 = 加一条映射、不改布局主体（`SPEC.md` §3）。
- **内容树**每帧从 state 派生（纯函数），挂在 pane 的叶子上；在 pane 的 fill 阶段摊平为 `FrameRow[]`，滚动 / 裁剪在行级进行。
- 排版管线：`state --buildFrame(layout.ts 分区拼帧 + buildBox 两 pane 内容树)--> Box 树 --measure/allocate--> rects --fill--> FrameRow[] --renderer--> 终端`（每帧全量重建，纯函数、可复现，见 `SPEC.md` §9）。

### 6. 模块归属

| 文件 | 职责 |
|---|---|
| `layout/box.ts` | 类型：`NodeBase`/`Box`/`Paragraph`/`Width`/`Height`/`Separator`/`PaneId`（纯类型，无行为） |
| `layout/measure.ts` | `measure(node, constraint) -> SizeTable` + `allocate(SizeTable, rect) -> Map<Node, Rect>`（`SPEC.md` §6） |
| `layout/fill.ts` | `fill(ctx, rect)` 摊平：Paragraph 折行 → 行内解析 → 补白 / valign；Box 递归 + separator；`setCell` 切段 |
| `layout/build-box.ts` | `buildBox(buffer, opts) -> BuildBoxResult`：两 pane 内容树（dialogue / activity）+ 行元数据映射 |
| `layout/focus-frame.ts` | `FocusFrame(ctx, rects)` 段级覆写（整帧一次扫描） |
| `layout/table.ts` | 表格构建器（解析 + 列宽求解 + 压缩/分隔/对齐），产出 Box 子树（`SPEC.md` §3.2） |
| `layout/panel.ts` | 面板场景原语 `panelTitle`/`panelQuestion`/`panelExplanation`/`panelOptions` |
| `layout/markdown.ts` | 块识别 + 行内解析，产出 `FrameSegment[]` |
| `layout/tool-line.ts` | 工具行文本组装（summary/detail 启发式在 adapter 归一化时产出） |

`layout.ts` 保留几何唯一来源 `frameGeometry` 与四区域帧组装（并派生帧段表 `frameSections`）；渲染层 `renderer/index.ts` 按序列化文本逐行比较取变化行游程（先按帧段收敛范围，段内不连续处各自成区间）、`screen.ts` 负责报文组装；`components/*` 为 Box 生成器。模块拆分原则与触发标准见 `TUI/docs/design/REFACTOR.md`。

### 7. 面板：activity 内容树整体替换

面板（审批 / 问答 / 模型选择 / 状态选项 / 各列表族 / 历史会话 / 命令补全）是 activity 的**内容树整体替换**，不是叠加层——不需要 Overlay 构造子。面板组件用 `layout/panel.ts` 的场景原语（`panelTitle` / `panelQuestion` / `panelExplanation` / `panelOptions` / `windowStart`）组合成 Box 子树，与正文排版走同一套 fill 摊平，输出统一为段级 `FrameRow[]`。协议与接线点见 `COMMANDS-SPEC.md` §4，原语签名见 `SPEC.md` §7。

**两窗与焦点窗**（BACKLOG 3.2.1）：问答面板把面板体拆成「描述窗」（题干 + detail）与「选项窗」（选项 + 自定义兜底项）两段各自的滚动窗口，`Tab` 在 `state.question.items[i].focus`（`desc` / `options`）间切焦点，`↑/↓` 语义随焦点窗分派（描述窗滚行 / 选项窗移项）；窗口起点统一由 `windowStart` 计算，选项窗恒保证焦点项与已标记项可见。面板内文本编辑（「自定义回答」）时渲染行带 `caret`，渲染器据此把硬件光标定位回面板编辑位置（BACKLOG 3.2.7，契约见 `SPEC.md` §7.1 / §13）；caret 仅当 `customCaret > 0` 产出——光标在答案串首（`customCaret === 0`）时无 caret、硬件光标保持隐藏。**编辑光标（BACKLOG TUI#35）**：`item.customCaret`（`null` = 未编辑态）标记编辑态——编辑态下 `←/→` 在答案串内移动光标、插入与退格发生在光标处（列 = 该行内前缀的显示宽度，含 CJK），右端到头不切题；未编辑态（含空串 / 移项后）`←/→` 仍是切题导航，退格把串删空即回未编辑态。

### 8. 焦点框线：全局 FocusFrame 覆写

Box 模型**不引入 `box.border` 属性**——三类视觉边界各有机制：兄弟项分隔线 = `separator`（纵向 `v` 行间横线 / 横向 `h` 列间分隔，横向排列的两 pane 内部分隔竖线即其一，与该 pane 的顶/底横线相接成格；状态栏组内 / 组间则改传 `•` + 默认前景，见下「状态区」）；行端竖线 = 摊平时按行附加；**焦点高亮框 = 全局 `FocusFrame` 覆写**。

焦点框是**全局状态驱动的跨区构图**：布局后得到 `Map<PaneId, Rect>`（仅带 `id` 的可寻址分区），顶层 `FocusFrame(ctx, rects)` 纯函数按焦点面板与各区域矩形，在指定行列重写角字与边线（未聚焦的灰线由正常内容机制产出）。防双画由扫描顺序 + 覆盖顺序保证（亮边 > 内容 > 空白占位），每处只替换一次；覆写按字符定位，不切半个 CJK、不改行宽。

之所以不做成「每个 box 自带 border」：共享边（标题栏下划线行兼作 history 顶边、D 列竖线兼作状态列右缘与历史区左缘）不能双画，放叶子上会让每个区域重复判断焦点。规格见 `SPEC.md` §8。

## 四区域布局

屏幕自上而下切分为**顶部区域**（最左详细状态列；右侧会话标题栏 + 对话历史 + 活动区）、**系统状态区**、**输入区 + 按键提示区**。用户可见行为与配置见 `README.md`，此处只记设计口径：

- **高度分配**：顶部高度 = `rows − 状态区 − 输入区 − 提示区 − 分隔行(2)`。输入区 + 提示区为「交互区」：常规终端固定 4 行（输入 3 + 提示 1），矮终端按 `floor(rows/5)` 收缩、至少 2 行；`metricsFor(size, statusHeight, hintRows)` 以 `footerHeight = max(1, interaction − hintRows)` 反推输入区（不再用「是否有面板」推断 footer），`hintRows` 恒 1——**提示区任何状态都占 1 行**（空文案也占位，高度不跳）。模态面板（审批 / 问答 / 模型选择 / 列表族 / 历史会话）显示于活动区窗口，与输入态同高——面板开关不上下调整交互区高度；**问题交互态（问答 / 审批打开）底部输入区改显最近 notice**（取活动区 buffer 里 `kind === "notice"` 的行、按宽度折行后取末尾 `footerHeight` 行，tone 着色与 `hanging` 缩进口径与活动区共用，见 BACKLOG 3.1.1），其余模态面板保持空白占位。**按键提示统一在底部提示区**：文案唯一来源是 `layout/hints.ts` 的 `hintLine(state)`（按状态切换），面板内不再内嵌键位提示。`buildFrame` 输出顺序：顶部区 → 分隔行 → 状态区 → 分隔行 → 输入区 → 按键提示区。
- **顶部状态列**：最左侧常驻窄列（`statusColumnDivisor`，默认 1/3、最低 20 列，历史区保底 10 列），右缘即分隔竖线（D 列）。块顺序为 **Goal → Todo → Jobs → Agents 四块**（P7：原 Mode 块整块迁入标题栏符号组；Agents 块见 BACKLOG TUI#39——只读展示当前会话子代理（显示名 = 别名 ?? label，其后接最近一次工具调用摘要、无则不显示），**运行中黄 `●` / 空闲灰 `○` / 一切异常态红 `!`（附宿主 reason）**，随 `StatusTicker` 节律 5s 保鲜 + `subagent/start|end` 即时刷新——空数据不停表（TUI#55）、仅状态列隐藏 / 无活跃会话 / 已销毁时停；`unavailable` 陈旧条目不上列（TUI#56），corrupt / unsupported 仍红显），块间虚线 `╌`；**Goal 块当前行 = `Goal <phase 符号>`（2026-10-05 起不出相位词） + 尾随 `⟳` 自动续轮开关**（符号 / 颜色口径见「状态事件映射」，`goalActivationDisplay` 取值），历史行不带符号；折叠按窗口总高分级尝试（L0 不折叠 → L1 隐藏已完成（Goal 块只保留最近 1 条历史 goal）→ L2 仅进行中（goal 压成标题行）→ L3 进行中压 1 行），仍放不下则行级截断 `…(+N行)`；折叠在 fill 阶段执行（依赖可用高度），内容树与尺寸无关。无数据时整块省略，不留占位文字。`Ctrl+S` 切换该列显隐（P7）：隐藏后状态列宽归 0、右缘分隔竖线与相关连接字不画、历史区吃满整区全宽；显隐随会话写入 `tui-state.json`，切回该会话时恢复。
- **标题栏（P7）**：区域首行三段 = `[preset 拼图图标 + 1 空格 + 预设名] 1 空格 [状态符号组（最多 6 个，空格分隔：沙箱 / policy / plan / verbose / symbol-unify / bell）] 2 空格 [会话标题]`（空标题仍为灰色 `<title>` 占位）。符号是 Nerd Font 私有区字形（`TITLE_ICON`，命中与宽度实测各 1 列），**颜色即语义值**：沙箱 `read-only` 绿 / `workspace-write` 黄 / `danger-full-access` 红 / 其它值灰，policy `ask` 黄 / `never` 绿，四个开关 `on` 绿 / `off` 灰，preset 段默认前景；`permission` 不再显示（值仍随会话快照保存，沙箱取值另经 `sandbox/mode` 出图标）。窄宽按让位顺序收缩：① 去掉 preset 段 → ② 截断标题（保底 8 列）→ ③ 去掉整组符号 → ④ 既有标题栏降级（先收下划线、再整栏省略）。**本项依赖终端字体支持 Nerd Font 私有区字形**，非 Nerd Font 终端会显示豆腐块（见 `README.md`「已知限制」）。
- **历史区**：区域顶部为会话标题栏（标题行 + 下划线；标题取自官方 `session/title` 事件折叠结果，缺失时本地兜底）。正文按显示宽度换行，buffer 上限 `MAX_BUFFER_LINES`（2000 行，超出从头部裁剪）；排版量由**渐进窗口**限定（只物化尾部 3 个回合组），视口位置由**语义锚点**（`DialogueAnchor`，视口顶行 = (buffer 行, 行内换行序号)）解析——两者合计使底部新增、resize 重排、扩窗插入行都不移动锚定内容。滚动条语义：↑/↓ 半屏、PgUp/PgDn 跳用户块、Home 回底并复位窗口、End 扩窗到全部并钉首行。
- **活动区**：固定高度 = 顶部内容高 / `activityHeightDivisor`（默认 2；可经 `activityTopRow` 改为绝对行锚定），长内容超出时按可视行截断、可上滚。内容按时间顺序混合显示、不做类型分组；只有 turn-end 时按「分块边界 = `[step 变化 | 工具调用行]`」取出的**最近一块含正文块**（`markFinalSummary` 标 `final`）进历史区，其余中间输出与思考留在活动区（#1 起：thinking / notice / 空行不切割，被思考打断的前段不再丢）。面板打开时活动区内容整体替换为面板 Box（非叠加层）。详略两态 `/collapse`：完整折行 / 每条目 1 行。**输出内容三档 `/verbose think|tool|step`（#8）**：think = 思考+正文+工具调用、tool = 去思考、step = 只留工具调用的第一行（step 头与 notice 保留；与详略两态正交可叠加）。**类型间隔（#5，2026-10-02 收窄）**：仅「思考 ↔ 正文」互切处插 1 行空行；工具类（step 头 / 调用行 / 结果行）与任何类型相邻都不插，step 分割线与内容紧排（notice / shell 不算边界）。**正文分片连排（BACKLOG）**：只被 thinking / notice 行隔开的相邻非 final 正文分片合并为**一段**（文本直接相接、间隔空行收敛为恰 1 行置于该段正前方，段落落在思考块之后），直接相邻分片与工具 / step / final / fence / 表格仍是硬边界；实现为「合并时才移动」（正文不缓冲，未合并路径逐字节不变）。
- **历史区/活动区文字右缘留白（`PANE_TEXT_MARGIN_COLS = 1`，P3）**：留白只作用于**右缘贴着外框列**的文字，且只收窄**文字**排版宽（`paneTextWidth(paneW, reserve)`）——横向排列时历史 pane 不留白（用户块右缘 `┃` 紧贴内部分隔竖线）、横向活动 pane 与纵向排列的两 pane 各让 1 列。**所有横线一概不缩**：标题栏下划线、活动区分隔线、回合分隔线（`╌`）、状态栏上下边框均铺满到屏幕最右列（区域外缘框列在横线行补 `─`/`╌` 不留缺口），焦点框矩形也不变。**活动区**另有两处差异：焦点框不画右边框（顶/底亮线直接铺到最右列收尾，无 `┐`/`┘` 角字），内容行行尾不补空格（行到文字右缘为止）。目的是字形宽度算错（CJK / 组合字符宽度估算偏差）时多出的列落在留白里，不顶到外缘框列、不把整行挤到下一行。
- **排列方式（`activityPlacement`）**：黄金分割比自动选择——比较两种排列下历史 pane 与活动 pane 的宽高比距 φ≈1.618 的对数偏差（取较差 pane），小者胜；判据只用区域正文宽 + 顶部内容高，不含状态列宽。左右排列时历史区在左、活动区在右，两 pane 等高、中间 1 列内部分隔竖线，两侧各保底 20 列（不可行回落上下）。活动区内容**恒底部对齐**（两种排列一致）：流自 pane 底边往上长，填满整块 pane 后才折叠最早内容——折叠点与切片高度同源（`frameGeometry.activityH` 一处算出）。焦点框随之落在内部分隔列。
- **顶部三面板统一焦点滚动**：`Tab` 循环选中 history / activity / status（默认无焦点，全灰占位；内容推进后自动回到无焦点），仅在输入区为空时生效。偏移按各面板符号约定：history / activity 为「距底部」、status 为「距顶部」，均由渲染层 clamp。焦点面板以主题语义色 `focus`（青）描四边框，无独立顶部边框行——history 顶边由标题栏下划线行兼作、status 顶边自最顶行起。hint 行不显示焦点标签。
- **状态区**：以**横向 Box 排版**（`h([环境组, LLM组], { separator })`），环境组末尾可选挂 `@<会话别名>` 段（TUI#48：服务懒读 `session-channel` 的 `aliasList()`，ticker 同节律保鲜，缺失即不占位），**组内与组间分隔统一为 `•`**（U+2022，P2：默认前景色、1 列、两侧无空格），超宽按段折行、单组超宽才组内压缩；状态符号自 P1 起**不再由状态区承载**（改渲染在每条用户块首行左侧，见下「用户块状态符号」），故首行行首回到 1 空格留边、也不再有其后的边框色分隔竖线。组间没有边框色竖线后，状态栏上/下横线也就没有组间交点 `┬`（状态列右缘 D 列的 `┴` 保留）。数据流见下。
- **输入区**：提示符单字符 = 当前输入模式符号（`>` 普通 / `$` shell / `/` slash / `<` steer，默认前景色）；多行框按显示宽度换行、续行与首行文本起点对齐，光标行超出时整体跟随滚动。提交语义：普通文本走官方 `followup`（运行中则排队，本机只登记显示），`/` 走命令路由，`$` 走**本地子进程执行**（`local-shell.ts`：非交互、不经模型与审批链、输出以 `kind="shell"` 行进活动区、不进会话与模型上下文；缺省 30s 超时 SIGTERM→SIGKILL、单流输出 2 万字符截断），`<` 走官方 **`agent.steer`**（投递到最近 step 边界：运行中下一 step 认领、空闲立即起一轮；宿主无 `steer` 时降级 followup 并提示）。**排队块口径（TUI#43）**：运行中提交的排队项固定钉在对话区底部右下角、**各自独立成行**（用户行一律另起一行，不并入上一条用户块），右缘竖线 `followup` 灰 / `steer` 黄（已发出为亮红），渲染时 **steer 整体排在 followup 之上**（组内保持提交顺序）；认领后转入历史流——`followup` 在回合开始（`queued-claim`）、`steer` 在本回合 step 边界（宿主 `agent/inbox/spliced` 的 `removedCount > 0` → adapter 发 `inbox-claim` → `queued-claim-steer`）；空间空闲时 `<` 提交直达回显（无排队闪影）。模式为瞬态：空输入时按 `$`/`/`/`<` 切换、提交后自动回退 `>`。
- **输入历史（BACKLOG TUI#34）**：已提交输入按提交顺序入栈（普通输入与 `/` 命令**共用一份**；slash 模式记的是提示符口径文本、不含前导 `/`）。`↑` 上翻 / `↓` 下翻，越过最新条目回到进入翻看前的草稿；**仅在无面板焦点且（输入区非空或已在翻看态）时接管 `↑/↓`**——空输入且无历史时仍是既有面板滚动语义。进程内、随会话生命周期（不写 `tui-state.json`）；相邻重复不入栈、上限 200 条；翻看态下编辑即退出翻看并把编辑文本存为新草稿（`inputHistory` / `inputHistoryCursor` / `inputHistoryDraft` + `reduceInputHistory`）。
- **turn 分隔**：`turn-begin` 时清掉上一轮瞬态活动行并在 buffer 追加横线行；`turn-end` 不画线、不清思考（思考保留至下回合统一清空）。
- **用户块状态符号（P1）**：每条用户块在**首行左侧留白里**渲染 `符号 + 1 空格`（**独立 2 列格**：符号不参与正文换行，故正文首行与续行同列、正文列不受符号影响；块右缘位置不变；排队块不显示符号）——终态绿 `✓`（success）/ 红 `✗`（failure）/ 灰 `■`（aborted，turn 被中止），由 `turn/end` 的 reason 打标（`BufferLine.status` / `markUserBlockStatus`）；**最新未终态块**在忙时显示黄 `●`/`○`（实心/空心圆按**虚拟总 token** 相位交替）、审批/问答面板打开时显示黄 `△`；其余无终态块（恢复的历史、未收到 turn/end 的块）回退默认前景 `?`。相位机制沿用原状态栏口径（`VIRT_*` 参数与 `RUN_TOGGLE_TOKENS` 不变，只换显示位置）：每次流式更新用**指数加权窗口**（`VIRT_RATE_TAU`，数据量与时长分子分母分别衰减，抗单帧噪声且与 chunk 频率无关）估计真实传输速率，经 **slew 速率限制**（`VIRT_SLEW_RATE`，变化率而非每帧绝对量）逼近并 clamp 到 `[VIRT_SPEED_MIN, VIRT_SPEED_MAX]`（= 切换率范围 `RUN_TOGGLE_FREQ_MIN/MAX`（toggle/s）× `RUN_TOGGLE_TOKENS`）得虚拟速度，估算 token 用流末 usage 真值经 `tokenCalib` 校准，虚拟总 token = ∫虚拟速度 dt，每 `RUN_TOGGLE_TOKENS` 个虚拟 token 切一次（切换率有界、与真实 tps 解耦；无流式数据时虚拟速度按 `VIRT_DECAY_TAU` 衰减回落、虚拟总 token 按衰减中的速度**持续积分**——闪烁频率渐降到最低而不断；run 边界 = 两次用户输入之间，下次用户输入时置 0）。**压缩期间算忙（P8）**：`compaction/start` → `compaction/end` 之间该会话按活跃处理——符号显示运行中 `●`/`○`、新消息走排队、`Ctrl+D` 退出守卫不触发（`Esc` 中断语义不变）。
- **会话流**：模型正文靠左、右缘留 `messageGutter`（默认 4，与用户块左缘对称）；用户消息为整体靠右的收缩块（一次输入 = 一条 buffer 行，显式换行保留在行内，按物理行折行取最大行宽作块宽，块内行首左对齐）。用户块与随后回答之间空一行。每条消息一个 Box 子树，markdown 块各自独立排版。
- **会话生命周期**：`/session` 面板做会话切换（`agents.resume`）、删除与清理；面板为十阶段状态机（`loading-list → list ⇄ loading-view → view`，另接删除 / 清理确认链），每个异步结果带 stale guard（phase 不匹配则 no-op），失败入 error 态不崩溃。清理判据与文件级删除护栏见 `README.md` 与本文件「实现要点（机制与命令）」。**TUI#1/#2**：会话列表按**编辑时间**（`sessionQuery.listEvents` 末条事件 time，缺失回退 `createdAt`）从晚到早；`/continue` 与 CLI `-c` / `--continue` 共用选择函数 `pickRecentSession`（同目录 + persisted + 非 live + 编辑时间最大）走同一 resume 路径；CLI `--resume <id>` / `-c` 在 `apply()` 经 `ctx.cmdlineArgs` 解析，失败回落新建。**TUI#22/#23**：列表**行首时间显示该编辑时间**（缺省回退 `createdAt`），与排序同口径；`/continue` 改「最新会话」语义——候选并入当前会话（仅当 `hasPrompt !== false`，即探针确认已有用户消息），最新者即当前会话时提示「当前会话已是最新」不切换；CLI `-c` 仍按「最近退出的会话」在启动时选择（无当前会话）。**TUI#40**：CLI 启动即恢复（`--resume <id>` / `-c` 成功）时，adapter 以 `resumedAtLaunch` 标记下传，App 在 `restoreSessionState()` 之后补一次 `surfaceToBuffer` → `history-restore` 折叠——历史区**直接**显示既有消息（此前需手动再 `/session` 切一次）；折叠口径与面板切换共用（只是入口动作不同，`history-restore` 不依赖 `/session` 面板状态机），读取失败给 warn notice 且不阻塞启动。

### 状态区数据流

`StatusTicker`（`status.ts`）固定间隔 tick，**一次 tick 内合并查询 cwd / git / time**（不重复 fork 子进程），聚合为单个 `Partial<SystemStatus>` 经 `{type:"status"}` reducer 更新；模型 / 上下文长度 / 缓存命中率无数据源时保持占位 `—`。真实查询为 `process.cwd()` + `git status --porcelain --branch`（execFile，1.5s 超时，失败回 `—`），输出经 `parseGitStatus` / `formatGitStatus` 归一为 `分支 ↑N ↓N +N ~N -N`（只统计工作区一侧）。

## DSH 集成

### 展示类配置

展示类配置在 `apply()` 边界归一化（非法值告警 + 回退默认）后经 `main()` → `App` → `initialState` 下传：`messageGutter` 走 `normalizeTuiDisplayConfig`，`theme` 单独走 `normalizeThemeId`（App 侧对 `initialTheme` 仍会再归一一次）。`toolBootstrap` 属行为开关，在 `apply()` 直接读 `config.toolBootstrap` 透传，不参与 display 归一化。配置项与默认值见 `README.md`。

### 锚定工具引导（两阶段工具锁定-释放）

移植 dsh-anchored-standard（v2，MIT）到 TUI 持有的 agent：

- **目的**：模型的能力上限由**首个 API 请求**所见内容决定（原测量对象为 V4 Pro）——首请求用小而任务匹配的认知开局（2-3 工具 + 单一 persona），首次 durable `tool/call` 后解锁全量工具目录，使推理轨迹锚定在任务匹配的支架上。
- **门控**：全部 `deepseek-*` 模型应用（含 flash——weak 模式取 `PERSONA_WEAK_FLASH`；`isDeepseekModel = /deepseek/i`，覆盖 `provider/model` 前缀形态）；非 deepseek 模型、`toolBootstrap: false` 时 `system-prompt/assemble` 原样透传（零改动）。**放宽取舍**（BACKLOG TUI#11，2026-09-27）：原设计前提基于 V4 Pro 的测量，放宽后 flash / chat / reasoner 的一阶效果待真机复核——单测只覆盖门控判定与人设分支。
- **状态机**（按会话，resume-safe）：任务模式由首个真实 user 消息分类（spec / react / weak），文本在 `agent/inbox/inserted` 捕获、`agent/pre-step` 兜底；promotion 与模式的 durable 兜底经宿主消息投影读取（`session.deriveMessages()`；rc.2 无公开 `session.events`，BACKLOG TUI#13），进程内 Set 记忆。
- **首请求**：persona-only section、contexts 清空、工具目录过滤到 core（spec = bash+read+edit / react = bash+read+write / weak = bash+read；`glob`/`grep` 永不进入）。**解锁后**：全量工具目录 + 完整 sections，persona 恒定。
- **健壮性（fail-open）**：durable 记录不可读、缺失 shell、过滤器异常一律降级全量目录并 warnOnce。接入点：`main.ts` setup 中与 `installSessionModelSelection` 并列挂 `installToolBootstrap(agentCtx, { enabled })`，同一条 `system-prompt/assemble` waterfall。**（2026-10-05 用户裁定不要锁定）**：该挂载已**注释停用**（实现原样保留，恢复 = 取消注释；`toolBootstrap` 开关随挂载恢复生效）——当前首请求原样透传（全量工具目录 + 完整 sections），本节的锁定-释放行为整体不再生效。
- **启动自检 kickoff（2026-09-28）**：解锁判据在启动场景同样成立——`toolBootstrap` 未关 + 模型命中 `isDeepseekModel` + durable 记录可读且无 `tool/call`（未解锁，含未解锁的恢复会话）时，TUI 代替用户发一条自检消息（正文以 `[AUTO]` 开头、`source.kind:"tool-bootstrap"`），驱动模型发起首个工具调用完成解锁；`skill-autoload-on-unlock` 随之在启动阶段命中。门控在 `main.ts` 判（判据不可读 → 不发并 stderr warn，与 filter 的 fail-open 方向相反），消息构造 / 首消息读取在 `tool-bootstrap.ts`（纯函数），调度与回显在 App：新会话在启动期**同步**发（`createNewSession()` 决议后的微任务窗口内，先于 rule-engine 会话注入的宏任务入队；2026-10-04）、恢复会话等历史折叠落定后发（`history-restore` 会整表替换 buffer）；显示与提交同路径（用户块），消息本体由 adapter 的 `sendBootstrapKickoff()` 构造（**通道：优先 `steer`——next-step 队列，当前回合即可领取、空闲时立刻起回合；宿主无 `steer` 时回落 `followup` 并在 stderr 记降级，BACKLOG #2**）。该次请求用临时 weak persona 且**不写模式缓存**——模式仍由首个真实 user 消息落定（之后 persona 恒定）；`firstUserText()` 为读取真实首消息的统一入口（按 `source.kind` 过滤注入消息，events / 投影两条路径同口径）。另\*\*`/new` 新建会话补发（BACKLOG TUI#57）\*\*：判据同口径，由 `main.ts` 的 `kickoffForNewSession()` 判（`toolBootstrap` 未关 + **新会话将要使用的模型**命中 `isDeepseekModel`：建会话钉住的 route（`agentOptions`）优先 → 宿主默认选择兜底；**不读会话回填值**——判据必须在 `create()` 决议后的同一同步回合内求值，此刻 `restoreSessionState()` 尚未落定，读到的仍是上一会话的模型，见 BACKLOG TUI#57 求值窗口），`App.startNewSession()` 成功后经同一提交路径补发（**同步发送**，2026-10-04 起）。**（2026-10-05 用户裁定关掉 kickoff）**：`main.ts` 的启动与 `/new` 两处门控调用已**注释停用**（实现原样保留，恢复 = 取消注释并删占位赋值），恒传 `undefined` → App 不再代发 `[AUTO]` 自检消息；首请求回到用户真实任务（锚定窗口不再被自检请求占用）。
- **解锁后自动加载行为 skill（BACKLOG TUI#41）**：**不在 TUI 侧挂钩**，改由 `rule-engine` 规则承载（`id: skill-autoload-on-unlock`）——`source: "tool-call"` + 恒真条件对齐「首个工具调用」（引擎侧解锁判据），`cooldownTurns` 设为**远大于会话回合数的值（10000）**实现每会话一次（记账在进程内存：**重启进程会再注入一次**；**`0` = 不节流**，会每回合重复注入），`delivery: "steer"` 把模拟用户指令挂到最近 pre-step。选择规则载体的理由：一 skill 一规则，新增 skill 只需 `rule_add`、零代码改动、可逐条 `rule_test` / 禁用；代价是触发时机为「首个工具调用」（拿不到纳秒级解锁瞬间）且无 steer 面。规则定义与校验记录见追踪文档 `docs/archived/2026-09-27-skill-autoload-on-unlock.md`（TUI#41）。**当前正文（2026-10-05 只剩加载命令，供重建）**：`用 skill 工具加载 i-have-adhd`（2026-10-01 首次精简；2026-10-05 默认注入只保留 `i-have-adhd`——`karpathy-guidelines` 取消，「简单优先」改由 `ponytail` 插件阶梯承担，该插件**缺省开启**，见 `ponytail/README.md`；同日正文再精简为只剩加载命令。） **（2026-10-01 追加，rule-engine BACKLOG「触发条件改为记录压缩后」；同日按「注入标准统一与合并」改为 `step-end` + 单规则）**：现由**一条**规则承载——`id: skill-autoload`、`source: "step-end"`（每次步末判定，文本为空）+ `dedupeInRecord: 1`（整型：可见投影里最多允许 1 条本注入），故**重载不再重复注入**、**压缩把注入挤出投影后自然补回一次**；与符号指南消费者同节点 + 同 `delivery: "steer"`（最近 pre-step + 唤醒），故同一次触发合并为一条消息。**（2026-10-02 追加，项目级 BACKLOG「注入时机调整：会话开始 / 压缩完成后直写，不等步末」）**：改挂**会话开始 + 压缩完成**——`source: ["session-start", "compaction"]`（**不再挂 `step-end`**）+ `directWrite: ["session-start", "compaction"]`（两节点跳过 `dedupeInRecord` 投影判断、直接写入），故压缩完成当步即注入、不等步末；`session-start` 含恢复（`session/created`），恢复会话会再注入一次；与符号指南消费者在 `session-start` / `compaction` 两节点同 `delivery: "steer"`，合并为一条注入（指南另保留 `step-end` 节点按投影判断兜底）。

### 事件接入与渲染

对照官方 deepseek-harness `dsh-v0.1.7-rc.2`（= 当时的安装宿主；0.2.0 的消费面差异见 `docs/host/HOST-UPGRADE-0.2.0-rc.2.md`）：8 个可消费服务（sessions / agents / approval / userQuestions / llm / commands / sessionQuery / agentDefaultModel）已全部接入；事件词汇表以该 tag 的 `known-event-types.ts` 为准（59 项）。已接入能力按域：

- **工具与用量域**：`tool/call` + `tool/result` → 紧凑工具行（编码代理 TUI 的第一可见性）；usage 状态栏槽位（usage chunk 已解析，零新事件）；`finish` reason 挂 turn-end notice；`compaction/start` + `compaction/end` toast（P8：该区间内会话按活跃处理）；`llm/retry` + `llm/retry-started` 重试透明化。另外，宿主每 step 末补发的纯空白文本块（`"\n\n"`）在「上一行是异 kind 或 buffer 为空」时丢弃（P5），不再在活动区/历史区留下成片空行。
- **状态域**：`goal/change`、`todo/write` → **状态列**详显；`plan/mode`、`sandbox/mode`、审批策略、agent 预设 → **标题栏符号组**（`permission/preset` 只入会话快照、不再显示）；`step/start` | `step/end` turn 内分步（分组头带时间戳）；`subagent/descriptor` 子代理行；`compaction/summary` 摘要 toast。
- **生态域**：`tool-workflow/*`（workflow 行 + 结束 toast）、`command/run` | `command/done`（执行流）、`tool/ptc-dispatch*`（子派发行）、`hook/*`（调用行）、`schedule/change`（到点 toast）、`feedback/record`（确认 toast）、`compaction/prune`（剪除计数 toast）。接入均为 append-only 活动区行 / notice，不引入配对状态。
- **命令域**：`/policy`（审批策略 ask / never 两态切换，写 `ctx.approval.setPolicy`）、`/permission`（预设目录 + 转发宿主写路径）、宿主自带 `/compact` 等走 registry 转发。（`/preset` 命令 2026-10-02 删除，见项目级 BACKLOG「slash 命令命名规范：不用缩写」；agent 预设仍由 `agent-preset/selected` 事件在标题栏显示。）
- **交互请求域**：审批经 `ctx.on('approval/request', …)` 应答链返回 `ApprovalOutcome`；用户提问经 `runtime.on("user-questions/request", answerer)` 注册 waterfall 应答者，归一化为 `DshEvent{type:'question'}` 后在活动区弹问答面板（`Esc` 走 reject ask，不打断运行）。

#### 核心事件映射

| rc.2 事件（载荷已核实） | DshEvent | 渲染 |
| --- | --- | --- |
| `tool/call` `{turn, step, callId, name, arguments}` | `tool-call` `{sessionId, name, summary}` | `<name> <summary>`（summary = arguments JSON 关键字段启发式提取，截断一行） |
| `tool/result` `{message, error?: {name, code}, meta?}` | `tool-result` `{sessionId, ok, detail}` | `✓ <detail 首行截断>`；错误 `✗ <error.name>: <message>`（红）。**detail 为空**（静默工具 write / edit / hash_edit 的常态）：成功只出 `✓ `（空段省略，与 `toolCallLine` 省略空 summary 同口径；尾随空格是前缀契约），失败出 `✗ 输出错误`（防御兜底，与判决通知文案对齐）；`meta` 命中 `{before, after}` 字符串对时追加行级 diff 摘要 `(+N/-M)`（行集差近似，其它形状降级不显示） |
| `assistant/message` 的 `usage?: TokenUsage` | `usage` `{sessionId, input, output, cacheRead}` | 状态栏 `ctx N` + `cache N%`（最近一次请求为准，不累计） |
| `turn/end` 的 `reason` | `notice` 增加可选 `tone` | error → 红；max-tokens → 黄「输出达 token 上限」；blocked → 黄「已阻塞」；aborted / interrupted → 蓝；completed 静默 |
| `compaction/start` + `compaction/end` | `compaction` `{phase}` | toast「正在压缩上下文…」/「压缩完成」 |
| `llm/retry` `{retry, maxRetries, delayMs, failure, provider}` | `retry` `{attempt, max, delayMs, code, message?}` | toast「重试 1/2 (1.5s): <code> <message>」 |
| `user/message` / `agent/inbox/spliced` 的 `source.kind:'rule-engine'` 注入（BACKLOG TUI#49） | `rule-injection` `{id, text}` | 按**用户块**实时追加（正文 `[RULE] ` 前缀）；按 id 去重（双通道 / 重放）；历史恢复由 surface 自然折叠为用户消息。与 `source.form:'notice'`（其它插件注入）的一行提示路径并列 |

#### 状态事件映射

| rc.2 事件 | DshEvent | 渲染 |
| --- | --- | --- |
| `goal/change`（create/edit/pause/resume/complete/block 携带 `GoalSnapshot{id, revision, objective, phase, blockedReason?, maxGoalRounds}` + roundsStarted；clear 携带 cleared + clearedAt） | `goal-change` 判别联合（set / clear） | 状态列 Goal 块按会话累积为历史：index 0 = 当前（标题 `Goal <符号>`（2026-10-05 起不出相位词）——`▷` active 绿 / `∥` paused 黄 / `△` blocked 黄 / `✓` complete 绿 + objective；blocked 附黄 tone 原因；phase=complete 时 objective 灰 + 删除线），其后每条旧 goal 为「灰 `Goal <phase>` 行（无符号）+ objective 灰 + 删除线」；clear 按 id 出栈 |
| `goal/activation-changed` `{sessionId, goal?: {id, revision, activation}}`（**进程本地**态：不进会话日志、不落盘；`goal` 缺省 = 该会话已无当前 goal） | `goal-activation` `{sessionId, goalId?, activation?}` | 状态列 Goal 块当前行尾的 `⟳`（armed 绿 / disarmed 灰）；**只要收到过边就显示**（不按相位门控），无记录不显示；历史行不显示 |
| `todo/write` `{todos}`（全量快照，last-write-wins） | `todo-write` `{sessionId, todos}` | 状态列 Todo 块（`○` 待办 / `●` 进行中黄 / `✓` 完成灰 + 删除线） |
| `plan/mode` `{active}` | `mode {kind:'plan', value}` | 标题栏 plan 图标（on 绿 / off 灰） |
| `sandbox/mode` `{mode}` | `mode {kind:'sandbox', value}` | 标题栏沙箱图标（ro 绿 / wr 黄 / full 红 / 其它灰） |
| `permission/preset` `{preset}` | `mode {kind:'permission', value}` | **不再显示**（P7；值仍随 TUI 侧会话快照保存，沙箱取值经 `sandbox/mode` 出图标） |
| `step/start` / `step/end` `{turn, step}` | `step {phase:'start'\|'end'}` | 分组头 `╌╌ hh:mm:ss #N ` + 尾部 `╌` 铺满（P6，`stepHeaderLine(step, time)`：本地时区 24 小时制逐段补零、时间缺失只出 `#N`；该 step 首个工具调用时渲染，end 无独立渲染） |
| `subagent/descriptor` `{version, mode, provider, label?, …}` | `subagent {sessionId, label, mode}` | 子代理行（one-shot / continuable 标记），append-only 不配对 |
| `compaction/summary` `{compactionId, summary, shadowedSeqs, shadowedTokenCount, provider, model, usage?}` | `compaction-summary {sessionId, text, raw}` | 仅 toast（首行）；`raw` 存 `state.compactionBySession`（每会话仅最新一条，不改写、不入 buffer） |

#### 渲染语义（状态侧）

- **goal / todo / mode / policy / preset 均按 `sessionId` 隔离**（`goalBySession` / `todoBySession` / `modeBySession` / `policyBySession` / `presetBySession`），切换活跃会话读对应状态，杜绝旧会话泄漏；goal 以会话为单位累积历史（create / 未知 id 入栈、其余事件按 id 原位更新、clear 出栈；非 clear 事件为全量快照，原子无增量），状态列 index 0 当当前展示、其余当旧 goal 展示，全部出栈后省略块。**goal 自动续轮开关**另存 `goalActivationBySession`（末条 activation 边、按会话隔离、不落盘）：展示值由 `goalActivationDisplay` 直取末条边——**有边就显示**（不按相位门控）、**无记录不显示**（宿主重启后不发事件，不再推导为 `disarmed`），故不做「见过 armed 就恒绿」的粘性记忆。
- **标题栏状态符号组（P7）**：四个开关（`plan` 取 mode 状态、`verbose` / `symbol-unify` 取 `AppState`、`bell` 取启动接线的配置值 `notify.enabled`）与沙箱 / policy 各出一个 Nerd Font 私有区图标，顺序固定 `沙箱 → policy → plan → verbose → symbol-unify → bell`、空格分隔、最多 6 个；**颜色即语义值**（沙箱 ro 绿 / wr 黄 / full 红 / 其它灰，policy ask 黄 / never 绿，开关 on 绿 / off 灰），无数据项整组省略。preset 段为拼图图标 + 预设名（默认前景）。权限预设目录（`ctx.permissionPresets.names`）与 agent 预设目录（`ctx.agentPresets.list`）仍经 `permission-catalog` / `agent-preset-catalog` 事件同步入 state（`permission` 不再渲染，preset 名直接来自 `agent-preset/selected`）。新会话由 adapter 的 Mode 快照（宿主 `permissionPresets.defaultPreset` 捆绑兜底 + plan=off）补发初始事件，与宿主当前模式一致。
- **step**：`step/start` 到来且当前有活动工具组时先 flush 并另起分组头；头文本 = `hh:mm:ss #N`（时间取事件 `time`，本地时区 24 小时制逐段补零、缺失只出 `#N`），渲染层补 `╌╌ ` 前缀与尾部 `╌` 铺满（P6）；无工具调用的 step 不产生输出。
- **恢复会话按 step 概要（P9）**：恢复不还原逐条工具行，而是折叠事件——每个**含工具调用**的 step 折成一行 `╌╌ hh:mm:ss #N ╌╌ 工具名[×次数], …[ ✗失败数] ╌╌╌…`（buffer `kind = "step"`，由 `surfaceToBuffer` 注入、`build-box` 按同一形制品渲染），无工具调用的 step 不出行；参数摘要 / 结果详情 / thinking 不还原；整条空文本不再产出空行。
- **compaction/summary**：只取首个非空文本块首行入 toast（空摘要 → 「压缩完成（无摘要）」）。
- **后台任务 `/jobs`**：宿主 `JobRegistry` 推送全量快照——事件走 `jobs.events.subscribe({ owner: sessionId })`、caller 是裸 `sessionId` 字符串（0.1.7-rc.2 单一形态；事件缺失/订阅抛错时退化为打开面板时拉取一次）。`list(caller)` / `kill(id, caller)` 为 owner-relative；App 事件层再按活跃 sessionId 过滤一道（防迟到事件与切会话串味）。仅只读展示 + cancel，不做 job 创建 / 参数 UI。
- **装配证据**：rc.2 bundle 默认装配含 command-compact / command-feedback / jobs-local / permission-presets / tool-jobs；**`agent-presets` 不在默认装配**——装配了该服务的环境 `/preset` 可用，未装配时提示「agent 预设服务不可用」（fail-safe 正常路径）。**这是官方设计而非缺配置**：TUI 是"没有 preset 的单组合面"（官方 `packages/client/ui-user-questions/README.md` 的 "the TUI composition, which has no presets"、`packages/bundle/web-app/cordis.patch.yml` 的 "composes its agent process-wide"），agent 面由 profile 的 `dsh-base` 行全局装配，改组合落 profile 用户 patch，本项目不为 TUI 挂 preset roster（依据与版本断层见 `../docs/host/AGENT-COMPOSITION.md`）。

#### seq 守卫

adapter / state 为每个 session 记录 `lastSeq`：`event.seq <= lastSeq` → 丢弃（防重复 / 倒序重放）；`event.seq > lastSeq + 1` → 只是间隙（宿主用 `session/end-seed` 标识 seed 边界，TUI 不做补缺，直接接受并更新游标）；非当前活跃会话的事件丢弃。测试覆盖同 seq 重复、倒序、间隙接受、非当前 sessionId 各至少 1 例。

### 运行期告警显示（2026-10-01，项目级「rule-engine 的用户提示应显示在活动区」）

- **A · 运行期 stderr 桥**（`app/stderr-bridge.ts`）：`main()` 在 `App` 创建后、`start()` 前接管 `process.stderr.write`——按 `\n` 行缓冲，完整行交 `App.appendExternalLog(line, tone)`（`notice` 通道进**活动区**；tone 按 `error|fatal` / `warn(ing)|警告` 判定）；启动前写入与 `dispose()` 后照旧直写，桥内再写 stderr 直通原流防递归，多参调用（encoding / callback）透传。原因：渲染器是 delta 重绘且光标停在输入区，裸 stderr 字节会残留在输入区。
- **B · rule-engine 告警总线**：`App` 经 `getRuleEngine`（`ctx.get('ruleEngine')` 懒读、`start()` 接线、`dispose()` 注销）订阅 `onNotice`，事件经同一 `appendExternalLog` 进活动区；插件侧有订阅者时不写 stderr（headless 兜底）。

### 审批：界面与审计（审计未接入）

- **角色澄清**：`approval/request` 是瀑布应答链（TUI 已接——弹窗 + 返回 `ApprovalOutcome` 即裁定）；`approval/asked` + `approval/decided` 是同段写日志（审计用，同 id 恰好一 asked 一 decided）。当前 TUI 唯一审批界面 = 弹窗，审计对无界面。
- **界面 vs 数据**：界面不需审计对（弹窗 + tool/result 行已覆盖）；只有事后回溯（事故复盘 / 审批问题诊断 / 策略调优）才需要审计时间线。
- **数据不丢**：审计对随 `session.append` 入会话事件流并落盘，resume 后完整恢复——丢的是展示入口。`readSurface` 做 surface fold（仅 user/assistant/tool result），审计对必然不含；审批历史须另走 `readSession` 全量读（混合日志 / live 会话会抛校验错，需抓错进 error 态）。
- **通路设计（未实现）**：`/approvals` 只读面板 + adapter `readApprovalHistory?()`（readSession 全量 → 过滤 asked/decided → 按 id 配对，孤儿记 pending → 按 seq 升序）。触发时机（出现任一再做）：安全事故复盘、审批问题诊断、ask/never 策略调优、多会话事后审计。

## 信号与退出契约

终端 raw mode 开/关与终端恢复由 `renderer/terminal.ts` 负责，对所有退出路径生效（正常 `close()`、SIGINT / SIGTERM、`uncaughtException` / `unhandledRejection`）；进程退出生命周期归 renderer 拥有，app 只在 renderer 分发的事件里做自己的清理。按键层面 `Esc` 与单次 `Ctrl+C` 不触发退出（避免误触丢会话）；退出路径为 `/quit`、`Ctrl+D`（agent 空闲且输入区为空）与 750ms 内双击 `Ctrl+C`。`Ctrl+D` 与双击 `Ctrl+C` **不直接退出**，先弹**退出确认面板**（复用问答面板机制的合成面板，id `exit-confirm`）——默认高亮「取消/留在 TUI」，Esc 取消、Enter 确认高亮项，仅确认「退出 dsh」才走 `dispose()`；合成面板不触达 adapter 的 `answerQuestion` / `cancelQuestion`。该面板防「单字节误触/注入」直接结束会话（BACKLOG「tmux 断连后 dsh 退出」：终端/复用器注入的单个 `0x04` 不再致退）；`/quit` 为显式输入，保持直接退出。本地命令 `/restart` 同为显式命令、不弹面板——等价面板第三项（写交接文件 → 退出码 `75` → 收尾退出，跳过空会话清理）；未声明 `DSH_RESTART_FILE` 时只给 notice 提示不可用、留在 TUI。

### 退出确认 ·「重启」方案（2026-09-29 调研 + 定稿：启动器循环）

- **结论**：重启由**启动器**（用户的 `fffdsh` 之类的包装函数）完成，TUI 只负责「发出重启信号」。宿主没有重启原语；早期调研结论是 tmux `respawn-pane -k` 原地重启（路线 A），现改为「退出码 + 交接文件 + 外层循环」：不依赖 tmux、无 TTY 交接与孤儿进程问题，且旧进程完全退出后新进程才启动（不存在两个进程并发打开同一会话的竞争）。

- **契约（TUI 与启动器之间，两个通道各司一职）**：

  1. **触发 = 退出码 `75`**：启动器每轮启动前 `export DSH_RESTART_FILE=<唯一路径>`（建议 `$XDG_RUNTIME_DIR/dsh-restart-<pid>-<rand>`；退回 `/tmp` 时文件 `0600`、名字含 pid 与随机数）；子进程退出码为 `75` 即重启，其它码原样返回；每轮读完或非 75 退出都 `rm -f` 清理。
  1. **载荷 = 交接文件**：TUI 仅在 `DSH_RESTART_FILE` 存在时，于退出确认面板显示第三项「重启 dsh（保留会话）」；选中后把**当前活跃会话 id** 单行同步写入该文件（`mode 0600`），随后 `process.exit(75)`；写失败只打 stderr 仍退 75。
  1. **重启轮命令** = 启动器原参数 + `--resume <id>`；读不到 id（文件缺失 / 为空 / 写入失败）退回 `-c`（加载当前目录下最近退出的会话，TUI#40 已支持）。

- **为什么两个通道都要**：退出码与进程退出原子绑定 —— 写文件失败时仍是「重启并退回 `-c`」，而不是静默变成普通退出；文件只回答「恢复哪条会话」。
  **备选（不采用，仅记录）**：单通道「文件非空即重启」更简，但需额外哨兵表达「要重启但拿不到 id」，且写失败会静默丢失重启请求。

- **交互**：沿用现有合成问答面板语义（`EXIT_CONFIRM_PANEL_ID`；回车确认高亮项，不做二次确认）；默认仍高亮「取消」；「取消 / 退出 dsh」既有路径与按键语义不变；多实例互不影响（每轮路径唯一）。本地命令 `/restart` 与面板第三项共用同一收尾方法（`requestRestart()`），但不经面板（显式命令直接执行）。

- **边界**：直接 `dsh ...` 启动（无启动器、无该环境变量）时不显示重启项；用户选「退出 dsh」绝不写文件；未提交输入按既有退出语义丢弃；重启后仅会话内容保留（滚动缓冲 / 输入历史不保留）；`75` 与既有退出码无冲突。

- **启动器片段（用户侧，项目外，不进本仓；完整版见 `TUI/README.md`）**：

  ```sh
  # 重启循环：TUI 以退出码 75 请求重启，会话 id 经 DSH_RESTART_FILE 交接（每轮唯一路径）
  local -a pfx base extra
  base=("$@")
  if [[ $has_profile == yes ]]; then pfx=(); else pfx=(--profile fff); fi
  extra=()
  local code file id
  while :; do
      file="${XDG_RUNTIME_DIR:-/tmp}/dsh-restart-$$-$RANDOM"
      export DSH_RESTART_FILE="$file"
      dsh "${pfx[@]}" "${base[@]}" "${extra[@]}"
      code=$?
      unset DSH_RESTART_FILE
      if [[ $code != 75 ]]; then
          rm -f "$file"
          return $code
      fi
      id=$(cat "$file" 2>/dev/null)
      rm -f "$file"
      if [[ -n $id ]]; then extra=(--resume "$id"); else extra=(-c); fi
  done
  ```

- **历史结论（路线 A，已降为可选）**：`$TMUX` 存在时用 `tmux respawn-pane -k -t <pane> <同 profile + --resume 命令>` 原地重启，失败回退界面提示且不退出；通用 spawn（路线 B）需处理 TTY 交接与会话打开竞争，风险更高，不采用。

## 规划与边界

- **待做**：
  - `session fork` 面板联动（宿主 `sessions.fork` 已接入 `/fork`，进一步的面板形态待定）。
- **明确不做**：多会话并行（维持单活跃会话）；thinking 展开 / 收起；flex / grid / 自动布局引擎 / 样式继承 / 嵌套滚动；可复用 Panel 基类或带行为的组件节点；Overlay 覆盖层构造子（面板走内容替换）；renderer 侧承载排版职责。
- **deferred（已评估暂缓，非缺失）**：feedback 评价（低频）；嵌套 markdown 与上下标（低频）；`compaction/summary` 持久化（若要做可读历史另立条目）；`session/end-seed`、`session/title-llm-request`、`request/header`、`request/context`（低价值调试向且 payload 复杂，待调试视图需求出现再做）；`team/*`（实验包依赖）；`web/deepseek-search-llm-request`（log-only）；`subagent/model-selection-policy`、session-log 交付确认（低频 / 内部日志）。

## 实现要点（机制与命令）

> 本节承接原 `IMPLEMENTATION.md` 的机制 / 命令类实现记录（2026-09-29 按「`IMPLEMENTATION.md` 拆分」项迁入）；
> 架构与取舍见本文件前文各节，渲染 / 排版实现细节见 `SPEC.md` §15。

### Slash 命令路由

- 命令分两路：本地命令目录（`LOCAL_COMMANDS`，`commands.ts`，现 40 项 = 35 命令 + 5 别名）由 app 层直接处理；目录未命中者 `/name` → `adapter.runCommand(line)` → `ctx.commands.execute(agent, line, [], signal)`（官方注册表）。
- `App.submit()` 对以 `/` 开头的输入走 `handleSlash()`，不进 `agent.followup`、不占模型 token / 历史。未命中注册表（execute 返回 `undefined`）→ notice 提示未知命令（**官方 fail-close**，绝不把 slash 行发给模型）。demo 模式无注册表，非本地 `/xxx` 直接提示。
- 命令名语法与官方 client 一致：`/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/`（`parseSlashCommand`）。
- 本地命令目录 `LOCAL_COMMANDS`（`commands.ts`）是**路由与补全目录的单一来源**（`routeSlashCommand` 查表，未知名落 registry 转发）；帮助文本与 `/help` 双列表格同源。
- 服务解析：`main.ts` 经 `ctx.get("commands")` 取注册表（cordis 严格模式不允许未注入服务直接属性访问），`commandAgent` 传真实 Agent（注册表作用域查找需要完整 agent，而非 app 的瘦 `DshAgentLike`）。
- **接收者绑定**：caller 侧对 adapter 方法一律以 `method.call(adapter, …)` 保留实例作 `this`——提取为局部变量再调用会让方法体内 `this.xxx` 为 undefined、异步方法恒 rejected、误报「服务不可用」。
- dispose：`App.dispose()` 透传 `adapter.dispose?.()`；adapter 实现中止在途命令的 AbortController、解绑 runtime 监听（collectUnbind）、清空监听集。

**notice 通道**：`DshEvent` 的 `{ type: "notice"; text }`——命令结果 / 错误 / 提示只进 UI 缓冲（`appendNotice`，独立成行，不入流式末行），经 `notice` reducer 落地。级别与着色约定见 `TUI/docs/design/NOTICE-LEVELS.md`。

### 命令实现落点

| 命令 | 机制 | 降级 |
|---|---|---|
| `/init` | 检查会话语义 cwd（`state.systemStatus.cwd`，占位时回退 `process.cwd()`）下的 `AGENTS.md`；缺失则以 `sendUserText(INIT_PROMPT, "/init")` 注入初始化指令（常量在 `commands.ts`） | 已存在则 notice 提示并结束 |
| `/stats` | 读 `state.usage`（**最近一次**模型调用）与 `state.usageTotals`（**本会话累计**：逐次 `usage` 事件求和，`history-resume-ok` / `session-switch` 清零、`clear-buffer` 不清）→ info 四行：最近一次调用分解 / 本会话累计 / 上下文（`input + cacheRead`，窗口缺失或为 0 时只显绝对量）/ 缓存命中率（分母 0 → `n/a`，最近一次调用口径） | 无 usage（新会话 / 刚切换会话，**TUI#12**）→ 四行占位（最近一次 `—`、上下文 `—`、命中率 `n/a`） |
| `/rename` | 纯函数 `renameCommandDecision(line)` 判 usage / invalid / apply；apply → `ctx.sessionTitle.rename(live Session, title)`；标题栏由既有 `session/title` 链路刷新，不手工改 state | 空标题 / 含换行本地拒绝；服务缺失 → warn |
| `/model`、`/provider`、`/effort` | 见下文「/model 命令」 | 目录读取失败 → 提示 |
| `/policy`、`/permission` | 见下文「通用状态选项面板」 | 服务缺失 → 提示不可用 |
| `/session`、`/new`、`/fork` | `listSessions()` / `readSessionSurface(id)` / `deleteSession(id)`；`/new` = `adapter.newSession()`（dispose 旧 handle → `agents.create` 同一 setup/agentOptions/meta 的新会话 → `session-switch` 切过去 + `restoreSessionState` 回默认值）；`/fork` = `ctx.sessions.fork(activeSessionId)`（后两参省略 = 源会话最后事件 + store id 策略） | `/new` 宿主未暴露 `agents.create` → warn 不动作；fork 错误码映射中文 → warn；面板失败入 error 态 |
| `/continue` | **TUI#1/#23**：`listSessions()` → 纯函数 `pickContinueTarget(records, cwd)`（候选 = 同目录非 live 已退出会话 ∪ **当前会话**（仅当 `hasPrompt !== false`）；最新者即当前会话 → `{kind:"current"}` 提示不切换）→ 复用 `/session` 的 `resumeToSession` 路径（先 `history-open` 建面板状态，成功后自动关面板）；CLI `-c` 仍用 `pickRecentSession`（同目录 + 非 live + 编辑时间最大） | 服务缺失 → warn；无匹配 / 已是最新 → info 提示；列表读取失败 → warn |
| `/skills`、`/agents`、`/tools` | 共享列表面板（`refreshSkills` / `refreshAgents` / `refreshTools`）；`Enter` 经 `skillDetail` / `interruptAgent` / `toolDetail`（`interruptAgent` 仅对 continuable 发中断；一次性条目给不可中断原因，TUI#54） | 服务缺失 → warn 且不空开面板 |
| `/task`、`/guard`、`/loop`、`/workflows` | 共享列表面板；`Enter` 经 `taskDetail` / `guardPolicy` / `loopDetail` 取详情（guard 服务**惰读**，见 main.ts 的 `get guard()`）；workflows 为只读 | 同上 |
| `/memory` | `ctx.knowledge.getSummary()`（同步优先，否则 `whenReady()` 等待）→ info notice | 服务缺失 / 失败 → warn |
| `/contract` | 取当前会话 goal 快照 objective → `adapter.contractSummary()` 解析 `Done-when:` 段 → ≤4 行 info | 无目标 / 解析失败 → warn |
| `/council` | `ctx.subagents.start("one-shot", …)` 并行拉起 N（默认 2、上限 4）个评审子代理，`Promise.allSettled` 汇总 | 服务缺失 → warn 不假启动 |
| `/search` | 并行多 provider 聚合（见下） | 全部失败 → warn 不空开面板 |
| `/settings` | `ctx.settings.describe()` → `ns：value` 多行 info，secret 脱敏 `<redacted>`；只读不写 | 服务缺失 → warn |
| `/jobs` | 增量 + 打开时全量拉取：0.1.7 起 `ctx.jobs.events.subscribe({owner})` / ≤0.1.5 `ctx.jobs.onJobsChanged`（按能力择路，都缺则只拉一次）；`Enter` → `ctx.jobs.kill`（caller 形态经版本探测） | 服务缺失 → warn |
| `/goal` | **无本地行为**（2026-10-06 起）：条目仅提供帮助 / 补全描述，`route: "registry"` → `adapter.runCommand(line)` 交宿主 `dsh-command-goal`（无参看状态与可用命令、`<目标>` 新建 / `edit <目标>` / `pause` / `resume` / `clear`），结果经 notice 回报；goal/todo/jobs 详情同时常驻左侧状态列（展示面不依赖命令） | 注册表未命中 → warn（fail-close 不发消息） |

**只读服务面（插件侧提供）**：task-engine `ctx.provide("taskEngine", { query, frameStack })`、metric-loop `ctx.provide("metricLoop", { list, status })`、security-guard `ctx.provide("guard", { recent, policy })`、knowledge-base `ctx.provide("knowledge", { getSummary, whenReady })`。`/contract` 例外：goal-contract 不 expose ctx 服务，TUI 优先用 `opts.goalContract.parseContract`（`ctx.get('goalContract')`），未挂载时走内置同构回读 `parseContractObjective`（定位独占 `Done-when:` 行 + 段后 JSON 数组）；包入口直读不可行（TUI 无跨包依赖、根无 workspaces、`file:` 依赖被项目约定禁止）。

### 共享列表面板（`commandPanel`）

`/skills` `/agents` `/tools` `/task` `/guard` `/loop` `/workflows` `/search` `/jobs`（会话面板另有自己的一套）共用一套 state / reducer / 渲染：

- `state.commandPanel: CommandPanelState | null`（`kind` / `index` / `rows` / `loading?` / `error?`）；reducer 四件套 `command-panel-open` / `-move`（clamp + 窗口平移）/ `-page`（PgUp/PgDn 整页，页高由调用方按活动区可视行数给出）/ `-close`；数据经 `command-panel-data` 事件推送（kind 匹配才写入，挡迟到数据覆盖新面板；`index` 随数据缩短收敛）。
- 渲染为单一 `components/CommandListPanel.ts`（`buildCommandListPanelBox` + `renderCommandListPanel` 薄包装 `fillBoxTree`）：首行标题青 + 计数 + 右侧灰提示（按剩余宽截断），行 = `> ` 高亮 + 可选符号 + 主文本 — 副文本；占位态（错误红 > 加载中灰 > 空列表灰）输出恰 `height` 行。
- **接线（现状）**：`layout.buildActivePanelBox` 按优先级选型（`commandPanel` 在 `jobsPanel` 与 `history` 之间）；`frameGeometry` 的 `modalOpen` 一次性判定 7 类面板非空（approval / question / picker / statusPanel / jobsPanel / commandPanel / history），`normalInput = !modalOpen`、`showHint` 随之派生——布局层已无独立的 `normalInput` / `modalOpen` 条件拼接；`inputPanelHeights` 提供翻页页高（与面板窗口同口径）。
- 键位在 `handleKey` 面板段：`↑/↓`、`PgUp/PgDn`、`Enter` 主操作、`Esc` 关闭、其余吞掉（面板打开时不可输入新命令）。面板占满活动区期间瞬态输出不可见，故 Enter 类主操作若以 notice 反馈，先关面板再提示。
- **多轮任务的轮次标注（`/task`，2026-10-05）**：task-engine 多轮后 `query().tasks` 是森林（轮根 `root` / `root-2` / `root-3…`，旧轮只读），而面板是平表 —— 森林 > 1 棵时 `refreshTasks` 给**各轮根行**的行首加标注（`旧轮 n · ` / `当前轮 n · `，轮次取 `round`，旧版引擎回落轮根序号），子帧行与单轮不加。标注必须在 title **行首**：渲染是 `title — detail` 单行右截断（`CommandListPanel.ts`），detail 尾的内容在窄面板首个消失。标注只在该行映射里加，不写进 `flattenTasks`（`findTask` / `taskDetail` 复用同一函数，详情不加轮次行）。
- **面板保鲜**：`/agents` 与 `/workflows` 在面板打开期间定时重拉（`startPanelRefresh`，默认 2s，`agentsRefreshIntervalMs` 可注入；tick 自检面板仍为自身否则停表），`/agents` 另有 `r` 手动刷新；**TUI#10** 起 `/agents` 还订阅宿主 `subagent/start` · `subagent/end`（adapter emit `subagent-activity`）在面板打开时即时重拉，2s 定时退为兜底（老宿主无此事件时静默）。

### 非显然实现要点

- `/search` 的**多引擎聚合是 TUI 侧职责**：`dsh-web` seam 是 provider-**selecting**（`search()` 只跑单个 provider，多 provider 无显式 id 抛 `WEB_PROVIDER_AMBIGUOUS`）。`aggregateSearchSources` 纯函数（`dsh.ts`）组装 provider 集合（`opts.web` 派生 + `options.searchProviders` 注入），`Promise.allSettled` 并行调用 → 合并记 provider → URL 去重 → query-token 关联度（title 命中 ×2 + snippet ×1）降序（同分保合并顺序）→ 截断 `maxResults`（默认 10）。
- `/contract`、`/council` 的目标取当前会话 goal 快照 objective，无 goal 时回退 buffer 最近 user 行。
- `/agents` 数据源按宿主能力择路：0.1.7 起优先 `subagents.listDescendants(rootSessionId)`（富条目，取 `depth=1` 的直接子代），≤0.1.5 用 `listChildren(parentSessionId)`（同形富条目）；`kind:'diagnostic'` 条目灰显且 payload 置空（无可中断 id 时只提示、不发调用）。投影目录形态（0.1.7 的 `listChildren` 返回 `{id,createdAt,mode,label?}`，无 activity/hasChildren/diagnostic）下 `status` 退用 `mode`、标题缺 label 时占位 `(未命名)`。
- `/session` 的 live 会话读取走 `Session.events` 原始事件（`readSurface` 的 surface fold 会滤掉 `surfaceOp`，`readSession` 的全量校验对 live 混合日志会抛校验错）；persisted 会话走 `readSurface`，兜底 `readSession`；`readSurface` 必须直接调用 `sq.readSurface(id)`（解构丢失 `this` 读 `_corpus` 报错）。
- `/session` 批量删除：`Space` 标记 / 取消（标记后高亮自动下移一行）、`a` 全选当前范围可删项（替换标记集）、`c` 清空；判据 `deletableSession`（persisted + 非 live + 非当前），`deletableSession` / `markableSessionIds` 为 `state.ts` 纯函数。标记按 id 记录并跨 `Tab` 范围切换保留；`d` 有标记 = 批量（`pendingDeleteIds`，跨范围保留的标记也计入、自动剔除已不可删项），无标记 = 单条（`pendingDelete`）。批量与单条共用 `runPendingHistoryOp` 的逐条 `deleteSession` 串行删除循环，成功集经 `history-delete-done` 移除记录（`dropHistoryRecords`），**失败项保留标记**便于重试；列表重拉只一次。
- **编辑时间与列表顺序（TUI#1；行内时间口径见 TUI#22）**：`listSessions` 归一化抽为模块级 `listSessionRecords`（单一来源，adapter 与 CLI 启动解析共用）——每条记录 `updatedAt` = `sessionQuery.listEvents(id)` 末条事件 `time`（轻量面；无事件 / 读取失败回退 `createdAt`），记录按 `updatedAt` 降序（并列 `createdAt` 降序、id 兜底）；`/session` 面板与 `/continue` / CLI `-c` 共用该顺序，选择函数 `pickRecentSession(records, cwd)`（同目录 + persisted + 非 live + 编辑时间最大）。**列表行首时间显示该 `updatedAt`（缺省回退 `createdAt`，TUI#22）**，与排序同口径；`hasPrompt` 探针（TUI#23）覆盖**当前活跃会话**（有官方标题也不跳过），供 `/continue` 的「最新会话」判定。
- **TUI 自有启动参数（TUI#2）**：`apply()` 经 `ctx.cmdlineArgs.get()` 读取宿主内层参数（只读不消费），纯函数 `parseTuiStartupArgs` 解析 `--resume <id>` / `--resume=<id>` / `-c` / `--continue`（`--resume` 优先；未知参数与缺值忽略）；命中即走 `agents.resume`（同一 `setup` / `agentOptions`），失败或 id 无效 → stderr `[tui] warn` + 回落 `agents.create`；`-c` 无匹配 → 静默新建。**读点约束（TUI#19 回归修复）**：宿主服务随插件树**并发装载**，`sessionQuery`（`dsh-session-query-sqlite`，`inject:["sessions"]`）的 provider 常晚于本插件（`inject:["agents"]`）就绪——adapter 选项一律在 handle（create/resume）就绪后经 `readSessionQuery()` 读取，绝不复用 apply 早期读值（否则历史会话整体不可用）；`-c` 决策读点无法后移，改用 `waitForHostService(read, 3000ms)` 有界等待（超时按未挂载 → 无匹配处理，不阻断启动）。回归：`tests/main.config.test.ts` 的 `waitForHostService` 三例。

### 文本管线（流式 / 清洗 / 补发）

- **sanitizeText（渲染保护）**：流式文本进 buffer 前清洗——CRLF / 孤立 CR 归一为换行（否则 `\r` 残留被终端当回车、抹掉整行造成大段空白），其余 C0/C1 控制字符（含 Tab、孤立 ESC）剔除，完整 ANSI 转义序列（CSI / OSC）保留（渲染着色功能，`/copy` 时再剥离）。剔除计数入 `state.strippedChars`（turn-begin 清零），turn-end 后以黄色 notice 提示。恢复历史（`surfaceToBuffer`，P9 起由事件折叠产出 step 概要行）同样走清洗，整条纯空白文本直接丢弃。
- **非流式回复补发**：`assistant/message` 是每个 step 结束必发的完整正文 surface 事件。adapter 按 `(session:turn:step)` 累计已流式输出的正文（reasoning 不计），该事件只补发缺失后缀；非流式 / 无思考 provider（无任何 chunk）累计为空 → 直接输出完整正文。`surfaceOp: replace` 的影子覆盖事件跳过（append-only 无法安全重写）；`turn/end` 与 dispose 清空累计。
- **消息 identified**：`buildUserMessage` 用 `crypto.randomUUID()` 生成稳定消息 `id`——`agent/inbox/spliced` 与 `user/message` 均带 identified 标记；缺 id 会导致后续 `agents.resume` 全量校验抛 `SessionPersistenceCorruptionError`（会话永久不可 resume）。
- **空白分片丢弃（P5）**：宿主每个 step 末尾常补发「只有换行」的文本块（实测 190 个文本分片里 154 个是 `"\n\n"`），逐行落 buffer 会在思考 / 工具行之后留下成片空行。判据：整段仅空白 **且**（上一行是异 kind 或 buffer 为空）才丢弃；同 kind 内部的空白分片维持现状（软换行与段落空行语义不变），也不做段尾空行清理。丢弃后置 `streamBreak`，使下一条流式分片另起一行（不并入末行、不粘行：否则两个思考分片会被粘成一行、原本的空行变成缺空格）；流式分片消费后清位、非流式分片不动。回归：`tests/p5-blank-chunk.test.ts`。
- **恢复会话按 step 概要（P9）**：resume 不还原逐条工具行，而是折叠事件流（`adapter/dsh.ts` 的 `normalizeHistoryMessages`）——每个**含工具调用**的 step 收口成一行 `[hh:mm:ss ]#N ╌╌ 工具名[×次数], …[ ✗失败数]`（时间缺失省略时间片段；失败判定与实时路径同口径——`tool/result.error` 存在即失败），无工具调用的 step 不出行；参数摘要 / 结果详情 / thinking 不还原。整条纯空白文本直接丢弃，不再产出空行。`commands.ts` 的 `surfaceToBuffer` 把 role `"step"` 原样转成 buffer `kind:"step"`，`build-box` 按 `╌╌ <文本> ` + 尾部 `╌` 铺满渲染（与 P6 实时 step 头同形制、同落历史区）。回归：`tests/resume-summary.test.ts`。
- **零宽字符宽度**：`charWidth` 对组合附加符 / 变体选择符 / ZWJ / ZWSP / emoji 肤色修饰符等计 0 列（对齐 Markus Kuhn wcwidth 零宽表），避免工具内容夹带特殊字符时总宽度虚高或提前换行。

### 事件 → 状态 → 渲染

完整映射与渲染语义见 `TUI/docs/DESIGN.md`「事件接入与渲染」。实现要点：

- raw 事件由 adapter 归一化为 `DshEvent` → App 事件 switch → state reducer → `buildFrame`；`DshEvent` 为封闭联合，新增成员需同步 `index.ts` 穷尽登记（否则 `npm run check` 失败）。
- tool 行文本由 `layout/tool-line.ts` 纯函数组装（step 分组头 = `stepHeaderLine(step, time)` → `hh:mm:ss #N`，P6：本地时区 24 小时制逐段补零、时间缺失只出 `#N`；渲染层补 `╌╌ ` 前缀与尾部 `╌` 铺满）；summary / detail 启发式由 adapter（`dsh.ts`）在归一化时产出。结果行 = `✓ <detail>` / `✗ <detail>`，**detail 为空按上表省略**（成功只出 `✓ `，行尾空格是前缀契约）；分组 / 着色按**符号**判定（`content-rules.ts` 的 `TOOL_STATUS_PREFIXES` / `renderToolText` 不依赖尾随空格，勿 trimEnd 结果行）。
- **压缩期间算活跃（P8）**：`compaction/start` → `compaction/end` 期间按会话记 `compactingBySession`，`isCompacting(state)` 供 `index.ts` 的 `agentBusy()` 判定——该会话视为忙：用户块符号显示运行中 `●`/`○`、Enter 提交走排队、`Ctrl+D` 退出守卫不触发（`Esc` 中断语义不变）。回归：`tests/p8-compaction-active.test.ts`。
- **状态符号渲染位置（P1）**：符号在排版层算定（`userBlockSymbolResolver` → `USER_BLOCK_SYMBOL`；终态由 `turn/end` 的 reason 经 `markUserBlockStatus` 打标到 `BufferLine.status`），`build-box` 只负责把 `符号 + 1 空格` 拼到用户块首行左侧（在块内部，块右缘位置不变；排队块不出符号）。水平状态栏不再有符号段。回归：`tests/app.test.ts`（用户块首行符号与 SGR / turn-end reason 打标）/ `tests/layout4.test.ts`。
- **seq 守卫**（per-session 游标）：`event.seq <= lastSeq` 丢弃；间隙接受不补缺；非活跃会话丢弃。

### 会话状态恢复（模式与策略 / 模型 / goal / todo / TUI 本地开关）

切换会话（`/session` Enter → `agents.resume`）与启动时都不重放历史事件，故 `App.start` /
`resumeToSession` 成功后调用 `adapter.restoreSessionState?(id)`（adapter 侧 `restoreSessionState`），
折叠**宿主日志**与 **TUI 侧快照**两份来源并 emit 对应事件：

- **宿主日志**（live 内存事件优先，其次 `sessionQuery.readSession`；**不能用 `readSurface`**——
  log-only 事件被 surface fold 滤掉）：
  - `plan/mode` / `sandbox/mode` / `permission/preset` / `approval/policy` 末条 → `mode` /
    `approval-policy`（原 `emitSessionModeSnapshot` 能力）。P7 起这批值渲染为**标题栏符号组**
    （plan / sandbox / 审批策略各出图标；`permission` 不再显示，仅随快照保存与兜底）；
  - **模型**：末条 `model/selection`（显式意图）→ 末条 `request/header.header.config`
    （该会话最近一次**实际使用**的 provider / model / effort；TUI 的 `/model` 也记在这里）；
  - **goal**：按 seq 顺序回放**全部** `goal/change`（state 侧按会话累积成 goal 历史：index 0 =
    当前 goal、其后为旧 goal）；**activation 不回放**——`goal/activation-changed` 是进程本地事件、
    不进会话日志（重启后宿主不发事件），故无记录时**不显示** `⟳`（不再推导为 `disarmed`）；
    **todo**：末条 `todo/write`（全量快照事件，latest-wins）→ 回填状态列。
- **TUI 侧会话状态快照**（`<会话目录>/tui-state.json`，`adapter/session-ui-state.ts`）：
  `/model` 结果、`/collapse`、`/symbol-unify`、模式兜底值与 **`statusColumn`（P7：垂直状态列
  显隐，`Ctrl+S` 切换）**。宿主不认识 TUI 本地开关，「已选但尚未发起请求」的模型也不在日志里
  ——这两类只有快照能恢复。

`/new` 走同一条回填路径：新会话既无日志事件也无快照 → 各旋钮回默认值（plan off、
sandbox/permission 取宿主默认预设、模型回到 config 种子），无需额外重置逻辑。

每项取值优先级 = 宿主日志 → 快照 → 宿主默认（`permissionPresets.defaultPreset` 捆绑；
plan 无记录即 off）。模型命中即写回 `sessionModel.current`（`agent/request` 钩子的生效源，
也是 `/model` 面板与状态栏的显示源）；三者皆无则**清空**该引用回落宿主实时默认——顺带修掉
「同进程内 A 会话的模型选择泄漏进 resumed 的 B 会话」。

落盘时机：`/model`、`/collapse`、`/symbol-unify`、`Ctrl+S` 状态列显隐与 mode / policy 事件 → 400ms 合并写
（`SESSION_STATE_SAVE_MS`）；切换会话前与 `dispose()` 前 `flushSessionStateSave()` 立即写。
快照随会话目录走（会话删除即随之清理）；仅内存会话（无持久化目录）静默跳过；文件损坏 /
版本不符 / 字段类型不符按「无快照」或逐项丢弃处理，绝不影响渲染。回归：`tests/session-ui-state.test.ts`（含 `statusColumn` 字段的读写与类型不符丢弃）+ `tests/status-column.test.ts`（垂直状态列基础块渲染）。

### 滚动偏移收敛（越界假死）

- **现象**：上滚历史（或按 `Home` / `End`）后按 `↓` 画面纹丝不动；发送消息后更容易撞上。
- **根因**：`scrollOffset`（对话区）/ `activityScroll`（活动区）无上限——连续上滚越顶会一直累加，`End` 曾直接置 `Number.MAX_SAFE_INTEGER`；渲染层只在显示侧 clamp，状态里留着越界值。此后下滚每按一次只是「还债」一格，差额大时等于永久卡住。
- **修复**：状态里的偏移恒在真实范围内——`buildFrame` 出帧时顺带回填 `FrameScrollReport{dialogueMaxScroll, activityMaxScroll}`（零额外排版开销；对话区上限取**未折叠**全量行数 − 可视行数，上滚会解除折叠，折叠态上限偏小不能作上界）；App 侧 `paneMaxes()` 取上限（出帧回填过就直接用，否则就地补算一次同口径帧）；`scrollBy(state, delta, maxOffset?)` 与 `activity-scroll` action 先收敛当前偏移再叠加 delta、结果不超上限；`End` 改为真实上限。
- **回归**：`tests/app.test.ts`（上滚越顶后 `↓` 立即响应 / `End` 后 `↓` 立即响应 / 活动区同理）+ `tests/layout4.test.ts`（回填值在折叠态下仍为未折叠全量）。

### 排队消息（agent 运行中 Enter）

- **发送完全走官方流程**：`App.submit` 在 agent 忙（`agentStatus !== "idle"` 或本地 `inputStatus === "running"`，覆盖「刚提交、核心状态事件未到」窗口）时仍立即 `adapter.sendMessage(text)` → 核心 `followup`（`next-turn` 队列，durable）——逐条、不合并、不由 TUI 积压；空闲时走 `sendUserText`（本地回显 + 直接发送）。两条路径发送语义一致，**差别只在显示**。
- **显示登记**：`state.queued: string[]`（按提交顺序）+ action `queued-push` / `queued-claim`（弹出最早一条并落入历史）/ `queued-clear`。登记只用于渲染，不代表 TUI 持有消息（消息已在核心队列里）。
- **认领时机**：`beginTurnIfNeeded()` 在 `turn-begin` 之后 `queued-claim`——核心每开一个新回合从 `next-turn` 认领一条，UI 因此「每回合转正一条」；转正后按普通用户行渲染（亮红右缘竖线）。
- **渲染**：`queuedBlockRows` 以 `BufferLine{kind:"user", queued:true}` 走同一套 `buildContentRows`（右对齐 + 竖线着色按类型：`followup` 灰 / `steer` 黄，TUI#43），得 `geom.queuedRows`；对话 pane 最后 `queuedRows.length` 行渲染排队块（钉在右下角、不随历史滚动），历史视口高 = `dialogueH − queuedRows.length`（至少留 1 行历史；超长取尾部）。
- **Esc / Alt+Enter**：Esc 先 `restoreQueued()`（登记按顺序并回输入框，核心 `cancel` 会清自己的队列，本机留底不丢输入）再 `interrupt()`；Alt+Enter 同样先并回输入框、打断，然后整条发送（避免「新文本先发、排队内容后发」顺序颠倒；空输入且无登记仍为 no-op）。切换会话（`history-resume-ok`）时 `queued-clear`。
- **回归**：`tests/app.test.ts`（运行中 Enter 立即发送且逐条不合并、登记不写 buffer、新回合认领一条转正、Esc 退回输入框 + 清登记 + 打断、Alt+Enter 按序并入）+ `tests/layout-horizontal.test.ts`（排队块位置 / 灰竖线 / 视口高收缩）。

### 模型输出符号规范化（已迁出为 symbol-normalizer 插件）

> 2026-09-27（原 TUI 待办「符号规则归一」/ 项目级「symbol-normalizer 插件」）：符号规则与算法（`app/symbols.ts`）整体迁出为独立插件 `symbol-normalizer`；算法细节与规则表见该包 `README.md` / `docs/DESIGN.md`。TUI 侧接入：`case "stream"` 经 `ctx.get('symbolNormalizer')` 服务 `normalize`（`/symbol-unify on|off` 控制）；notice 经 `onReview` 回调渲染为 warn 行；模型提醒由插件在 rule-engine 消费者 `decide` 中返回、rule-engine 统一注入。插件未挂载 → 原文透传、无提醒。配置迁至插件 config（`tui.config.json` 的 `symbols` 段不再读取）；纯函数 / 冷却用例迁至 `symbol-normalizer/tests/`，TUI 侧保留服务消费用例（`tests/app.test.ts`「符号服务消费」组）。宽度实测与治理规则解耦：改为**按需触发**（排版遇到「呈现不确定」字符时登记，写屏前批量 `CSI 6n` 实测、落盘复用；见 `SPEC.md` §15.7），不再走启动期符号集探测。

**选型判据**（随实现迁至插件，历史记录保留于此）：

1. 归一依据 = **形状身份（几何部件组合）**；功能、语义、宽度一律不参与。
1. 同一形状身份内只容**修饰性变体**归一：粗细、大小、重复数量、emoji 上色、内缀细节；**明暗 / 填充（空心 vs 实心）不是修饰**——空心、实心各为独立一族。
1. 触发**拆分**（不归一，按几何各自独立）：明暗 / 填充、新增独立部件（方框）、核心形状变化（圆环 vs 实盘、勾 vs 根号）、方向 / 对称变化（反向、双向 vs 单向）。
   - 校准点：`☑` / `☒` 与追加符号区 `🗹` / `🗷` 为**特例**（虽带独立方框，不各自成族也不拆分提醒，并入无框的 `✓` / `✗` 族）；`√`（根号）治理区外放行；`⏩⏫⏬`（双三角 = 数量 / 速度修饰）归入 `▶` / `▲` / `▼`；C 族短双线 `⇒⇐⇔` 按方向归一到长双线代表 `⟸⟹⟺`；空心三角族 `▷◁△▽` 四向代表入白名单、族内尺寸 / 指针变体归一到该向代表，与实心族不互相归一。

### 自动清理空会话

- **config**：`tui.config.json` 的 `session.autoCleanEmpty`（缺省 true，显式 `false` 关闭）；`normalizeConfig` 归一化（非法回落 undefined，默认由消费方应用）；`main.ts` 取 `loadTuiConfig().session?.autoCleanEmpty ?? true` → `AppDeps.autoCleanEmpty`（需 `=== true` 才生效）。同一开关覆盖**启动**与**优雅退出**两个时机。
- **判据**：`startupCleanableIds(records)`（`state.ts` 纯函数）——已持久化 + 非 live + 非当前 + `isEmpty`（无用户消息），全目录范围，与面板 `cleanableSessionIds` 同语义但不依赖面板状态。
- **共享核心**：`cleanableSessionIdsViaAdapter()`（`listSessions()` 全量 → 判据过滤；列表缺失 / 读取失败返回空）+ `deleteSessionIds()`（逐个 `deleteSession()` 串行删除，复用 `/session` 面板同一守卫，返回成功 / 失败计数）。
- **启动执行**：`App.start()` 末尾 `if (this.autoCleanEmpty) void this.runStartupCleanEmptySessions()`（后台异步，不阻塞首帧）——notice 汇报「已自动清理 N 个（M 个失败）」。
- **退出执行**：`App.dispose()` 开启时走 `disposeWithExitClean()`——先 `runExitCleanEmptySessions()`：有可清理项时把提示渲染到活动区（`paintExitNotice`：dispose 已置 `disposed = true`，常规 notice / paint 被守卫拦截，且 10Hz 合帧可能把标脏推迟到关终端之后——故同步 apply + render 直接落屏）并等待完成，结果与耗时同样渲染到活动区，完成后才释放 adapter / 关闭渲染器；无清理项静默。等待受 `EXIT_CLEAN_TIMEOUT_MS`（5s）兜底，超时渲染提示并继续退出。
- **降级**：宿主未挂 `sessionQuery`、列表读取失败或无可清理项 → 静默跳过；删除失败计入失败数，不让启动 / 退出失败。
- **测试**：`tests/session-delete.test.ts`（启动清理 3 例 + 退出清理 4 例 + `startupCleanableIds` 纯函数 1 例）+ `config.test.ts` session 归一化 1 例。

### 声音提醒事件钩子（BACKLOG 3.4.1-3.4.3）

- **输出口**：`Renderer.bell?()`（可选接口方法；真实 renderer 实现 → `Screen.beep()` 向输出流写 BEL `\x07`；注入型 renderer 可不实现，App 经 `bell?.()` 调用）。
- **config**：`notify.enabled`（缺省 true）、`notify.idleThresholdMs`（缺省 8000、最小 1000，由 `normalizeConfig` 归一化；3.4.3 复用它作「需交互无操作」阈值）；AppDeps 直传（测试可用小值）。
- **turn-end**：`App.onTurnEnded()` 经 `ringBell()` **只响一声**——BACKLOG 3.4.2 去掉了原「随后 `setTimeout(idleBellMs)` 补响一次」，一次 run 结束不再听到两声（催促职责归下面的需交互响铃）。
- **需交互（3.4.1 / 3.4.3）**：审批 / 问答事件分支调 `beginInteractiveBell()`——面板弹出即 `ringBell()` 一声，并起 `pendingBellTimer(idleBellMs)`；超阈值仍无操作 → `repeatBellTimer` 每秒 `ringBell()`，直到用户有操作或面板关闭。`handleKey` 入口（任意键，含无效键——人在终端前即算操作）与面板关闭（`apply` 里 approval/question 由有变无，覆盖提交 / 取消 / 超时全路径）调 `clearInteractiveBell()` 停止且**同一次交互不再重启**；`dispose()` 清理两个计时器。`bellEnabled` / `disposed` 双检查防关闭后误响。
- **测试**：`tests/notify-bell.test.ts` 8 例（turn-end 只一声 / 无输入与有输入都不改次数 / enabled=false 全程不响 / 审批与问答弹出即响 / 超阈值每秒催促且按键即停 / 面板关闭停催促 / dispose 清理 / 真实 renderer 输出 BEL）+ `config.test.ts` notify 归一化 1 例。

### /model 命令

- 能力：查询可用模型 + 切换当前会话模型（写回会话内引用 + 记入会话状态快照，切回该会话时恢复）。
- `/model` 无参 → 交互选择面板（渲染在活动区窗口）：`↑/↓` 移动高亮、`←/→`（或 Tab）切换 provider / model / effort 三列焦点（clamp 不循环）、`Enter` 确认、`Esc` 取消；普通字符键被忽略（不进入输入框）。`/model <provider>/<model>` 直接切换；`/model <modelId>` 跨全部 provider 唯一匹配（未匹配或歧义 → 错误提示，不落盘）。`/provider` `/effort`（`/thinking`）无参调用同一面板并预置焦点列（0 = provider、2 = effort）；带参仅提示 usage。
- **状态与 reducer**：`state.picker`（`PickerState`：options + index + phase + efforts + effortIndex）+ `picker-open` / `-move` / `-tab` / `-phase` / `-efforts` / `-close`。渲染为 `components/ModelPicker.ts` 纯函数（输出恰活动区可视行）：三列独立列表同屏，头部全小写；当前模型恒为首行标 `*` 附 `[current]`，焦点行标 `>` 并加粗。等级列表经 adapter `modelEfforts(provider, model)`（宿主 `llm.resolveModelInfo` → `reasoning.efforts`；非思考模型返回 undefined，面板显示 `effort: (unsupported)`）异步加载；`metricsFor` 的 picker 高度预算取模型列表与等级列表较大者；宿主等级名首字母大写，adapter 归一为小写再展示（与状态栏 `model:<等级>` 后缀同源）。
- **列宽分配**（`pickerColumnWidths`）：三列自然宽 = 各自最长选项显示宽（含行前标记 2 列，effort 无选项时按标题宽兜底）。空间充足时按自然宽比例分配（余数按最长列依次补 1），不出现大片留白；空间不足改用水位法（同 `table.ts`）——短列保持自然宽、只有超宽列被压到共同水位线；极窄（可用宽 < 3）退化为「首列吃其余、后两列各 1」。
- **星号选中语义**：phase 0 仅移动 `providerIndex`；`selectPicker` 在星号移到新 provider 时才把 model 列表切到该 provider、`modelIndex = 0`、旧 `selectedModel` 失效（effort 列表清空由 App 重载；思考等级星号在新列表中存在才显示），重选同一 provider 幂等；phase 1 选中保留 `selectedEffort`。`App.reloadPickerEfforts()` 目标为选中（星号）的 model / provider（未选中回退焦点行）。`Enter` 提交走 `resolvePickerSelection`「星号优先、焦点兜底」。
- **切换语义**：只改会话内 `SessionModelSelectionRef.current`（经 `installSessionModelSelection` 挂到 agentCtx 的 `system-prompt/assemble` + `agent/request` 双钩子，下一 step 生效，快照保证不撕裂当步请求）；**绝不调用宿主 `agentDefaultModel.saveSelection()`**（避免覆盖配置中的默认模型）。有效选择 = 会话内切换 ?? 宿主实时默认（`currentSelection()` 只读兜底，不做一次性快照以免异步 publish 时序吞掉设置）。切换时保留当前 `reasoningEffort`，不提供 effort 参数。
- **接线**：`main.ts` 的 `apply()` 在 `agents.create({ setup })` 中把 `installSessionModelSelection(agentCtx, sessionModel, () => readDefaultSelection(defaultModelSvc))` 挂上，并把同一 `sessionModel` 引用 + 只读 `defaultModel` 兜底传入 `createRealDshAdapter`（结构面 `LlmLike` / `AgentDefaultModelLike`，零运行时依赖）。
- **状态回显**：切换成功后 `systemStatus.model` 更新为 `provider/model` 并写入 notice；`App.start()` 读取 `modelCatalog().current` 写入 `systemStatus.model`。宿主 `agentDefaultModel` 需等 LLM provider 注册后才返回真实路由，故改为常驻跟随 `StatusTicker` 的 5s 周期（值变更才重绘）。
- **持久化与恢复**：`/model` 只改会话内 `sessionModel.current`（**绝不写宿主 `agentDefaultModel.saveSelection()`**，避免覆盖配置默认模型），同时记入 `state.modelBySession` 供会话状态快照落盘；resume / 启动时按「宿主 `model/selection` → 快照 → 最近 `request/header.config`」恢复并写回引用（详见「会话状态恢复」）。仅内存会话（无持久化目录）没有快照，此时退化为宿主日志口径。

### 命令输入补全

- `completeCommandInput(text, extra, mode)` 做前缀匹配（名称短 → 长排序，`items[0]` = 最匹配）、**不设硬上限**、同名以本地优先去重；`mode = slash` 时先把「无前导 `/` 的输入框文本」归一为字面 `/name` 再判定（slash 模式的 `/` 由 `App.submit` 提交时才补）。宿主目录经 `adapter.commandList()`（官方 `commands.list(agent)`，仅取 name / description，缺失 / 抛错 → undefined 降级为仅本地命令）。
- 候选存入 `state.completion`，**唯一计算点在 reducer**：`input` action（`setInput`，所有编辑键的唯一漏斗）、`input-mode`（切换模式重算）、`command-catalog`（宿主目录到达）。
- 展示复用活动区覆盖层（`components/CommandCompletion.ts`，与审批 / 问答 / picker / 各面板同一渲染链；footer **不**空白占位——补全不占输入区，输入行与光标必须可见）。面板 = 标题 1 行 + (activityH−1) 行候选，候选池足够时铺满活动区（曾设硬上限导致活动区高时底部留白，已移除）；**超出可视行的候选直接丢弃、不滚动窗口**——渲染只取前 activityH−1 项，App 侧 `completionVisibleRows()` 给 `completion-move` 传 `max`，把 `↑/↓` 与 `Tab` 接受也限定在可视范围内。键位提示不放面板内，而在输入区下方的按键提示区（`layout/hints.ts` 的 `COMPLETION_HINT_LINE`；提示区恒 1 行、任何状态都在，文案统一由 `hintLine(state)` 按状态给出）。
- 按键：`Tab` 接受（写命令名 + 尾随空格，slash 模式不写前导 `/`）、`↑/↓` 移动（在 `handleKey` 的 normal 分支先于面板滚动）、`Esc` 收起（不打断运行）、`Enter` 保持提交语义。

### 通用状态选项面板（`/policy` `/permission`）

- 无参统一打开 `statusPanel`（`components/StatusPanel.ts`，活动区窗口，与审批 / 问答 / 模型选择同区域）。状态 `StatusPanelState{kind,title,options[],index,selected}`（`state.statusPanel`）；reducer `status-panel-open/move/select/close`。提交路径：policy → `setApprovalPolicy`；permission → `runCommand("/permission <name>")` 转发宿主。（原第三条路径 preset → `selectAgentPreset` 随 `/preset` 命令 2026-10-02 删除。）
- 交互：`↑/↓` 移动焦点、空格预选星号（再按取消）、`Enter` 提交预选（无预选回退焦点行）并关闭、`Esc` 取消；当前策略来自 `state.policyBySession[sid]` 事件回读。着色：预选行绿、未预选的焦点行黄，同一行兼具时绿优先。
- plan / sandbox 无宿主写接口，暂不开放面板；goal / todo 保持只读状态列。

### 问答 / 审批面板：两窗滚动、编辑光标与审批交互（BACKLOG 3.2.1 / 3.2.2 / 3.2.3 / 3.2.4 / 3.2.5 / 3.2.6 / 3.2.7 / 3.2.10 / 3.2.12 / 3.3.1 / 3.3.2 / 3.3.3 / 3.3.4 / 3.3.5 / 3.3.6 / 3.3.7 / 3.3.8）

- **两窗模型与分配**（3.2.1 / 3.2.11）：`components/QuestionPrompt.ts` 把面板体（`height − 1`）拆为描述窗（题干 + detail）与选项窗（选项 + 自定义兜底项）。分配：描述窗上限 `descMaxRows = max(1, floor(maxBody × 2 / 3))`，描述窗可见行 = `min(内容行数, descMaxRows, maxBody)`，选项窗 = 剩余行（不设上限）。效果：内容不足时两窗紧邻、空白落活动区下方；合计溢出时**选项窗先滚动**（描述窗仅在自身超 2/3 时滚动）；描述窗滚动上界按固定 `descMaxRows` 算，到底后反向按键即时响应。长题干 / 长 detail 不再把选项挤出可视区。
- **焦点窗与按键**：`state.question.items[i].focus`（`desc` / `options`，缺省 `options`）+ `descScroll`；Tab 切窗（`question-focus`），焦点在描述窗时 ↑/↓ 走 `question-desc-scroll`（`max` 由 App 用 `frameGeometry` + `maxDescScrollFor` 算定后传入，state 层不感知折行宽度），选项窗时 ↑/↓ 仍走 `question-move`。选项窗起点由 `windowStart(..., "tail")` 算：焦点项优先，焦点在描述窗时锚定首个已标记项（标记不被滚出视野）。状态选项面板（`StatusPanel.ts`）改用 `windowStart(..., "center")`。
- **标题与选项形态**（BACKLOG TUI#4；2026-09-27 真机目视改判）：问答面板不显示标题行——单题标题区 0 行（首行即题干），多题 1 行「题号 + 符号」（如 ` 1● 2□ 3△`，当前题黄且实心——空心 → 实心见 BACKLOG TUI#1、超宽截断补 `…`，其下直接是题干）；**题号导航已移除**。列宽改走 `charWidth`（与 fill / 渲染器 / 宽度探针同源，两处本地 `chrW` 副本已删）。选项解释另起一行并与选项正文左对齐（内容起点 = 编号宽 + 6 列、数字悬挂；3.2.3 / 3.2.12），光标 `>` 与标记 `✓` 只在选项首行（标记统一为 `✓`，不再区分单 / 多选）。审批面板标题 ` △ 等待审批`（类型符号与状态标记 △ 合一、整行黄），并把 `prompt` 的硬截断改为按 `state.approvalScroll` 滚动（↑/↓ 在审批态生效，其余按键仍吞掉）。
- **描述窗 markdown**（BACKLOG TUI#6）：`panelMarkdownRows`（`layout/panel.ts`）按行分类渲染——fence 标记行与其内部行 → `wrapCodeLine`（面板自持 fence 状态）、含 `|` 的行 → 普通文本折行（**表格退回纯文本**）、其余 → `wrapAssistantLine`；产出**样式段行**（不含行首 1 列，渲染时补空格 / 滚动条），由 `PanelLine.segments` 承载（题干 / detail / 审批草稿；提问前正文段与选项行仍纯文本）。面板 API 增 `themeId`（缺省 `dark`）：`buildQuestionPanelBox` / `maxDescScrollFor` / `questionCaretFor` / `renderQuestionPanel`、`buildApprovalBox` / `maxApprovalScroll` / `renderApprovalPrompt`，调用点由 `layout.ts`（`state.themeId`）与 `index.ts` 传入。审批草稿的「命令：」段走代码块（`CMD_LABEL`，命令原文不被行内语法改写）。
- **编辑光标**：焦点在「自定义回答」兜底项且该行在窗口内时，`questionCaretFor` 产出面板内 0 基 caret；`buildFrame` 拼帧时写入对应帧行的 `caret`（列 = 活动区正文起始列 + 面板内列），`frameFocus` 的 `inputFocus` 随之为 true（`!modalOpen || 帧内出现 caret 行`），渲染器据此定位并显示光标。
- **提示区与焦点可见性**（3.2.1 / 3.2.8）：`questionHintLine` 以**显式前缀**标出当前焦点窗（`▶选项` / `▶题干`），其后才是 `[↑/↓]滚动` / `[↑/↓]选项` 与 `[Tab]描述` / `[Tab]选项`；各项用紧凑分隔符 `·` 连接——七项全列在 80 列终端为 70 列（`·` 会撑到 82 列并截掉尾部切题提示，实测）。面板内描述窗左侧 1 列按内容是否超屏渲染：**超屏时是滚动条**（轨道 `│` 灰 + 滑块 `┃`，长度按可见/总行数比例、位置按偏移比例；聚焦时滑块黄、失焦灰），**不超屏时是纯焦点指示**（聚焦整列黄 `┃`、失焦空格）；聚焦描述窗时选项光标行降色（不再黄、已标记仍绿），全屏只有一处焦点黄。审批面板草稿滚动条同理，滑块恒黄。面板可用宽 = `width − 2`（原 −4，内容行右侧留白偏多，人工验收反馈后收紧）。
- **测试**：`tests/question-window.test.ts` 9 例（分窗可见性 / 描述窗滚动上界与 clamp / Tab 与 ↑↓ 分派 / 已标记项可见 / 解释分行 / 类型标识 / caret 行列 / 审批滚动 / `windowStart`）、`tests/app.test.ts`（面板渲染、plan-review 分窗可见性、Tab 切窗）、`tests/focus-cursor.test.ts`（面板编辑态 caret 与反例）、`tests/question-wrap.test.ts`（选项折行回归）；冻结基线 `tests/fixtures/focus-frame-legacy.json` 已按新标题/提示重跑。

**审批交互族与提问上下文（3.2.4 / 3.2.5 / 3.2.6 / 3.2.10 / 3.3.1 / 3.3.2 / 3.3.3 / 3.3.4 / 3.3.5 / 3.3.6）**

- `adapter/dsh.ts`：`tool/call` 归一额外登记 `callId → { tool, command, summary }`（LRU 上限 64；裁定 / 超时 / abort 后清理）；超时裁定为 `rejected`（3.3.5）并提供 `stopApprovalTimeout(id)`（用户已操作后停止计时）；`approvalAnswerer` 用 `buildApprovalPrompt(req, detail)` 生成多行草稿；`settle(id, outcome, reason?)` 在宿主侧裁定（超时 / abort）时补发 `approval-closed`；新增 `cancelApproval(id)`（Esc → `cancelled`）。
- `adapter/normalize.ts`：`buildApprovalPrompt` 支持 `ApprovalDetail`（「命令：」全文 + 「参数：」摘要），无明细退化为单行旧文案。
- `state.ts`：审批态新增 `approvalFocus` / `approvalWindow`（焦点窗，3.3.4）/ `approvalDeadline` / `approvalHint` 与 `focusApproval` / `toggleApprovalWindow` / `setApprovalHint`；`question.source` 与纯函数 `recentQuestionSource(buffer)`；`question-move.delta` 放宽为 number（数字键跨多项跳转）。
- `components/ApprovalPrompt.ts`：描述窗 + 选项窗两窗（2/3 规则）、选项固定「批准 / 拒绝」带编号与焦点标记、拒绝项倒计时；`ApprovalView`（focus / deadline / now / window（焦点窗 3.3.4）/ hint（面板内提示 3.3.6））为渲染参数；焦点窗决定左侧列与选项光标着色（3.2.8 口径），`hint` 行先占 1 行再分配两窗（面板总高不变）。
- `layout/hints.ts`：`approvalHintLine(state)` 以 `▶草稿` / `▶选项` 前缀标出焦点窗（3.3.4）；无效键提示不占用按键提示区。
- `layout.ts`：`noticeFooterLines`（3.1.1 的输入区 notice 视图）在 `state.approvalHint` 非空时**优先**用该行显示 `[无效键] …`（黄、左对齐），有效键清空后自动切回 notice 视图（BACKLOG 3.3.8：落点为用户输入区＝屏幕左下、按键提示正上方）。
- 超时语义（3.3.5）：无操作到点 → `rejected`；面板内按过任意键 → `adapter.stopApprovalTimeout(id)` 停止计时、倒计时隐藏；`Esc` 仍为 `cancelled`。
- `components/QuestionPrompt.ts`：选项行格式 `${光标}${标记} ${编号}. ${正文}`（BACKLOG 3.2.12：编号居中靠左、内容起点 = numW + 6，续行与 `description` 对齐内容起点即数字悬挂）；描述窗顶部来源段（灰、`panel.source`）。审批面板选项同格式。`state.ts` 的 `recentQuestionSource` 按**分块口径**取「最近一块含正文」的整块（`thinking` / `notice` 不切割、不设行数上限；本回合取不到则**先回退**取上一回合的最近一块、不加相关性闸门，两回合皆无返回空串；见 `SPEC.md` §15.5）。
- `question-transition.ts`：数字键 → `{ kind: "digit", n }`（自定义项上仍 `custom`）。
- `index.ts`：审批按键白名单（y/1、n/2、Enter、Tab 切焦点窗、←/→、↑/↓ 按焦点窗分派、Esc；其余置 `approval-hint`）；按键分发前统一停止超时计时（3.3.5）；、`approval-closed` 处理（关面板 + notice）、`question-open` 带 `recentQuestionSource`、数字键标记（move + select，不提交）。

### /theme 命令

- 配色方案：启动时解析 `tui.config.json` 的 theme 段（`renderer/theme-config.ts`：内联 `palettes.<id>` → `paletteDir/<file>.json`（上游单一源，默认 `~/fff/config/terminal-colortheme/`）→ 内置兜底快照）。`theme.ts` 的 `THEMES` 仅是兜底快照（= 当前上游配色）；语义色槽位 `gray` / `border` / `code` / `focus` 从各主题 `semantics` 解析（不再按主题名 / ID 分支）。定义 16 个 ANSI 槽位 + 基底前景 / 背景，全部 truecolor。
- 槽位映射：`black..white` → `ansi[]`，`brightBlack..brightWhite` → `bright[]`；`ansiNameToHex(theme, name)` 解析。段级 `style` 由 `segStyle` / `serializeFrameRow`（`screen.ts`）按 Manual-ANSI 处理（fg/bg 分别 `38;2` / `48;2`，bold 用 `1m` / `22m`），着色一律**以主题基底前景 / 背景收尾**（不用 chalk：其 `39m` / `49m` 会复位到终端默认，浅色主题下不可读）。
- 基底色：`Screen` 持有当前主题（`setTheme(id)`），报文在清屏/定位之前写出基底前景 / 背景（truecolor 背景 → `ESC[2J` 首帧清屏即以主题色填充；覆盖式全帧与每个增量区间行同样带基底），保证 `ESC[K` / `ESC[J` 擦除以主题背景填充（擦除一律发生在行首/列 1，见上「先擦后写」口径）。`setTheme` 同时清掉帧缓存（`prevRows = null`），切换后必然全帧重绘。`close()` 前 `Screen.reset()` 输出同步结束 + 光标显示 + `ESC[0m` 恢复终端默认。
