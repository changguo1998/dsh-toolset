// TUI/src/app/index.ts — App 壳: 上下文对象 + 公开方法委托
//
// 2026-11-04 按职责拆分（行为不变）, 类体搬进 ./runtime/:
//   - context.ts 上下文对象: 59 个字段 + deps + 构造器归一化 + self 分派面
//   - frame.ts 帧与交付: 流水线缓存、排版出帧、滚动、合帧、提示写出
//   - interaction.ts 按键与交互: 按键表、审批 / 问答、退出确认、编辑与补全
//   - session.ts 会话控制: 提交 / shell / 会话历史与恢复 / 会话状态快照
//   - panels.ts 面板与模型选择: 列表面板、状态面板、/jobs、模型选择
//   - commands.ts 与 commands-{model,config,memory,host}.ts: slash 分派与按域命令
//   - wiring.ts 事件桥与服务懒读
//   - lifecycle.ts 启动 / 退出 / 清理 / 宽度探测 / 响铃
// 本文件只剩: App 壳（private ctx + 8 个公开方法委托）、装配, 以及原有公共导出的兼容重导;
// 对外可见集合与帧内容不变.
//
// 只依赖 renderer 公共 API 与 adapter 接口契约, 不感知 adapter 实现.
// 处理按键、接收事件、重绘.

import type { AppDeps } from "./app-deps.ts";
import type { AppState } from "./state.ts";
import type { SectionsState } from "./layout/pipeline/sections.ts";
import type { NoticeTone } from "./adapter/types.ts";
import type { ThemeId } from "../renderer/theme.ts";
import {
  createAppContext,
  type AppContext,
  type AppSelf,
} from "./runtime/context.ts";
import { createFramePart } from "./runtime/frame.ts";
import { createInteractionPart } from "./runtime/interaction.ts";
import { createSessionPart } from "./runtime/session.ts";
import { createPanelsPart } from "./runtime/panels.ts";
import { createCommandsPart } from "./runtime/commands.ts";
import { createCommandsModelPart } from "./runtime/commands-model.ts";
import { createCommandsConfigPart } from "./runtime/commands-config.ts";
import { createCommandsMemoryPart } from "./runtime/commands-memory.ts";
import { createCommandsHostPart } from "./runtime/commands-host.ts";
import { createWiringPart } from "./runtime/wiring.ts";
import { createLifecyclePart } from "./runtime/lifecycle.ts";

export { formatModelCatalog, resolveModelSpec } from "./commands.ts";
export {
  DSH_RESTART_EXIT_CODE,
  EXIT_CONFIRM_CLEAN_LABEL,
  EXIT_CONFIRM_RESTART_LABEL,
  canExitOnCtrlD,
} from "./exit-guards.ts";
export { focusedLineScroll, focusedPageScroll } from "./scroll-helpers.ts";
export type { PaneScrollMax } from "./scroll-helpers.ts";
export type { AppDeps } from "./app-deps.ts";
export {
  SMALL_TERMINAL_COLS,
  SMALL_TERMINAL_ROWS,
  SMALL_TERMINAL_NOTICE,
  smallTerminal,
} from "./runtime/lifecycle.ts";

export class App {
  private readonly ctx: AppContext;

  constructor(deps: AppDeps) {
    this.ctx = createAppContext(deps);
    this.ctx.self = assembleApp([
      createFramePart(this.ctx),
      createInteractionPart(this.ctx),
      createSessionPart(this.ctx),
      createPanelsPart(this.ctx),
      createCommandsPart(this.ctx),
      createCommandsModelPart(this.ctx),
      createCommandsConfigPart(this.ctx),
      createCommandsMemoryPart(this.ctx),
      createCommandsHostPart(this.ctx),
      createWiringPart(this.ctx),
      createLifecyclePart(this.ctx),
    ]);
  }

  start(): void {
    this.ctx.self.start();
  }

  dispose(options?: { exit?: boolean }): void {
    this.ctx.self.dispose(options);
  }

  paintNow(): void {
    this.ctx.self.paintNow();
  }

  flushPaint(): void {
    this.ctx.self.flushPaint();
  }

  applyStartupModel(args: {
    provider?: string;
    model?: string;
    effort?: string;
  }): Promise<void> {
    return this.ctx.self.applyStartupModel(args);
  }

  appendExternalLog(line: string, tone?: NoticeTone): void {
    this.ctx.self.appendExternalLog(line, tone);
  }

  applyTheme(id: ThemeId): void {
    this.ctx.self.applyTheme(id);
  }

  /** 预留日志注入点（当前无内部消费方，保持 API 兼容为 no-op） */
  setLogger(_fn: (msg: string) => void): void {}

  // 兼容层: 既有测试经 `as unknown as { state }` 读私有状态; 状态搬进 ctx 后用私有 getter
  // 保持读路径可用（TS 私有, 不进公开类型面; 运行时落在原型上）.
  private get state(): AppState {
    return this.ctx.state;
  }

  private set state(state: AppState) {
    this.ctx.state = state;
  }

  private get sections(): SectionsState | null {
    return this.ctx.sections;
  }

  private get groupCount(): number | null {
    return this.ctx.groupCount;
  }

  // 兼容层: 少数既有用例经 cast 直接调用内部方法; 转调到扁平成员面, 行为与原来一致.
  private apply(fn: (s: AppState) => AppState): void {
    this.ctx.self.apply(fn);
  }

  private resumeToSession(id: string): Promise<void> {
    return this.ctx.self.resumeToSession(id);
  }

  private startNewSession(): void {
    this.ctx.self.startNewSession();
  }
}

/** 合并各职责模块的成员面（defineProperties 保留描述符; 与 adapter 的 assembleAdapter 同款） */
function assembleApp(parts: object[]): AppSelf {
  const out = {} as AppSelf;
  for (const part of parts) {
    Object.defineProperties(out, Object.getOwnPropertyDescriptors(part));
  }
  return out;
}
