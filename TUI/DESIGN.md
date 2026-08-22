# DSH TUI 插件设计与文件结构

## 项目目标

为 DeepSeek Harness（DSH）开发一个轻量级、高性能的终端用户界面插件，作为进程内集成的交互前端，通过复用 DSH 核心服务（会话管理、Agent 驱动、工具调用等），提供 Web UI 和 CLI 之外的另一种交互方式。

## 技术选型

- 语言：TypeScript（与 DSH 核心一致）
- 运行时：Node.js
- 包管理：pnpm
- 依赖：chalk（ANSI 颜色控制）
- 可选依赖：node-pty（已评估，暂不引入；除非 TUI 需直接开 shell，否则会话由 DSH 管理）

关键决策：不采用 Ink / Solid-TUI 等成熟框架，自研极简渲染层。
理由：针对 DSH 特定交互模式（流式输出、工具审批）优化；框架代码量小，
维护成本可控；对渲染和输入事件拥有完全控制力。

### 评审记录（2026-08 | 自研渲染层）

- 流式输出本质是"增量文本追加 + 偶尔整帧重绘"，human-speed 交互下整帧重绘足够。
- 砍掉：帧 diff、组件树、布局引擎。渲染核心约 150 行。
- 输入解码是隐藏大头：需手写 ANSI 转义序列解析（方向键、Home/End、Ctrl 组合、bracketed paste）。node 无 stdlib 键盘解析，这是自研 vs 用 Ink 的真正代价。
- node-pty 是原生二进制，暂不引入。
- 风险最高的部分是 DSH 适配层（"通过 ctx 订阅会话事件、驱动 Agent"），应在 renderer 定稿前先做 spike 确认接口。当前仓库无 DSH 源码可查，接口待确认。

## 文件结构（单包分目录）

```
TUI/
  package.json          # type: module, bin: dsh-tui.js
  tsconfig.json
  src/
    main.ts             # 组装: renderer + app + DSH adapter
  demo/                 # 无 DSH 依赖的 demo：mock adapter 喂模拟流式文本 + 审批，
                        #   完整走通 renderer→app 栈，不接 DSH
  tests/                # 极少的可运行自检；优先覆盖 input.ts（ANSI 解码易错）
  bin/dsh-tui.js        # shebang + import('../dist/main.js')
```

框架层 `src/renderer/` —— 不感知 DSH、不 import app：

```
src/renderer/
  terminal.ts    # raw mode 开/关、resize 监听、退出清理
  input.ts       # stdin 键解码：ANSI 转义序列 → 结构化 key 事件
  screen.ts      # 帧缓冲 + 整帧重绘
  index.ts       # 公共 API
```

应用层 `src/app/` —— 只依赖 renderer 公共 API：

```
src/app/
  state.ts       # 状态模型：会话列表、流式文本增量、审批项
  layout.ts      # header / 流式区 / 输入行 / 审批弹窗
  components/    # TextInput、ScrollView（流式区）、ApprovalPrompt
  adapter/dsh.ts # ctx 订阅 → 写入 state；审批/发消息 → 回调 DSH
  index.ts
```

依赖方向（单向）：

```
main.ts → app → renderer
adapter → app（喂状态）
```

## 核心接口契约（renderer 公共 API）

```ts
// 应用调用渲染：每一行携带样式（帧缓冲输入）
interface RenderLine {
  text: string;
  style?: { fg?: string; bg?: string; bold?: boolean };
}

// 应用收到的按键事件：input.ts 解码后的结构化结果
interface KeyEvent {
  name: string; // 'a' | 'up' | 'down' | 'enter' | 'tab' | 'escape' | …
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

// renderer 对 app 暴露的公共 API
interface Renderer {
  render(lines: RenderLine[]): void; // 整帧重绘
  onKey(cb: (k: KeyEvent) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  getSize(): { cols: number; rows: number };
  close(): void; // 恢复终端，退出事件循环
}
```

## 流式滚屏（scrollback）行为

状态模型持有无界 text buffer；`layout.ts` 负责切分 viewport：

- 长行按终端列宽软换行（wrapping），视口 = 行数裁剪后的可见窗口
- scrollback 上限：buffer 超过 2000 行裁剪旧行（`ponytail:` 固定上限，需要时再做持久滚动/搜索）
- 新文本到达时跟随底部；用户上滚时暂停跟随，按 up/down/PageUp/PageDown 移动视口

## 信号与退出契约

- `terminal.ts`（renderer 内）负责 raw mode 开/关与终端恢复，对所有退出路径生效：正常 `close()`、SIGINT/SIGTERM、`uncaughtException`/`unhandledRejection`
- 退出生命周期归 renderer 拥有；app 只在 renderer 分发的事件里做自己的清理

## 构建与运行

- 构建：`tsc`（无 bundler，Node CLI 无需打包），`outDir: dist/`，ESM
- bin：`bin/dsh-tui.js` = shebang + `import('../dist/main.js')`，`package.json.bin` 指向它
- demo：`pnpm demo` → tsc 后 `node dist/demo/main.js`

## 开发阶段（含 spike）

0. **DSH adapter spike**（丢弃式脚本，非最终 adapter）：订阅一个会话 → 收到流式文本 → 发送一次审批。产出：state 模型形状 + renderer 实现顺序的依据。当前仓库无 DSH 源码，ctx API 未确认，adapter 必须架在接口后以便 mock/真实替换。
1. 实现 renderer 最小可用（raw mode + 输入解码 + 整帧重绘），`demo/` 跑通
1. 接入 DSH 核心（adapter/dsh.ts，含审批与流式输出）
1. 完善交互功能并打包为 DSH Profile Bundle（bin/dsh-tui.js）

由 advisor 审阅（2026-08-22），本版修正：

- 补 phase 0 spike：adapter 接口先行
- 定义 renderer↔app 接口契约（RenderLine / KeyEvent / Renderer）
- 明确 scrollback 行为（wrapping、2000 行上限、跟随底部、视口移动）
- 入口统一为 `src/main.ts`
- 构建工具选定 tsc，产物 dist/，bin 指向 dist/main.js
- demo 与 tests 定位：demo 用 mock adapter 走通全栈；tests 优先覆盖 input.ts
- 信号/退出契约归 renderer
- components 清单落实为 TextInput / ScrollView / ApprovalPrompt
- adapter 接口化，ctx API 未确认前可 mock 替换
