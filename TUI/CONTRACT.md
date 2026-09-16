# TUI 排版↔渲染契约

> 状态：**设计草案，待实施**（2026-09）。实施完成后再将 `DESIGN.md`「现状偏差」更新为「已收敛」。
> 配套：`DESIGN.md`「术语：渲染 vs 排版」、`REFACTOR.md`「当前文件归属」、`LAYOUT-BOX.md`（Box 树内部中间表示，本契约的两个跨度类型 `FrameStyle`/`FrameContext` 供其引用）。术语与本文件一致：**渲染** = renderer 字节上屏；**排版** = 状态 → 带语义样式的行。

## 1. 动机与目标

消除样式链路漂移：排版层不再手拼 ANSI（现 `layout.ts` 54 处 + `markdown.ts` 14 处 + `components/*` 8 处直写 `\x1b[…` / `colorFor(...)` 直包 / `hexSgr(...)`），序列化职责收口渲染层，回归「app 发内容、渲染层决定如何渲染」的设计原意。**纯重构，行为不变**，现有测试为回归护栏。

## 2. 层间数据契约

### 2.1 排版输出（核心新增，取代 `RenderLine`）

```ts
// 语义色名：排版层唯一颜色词汇；渲染层按当前主题解析为实际 hex + SGR。
// "code" 为新增语义（行内代码/代码块背景：dark 深灰 / light 浅灰），
// 取代排版层现 CODE_BG 手拼 hex（#434343 / #E8E8E8）。
export type ColorName =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "gray"
  | "border"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow"
  | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite"
  | "code"
  | (string & {}); // 逃生通道：任意名渲染层回退基底色（fail-safe），不用即弃

// 行内一段：纯文本 + 语义样式（原型 = markdown.ts InlineSegment，字段已对齐）
// 段级样式描述：语义色名（渲染层按当前主题解析为 hex + SGR）；
// 排版层唯一样式类型——FrameSegment / Box.NodeBase.style / prefix.style 共用
// （样式漂移消除后，现 RenderLine.style 由本类型替代；renderer 无独立行级样式）
export interface FrameStyle {
  /** 原则上取 ColorName；"#hex" 逃生保留但新代码禁用（存量待清理） */
  fg?: ColorName | `#${string}`;
  bg?: ColorName | `#${string}`;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

// 行内一段：纯文本 + 段级样式（原型 = markdown.ts InlineSegment，字段已对齐）
export interface FrameSegment {
  /** 纯文本，绝不含 ANSI/控制序列（不变量 #1） */
  text: string;
  style?: FrameStyle;
}

// 一行：排版输出最小单位
export interface FrameRow {
  /** 有序；相邻同 style 由渲染层序列化时自动合并 */
  segments: FrameSegment[];
  /** 输入行硬件光标停留列（0 基显示列）；仅输入行设置，宽度由排版层算好（不变量 #3） */
  caret?: number;
}
```

### 2.2 渲染层公共 API（改签名一处）

```ts
interface Renderer {
  render(rows: FrameRow[]): void;   // 整帧重绘（delta 为内部优化，对外不可见）
  refresh(rows: FrameRow[]): void;  // 强制全帧（Ctrl+L）
  onKey(cb: (k: KeyEvent) => void): void;
  emitKey(k: KeyEvent): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  getSize(): Size;
  setTheme(id: ThemeId): void;
  close(): void;
}
```

### 2.3 排版输入（已有契约，立字据）

- 输入 = `AppState`（只读）；`buildFrame(state, size): FrameRow[]` 保持**纯函数**：不改 state、无副作用、无 adapter/paint 调用（REFACTOR.md 原则）。

- **排版上下文（fill 阶段只读输入；不跨层，供 `LAYOUT-BOX.md` §9 管线引用）**：

```ts
// buildFrame 内部：state --buildBox--> Box 树 --measure/allocate--> rects --fill(ctx, rect)--> FrameRow[]
// ctx 承载构建/填板的只读事实；各区域 fill 不再背一长串位置参数（现 buildTopRegion 的痛）
interface FrameContext {
  state: AppState;                          // 只读，无副作用（REFACTOR 原则）
  size: Size;                               // 终端尺寸（cols×rows）
  themeId: ThemeId;                         // 主题选择（取色由渲染层）
  metrics: FrameMetrics;                    // 分区尺寸预算（statusColWidth/historyWidth/topHeight/footerHeight…）
  focusedPanel: "history" | "activity" | "status" | null;  // 焦点分区（FocusFrame 覆写用）
}
```

## 3. 主题契约

颜色语义是**两段映射**，各归一层：

```
state 事实("status=failure")             -- 逻辑层，不碰颜色
   ↓
语义 → 色名("failure 用 red")            -- 排版层 ★
   ↓
色名 → 色值 → SGR("red" → hex → \x1b[…   -- 渲染层
```

- **语义 → 色名（排版层）**：映射表为**排版层常量**——不入 `AppState`、不进 renderer。现有实例：`STATUS_PROMPT_COLOR[inputStatus]`（success 绿 / running 黄 / failure 红）、`permColor`（sandbox 危险等级 ro 绿 / wr 黄 / full 红）、notice tone（log 灰 / info 蓝 / warn 黄 / error 红 / success 绿）。markdown 语义同为此类（`**`→bold、`` ` ``→bg:code）：解析器在排版层，调"强调样式"只改排版层映射，state / renderer 均不动。
- **色名 → 色值（渲染层独占）**：`ColorName → hex → SGR`（`colorFor` / `ansiNameToHex` / `hexSgr` 不得再被排版层 import，`theme.ts` 收口）。
- **排版层仅持有**：`ThemeId` + 语义 `ColorName`；state 保持与呈现无关（不存颜色）。
- 未知色名回退基底色（fail-safe，不抛异常，与现状 `ansiNameToHex` 返回 null 语义一致）。

## 4. 不变量（排版层义务，渲染层据此当纯字节通道）

| # | 不变量 | 承担方 |
|---|---|---|
| 1 | `text` 无 ANSI/控制序列 | 排版层 |
| 2 | 每行 segments 显示宽度合计 = 行宽 | 排版层 |
| 3 | `caret` 仅输入行，列号按显示宽度算好 | 排版层 |
| 4 | 跨行段行内自洽：软换行时每行重新声明样式 | 排版层 |
| 5 | 渲染层不量宽、不布局、不理解内容 | 渲染层（身份） |

## 5. 迁移清单（纯重构）

**A. 渲染层**

- `screen.ts`：`render/renderDelta` 接受 `FrameRow[]`，新增段级序列化 `segStyle(seg, theme)`（名→hex→SGR、相邻同 style 合并、未知名回退基底）；delta 比较改按序列化文本（内部实现，不对外）。
- `theme.ts`：`ColorName` 增加 `"code"` 槽位（dark 现值 `#434343` / light `#E8E8E8`，从 `markdown.ts CODE_BG` 迁入）；序列化函数内部化。
- `index.ts`：`Renderer.render/refresh` 签名 `RenderLine[] → FrameRow[]`；删除 `RenderLine` 类型（由 `FrameRow` 替代）。

**B. 排版层**

- `layout/markdown.ts`：`InlineSegment`/`InlineStyle` 收敛为 `FrameSegment`/`FrameStyle`（字段已对齐）；删除 `renderSeg`（序列化移交渲染层）；删除 `CODE_BG`（改 `style.bg: "code"`）；`wrapSegments`/`wrapInlineMarkdown` 改产出 `FrameSegment[]`（跨行段每行重声明 — 不变量 #4）。
- `layout.ts`：54 处 ANSI 直写 / `colorFor(...)` 直包改 `style` 字段（如 `makeSep` → `{ fg: "border" }`）；`renderStatusLine` 等纯函数改返回 `FrameRow[]`。
- `components/*`：8 处同理；`TextInput` 保持 `caret` 语义。
- `app/index.ts`（控制层）：仅随 `buildFrame` 返回类型顺延，不涉行为。

**C. 测试**

- 新增：渲染层序列化单测（名→SGR / 相邻合并 / 未知名回退 / 主题切换 / caret 定位）。
- 新增：排版层产出断言（纯文本无 ANSI、宽度合计 = 行宽）。
- 现有 560 测试：断言从"带 ANSI 的 text"改为"segments 结构"；导入面小改（不涉及行为）。
- `demo` 帧断言与 `smoke:pty` 不变（行为不变即回归标准）。

## 6. 验收

```sh
npm run check          # 类型通过
npm run test           # 全量测试通过（含新增序列化/排版产出断言）
npm run build
npm run demo -- --smoke   # 帧断言 SMOKE_PASS 不变
npm run smoke:pty      # 真机冒烟（工具行/状态栏 usage）
```

## 7. 不在范围（明确不做）

- 不拆 `layout.ts` / `buildTopRegion`（按 REFACTOR.md 触发标准另行）。
- 不引入嵌套树 / 样式规则引擎 / 布局引擎（与 HTML 对照：保留"排版后扁平快照"模型）。
- 渲染层继续不量宽、不感知内容。
- 不启用 bracketed paste / 鼠标 / 滚动区域（单独条目，另行评估）。

## 8. 实施完成后的文档同步

- `DESIGN.md`：术语节「现状偏差」→「样式链路已收敛」；「核心接口契约」段更新为 `FrameRow`。
- `IMPLEMENTATION.md`：新增/更新「段序列化」要点。
- `REFACTOR.md`：「域」标注不变；迁移产生的新纯文件（如 `segStyle` 归属）按原则登记。
