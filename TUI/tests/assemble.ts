// TUI/tests/assemble.ts — TUI 集成层装配器（不以 `.test.ts` 结尾, 不被单元层 glob 命中）
//
// 集成层管「装配」: 用三个假面拼起生产链路, 单元层已各自覆盖的纯函数不再重测。
// 三个假面的形状与 `docs/archived/2026-10-28-history-cleanup.md` 4.2 一致:
//  - 假事件面: `helpers/appFakes.ts` 的 FakeAdapter（事件 → 交付镜像可开, 会话 / 模型 / 审批
//    等服务面缺省给空实现）;
//  - 假服务面: 可选的假状态查询（`status` 选项; 调度器换成手动 no-op, 不落真定时器）;
//  - 假终端面: 真实 `createRenderer` 但注入 `write` 捕获报文、`rawMode: false` 不写模式序列、
//    `exitOnClose: false` 不结束进程。唯一被替换的终端能力是 CPR 宽度实测——真应答只有在真
//    pty 里才有, 归 `smoke:pty` 与 `TUI/tests/width-probe.test.ts`; 这里立即返回空表, App 据此走
//    「终端不支持 CPR」分支, 沿用静态宽度表（帧因此可重复）。
//
// 状态层 / 排版层 / 渲染层全部走生产实现: `App` → `buildFrame` → `renderer.render` →
// `Screen` 报文。装配器只为用例提供「读帧 / 注入按键 / 冲刷」三个口子。

import {
  createRenderer,
  type FrameRow,
  type KeyEvent,
  type Renderer,
} from "../src/renderer/index.ts";
import { App, type AppDeps } from "../src/app/index.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";
import type { StatusQueries } from "../src/app/status.ts";
import type { ThemeId } from "../src/renderer/theme.ts";
import { FakeAdapter } from "./helpers/appFakes.ts";

export interface AssembleOptions {
  /** 假状态服务（状态列 / 标题栏投影用）; 不传 = 不启动状态 ticker */
  status?: StatusQueries;
  /** 初始主题; 缺省 dark（与生产缺省一致） */
  theme?: ThemeId;
}

export interface AssembledTui {
  app: App;
  adapter: FakeAdapter;
  renderer: Renderer;
  /** 内容交付入口（生产由真实适配器调用; 用例可直灌以单独验投影） */
  sink: { current?: (delivery: BlockDelivery) => void };
  /** 逐帧记下的纯文本行（最近一帧; 段文本直接拼接, 不含 ANSI） */
  frame(): readonly string[];
  /** 最近一帧的整帧文本（行以 `\n` 连接） */
  text(): string;
  /** 渲染层累计写出的终端报文（真实 `Screen` 产物, 含 ANSI） */
  output(): string;
  /** 渲染层出帧次数（render + refresh, 首帧计入） */
  frames(): number;
  /** `renderer.setTheme` 调用记录（`/theme` 投影断言用） */
  themeCalls: ThemeId[];
  /** 逐字输入（不提交） */
  type(text: string): void;
  /** 逐字输入并回车 */
  typeLine(text: string): void;
  /** 注入单个按键（`name` 同 KeyEvent 口径, 如 `enter` / `escape` / `up`） */
  key(
    name: string,
    mods?: Partial<Pick<KeyEvent, "ctrl" | "meta" | "shift">>,
  ): void;
  /** 冲刷合帧并让异步链路（状态 tick / /model 一类）落定 */
  flush(): Promise<void>;
  /** 收尾（重复调用安全）: adapter.dispose + renderer.close 各一次 */
  dispose(): void;
}

/** 按键事件（缺省非 ctrl / meta / shift） */
export function keyEvent(
  name: string,
  mods: Partial<Pick<KeyEvent, "ctrl" | "meta" | "shift">> = {},
): KeyEvent {
  return {
    name,
    ctrl: mods.ctrl ?? false,
    meta: mods.meta ?? false,
    shift: mods.shift ?? false,
  };
}

/**
 * 装配一条完整的 TUI 链路（状态层 + 排版层 + 真实渲染层 + 假适配器 / 假状态服务）。
 *
 * 返回的帧文本取自渲染层实际收到的 `FrameRow[]`，与 `TUI/demo/main.ts --smoke` 的取证方式同源;
 * 行数 = 终端缺省 80x24 的帧高（无 TTY 时 `createTerminal().getSize()` 回落的尺寸）。
 */
export function assembleTui(opts: AssembleOptions = {}): AssembledTui {
  const writes: string[] = [];
  const renderer = createRenderer({
    write: (s) => writes.push(s),
    rawMode: false,
    exitOnClose: false,
  });
  // 假终端面：CPR 实测要真终端应答（归 smoke:pty / width-probe 单测），这里立即回空表
  renderer.probeSymbolWidths = async () => new Map<string, number>();

  let frameRows: string[] = [];
  let frameCount = 0;
  const capture = (rows: FrameRow[]): void => {
    frameRows = rows.map((r) => r.segments.map((seg) => seg.text).join(""));
    frameCount++;
  };
  const render = renderer.render.bind(renderer);
  const refresh = renderer.refresh.bind(renderer);
  renderer.render = (rows, sections, focus) => {
    capture(rows);
    render(rows, sections, focus);
  };
  renderer.refresh = (rows, sections, focus) => {
    capture(rows);
    refresh(rows, sections, focus);
  };

  const themeCalls: ThemeId[] = [];
  const setTheme = renderer.setTheme.bind(renderer);
  renderer.setTheme = (id) => {
    themeCalls.push(id);
    setTheme(id);
  };

  // 假适配器：事件面 + 内容交付镜像（生产由真实适配器产出交付, 这里由假适配器镜像）
  const adapter = new FakeAdapter();
  const sink: { current?: (delivery: BlockDelivery) => void } = {};
  const deps: AppDeps = {
    renderer,
    adapter,
    notify: { enabled: false },
    pipelineSink: sink,
    ...(opts.theme === undefined ? {} : { initialTheme: opts.theme }),
  };
  if (opts.status) {
    deps.status = {
      queries: opts.status,
      intervalMs: 60_000,
      // 手动驱动: 不落真定时器, tick 次数由用例经 App 状态或帧内容断言
      schedule: () => () => {},
    };
  }
  const app = new App(deps);
  app.start();
  // start() 之后 sink.current 才就绪（生产接线同序）
  adapter.mirrorTo = sink;
  // 生产同款: 适配器在接线后立即推首条会话事件（title / Mode 快照）确立活跃会话;
  // 少了它 `activeSessionId` 停在 null, 会话切换类行为（/new 重建节缓存）走不到生产分支。
  adapter.push({
    type: "session-title",
    sessionId: adapter.sessionId,
    title: "",
  });

  let disposed = false;
  return {
    app,
    adapter,
    renderer,
    sink,
    frame: () => frameRows,
    text: () => frameRows.join("\n"),
    output: () => writes.join(""),
    frames: () => frameCount,
    themeCalls,
    type(text: string): void {
      for (const ch of Array.from(text)) renderer.emitKey(keyEvent(ch));
    },
    typeLine(text: string): void {
      for (const ch of Array.from(text)) renderer.emitKey(keyEvent(ch));
      renderer.emitKey(keyEvent("enter"));
    },
    key(name: string, mods = {}): void {
      renderer.emitKey(keyEvent(name, mods));
    },
    async flush(): Promise<void> {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      app.flushPaint();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      app.dispose();
    },
  };
}
