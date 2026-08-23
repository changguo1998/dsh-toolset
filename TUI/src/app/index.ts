// src/app/index.ts — App 组装层：renderer + 状态 + adapter 事件流
//
// 只依赖 renderer 公共 API 与 adapter 接口契约，不感知 adapter 实现。
// 处理按键、接收事件、重绘。

import type { Renderer, KeyEvent } from "../renderer/index.ts";
import type { AppState } from "./state.ts";
import { initialState, reduceState } from "./state.ts";
import type { DshAdapter, DshEvent } from "./adapter/dsh.ts";
import { parseSlashCommand } from "./adapter/dsh.ts";
import { buildFrame } from "./layout.ts";

export interface AppDeps {
  renderer: Renderer;
  adapter: DshAdapter;
}

export class App {
  private state: AppState = initialState();
  private unbindEvents: (() => void)[] = [];
  private log: (msg: string) => void = () => {};
  private disposed = false;

  constructor(private deps: AppDeps) {}

  setLogger(fn: (msg: string) => void): void {
    this.log = fn;
  }

  start(): void {
    this.deps.renderer.onKey((k) => this.handleKey(k));
    this.deps.renderer.onResize(() => this.paint());
    this.unbindEvents.push(
      this.deps.adapter.onEvent((e) => this.handleEvent(e)),
    );
    this.paint();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const f of this.unbindEvents) f();
    this.unbindEvents = [];
    this.deps.adapter.dispose?.();
    this.deps.renderer.close();
  }

  private handleEvent(e: DshEvent): void {
    switch (e.type) {
      case "session-list":
        this.apply((s) =>
          reduceState(s, { type: "sessions", sessions: e.sessions }),
        );
        break;
      case "stream":
        this.apply((s) => reduceState(s, { type: "append", text: e.text }));
        break;
      case "agent-status":
        this.apply((s) =>
          reduceState(s, { type: "agent-status", status: e.status }),
        );
        break;
      case "approval":
        this.apply((s) =>
          reduceState(s, {
            type: "approval",
            approval: { id: e.id, prompt: e.prompt },
          }),
        );
        break;
      case "notice":
        // 命令通知(结果/提示/错误)只进 UI 缓冲，绝不进模型历史
        this.apply((s) => reduceState(s, { type: "notice", text: e.text }));
        break;
      case "turn-end":
        break; // 阶段 1 无动作；阶段 2 可触发额外 UI
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
    this.paint();
  }

  private handleKey(k: KeyEvent): void {
    if (this.disposed) return;
    const { name, ctrl } = k;

    // 审批模式：y/n/q + 滚动
    if (this.state.approval && (name === "y" || name === "n")) {
      const allow = name === "y";
      this.deps.adapter.approve(this.state.approval.id, allow);
      this.apply((s) => reduceState(s, { type: "approval", approval: null }));
      this.paint();
      return;
    }

    switch (name) {
      case "up":
        this.apply((s) => reduceState(s, { type: "scroll", delta: 1 }));
        break;
      case "down":
        this.apply((s) => reduceState(s, { type: "scroll", delta: -1 }));
        break;
      case "pageup":
        this.apply((s) => reduceState(s, { type: "scroll", delta: 10 }));
        break;
      case "pagedown":
        this.apply((s) => reduceState(s, { type: "scroll", delta: -10 }));
        break;
      case "home":
        this.apply((s) => ({ ...s, scrollOffset: 0, followBottom: true }));
        break;
      case "end":
        this.apply((s) => ({
          ...s,
          scrollOffset: Number.MAX_SAFE_INTEGER,
          followBottom: false,
        }));
        break;
      case "left":
        this.apply((s) => reduceState(s, { type: "move-cursor", delta: -1 }));
        break;
      case "right":
        this.apply((s) => reduceState(s, { type: "move-cursor", delta: 1 }));
        break;
      case "backspace":
        this.apply((s) => this.backspace(s));
        break;
      case "enter":
        this.submit();
        break;
      case "escape":
        this.deps.renderer.close();
        break;
      case "paste":
        if (k.text) {
          const t = k.text;
          this.apply((s) =>
            reduceState(s, {
              type: "input",
              text:
                s.inputText.slice(0, s.inputCursor) +
                t +
                s.inputText.slice(s.inputCursor),
              cursor: s.inputCursor + t.length,
            }),
          );
        }
        break;
      default:
        // 可打印字符：插入输入框
        if (name.length === 1 && !ctrl) this.insertChar(name);
        else if (ctrl && name === "c") this.deps.renderer.close();
        break;
    }
    this.paint();
  }

  private submit(): void {
    const text = this.state.inputText.trim();
    if (!text) return;
    // 以 / 开头的输入按 slash 命令处理（不进模型/会话历史）
    if (text.startsWith("/")) {
      this.handleSlash(text);
      this.apply((s) => reduceState(s, { type: "input", text: "", cursor: 0 }));
      return;
    }
    this.deps.adapter.sendMessage(
      text,
      this.state.activeSessionId ?? undefined,
    );
    this.apply((s) => reduceState(s, { type: "input", text: "", cursor: 0 }));
  }

  /**
   * Slash 命令路由：
   *  - 渲染相关命令(/help /clear /quit)→ 本地小命令表
   *  - 其他 /name → adapter.runCommand → commands 注册表调用(官方机制)
   *  - 未命中注册表 → adapter 侧 notice 提示(fail-close，绝不经 sendMessage)
   */
  private handleSlash(line: string): void {
    const name = parseSlashCommand(line);
    if (!name) {
      this.apply((s) =>
        reduceState(s, { type: "notice", text: "无效命令: " + line }),
      );
      return;
    }
    switch (name) {
      case "help":
        this.apply((s) =>
          reduceState(s, {
            type: "notice",
            text: this.helpText(),
          }),
        );
        return;
      case "clear":
        this.apply((s) => reduceState(s, { type: "clear-buffer" }));
        return;
      case "quit":
        this.deps.renderer.close();
        return;
      default:
        // 非本地命令 → 注册表调用
        this.deps.adapter.runCommand(
          line,
          this.state.activeSessionId ?? undefined,
        );
    }
  }

  private helpText(): string {
    return [
      "本地命令：",
      "  /help   显示本帮助",
      "  /clear  清空缓冲",
      "  /quit   退出",
      "其他 /name 通过 commands 注册表执行(未命中则提示未知命令)。",
    ].join("\n");
  }

  private insertChar(c: string): void {
    const cur = this.state.inputCursor;
    const text =
      this.state.inputText.slice(0, cur) + c + this.state.inputText.slice(cur);
    this.apply((s) =>
      reduceState(s, { type: "input", text, cursor: cur + c.length }),
    );
  }

  private backspace(s: AppState): AppState {
    const cur = Math.max(0, s.inputCursor - 1);
    const text = s.inputText.slice(0, cur) + s.inputText.slice(s.inputCursor);
    return reduceState(s, { type: "input", text, cursor: cur });
  }

  private paint(): void {
    if (this.disposed) return;
    const size = this.deps.renderer.getSize();
    const frame = buildFrame(this.state, size);
    this.deps.renderer.render(frame);
  }

  private apply(fn: (s: AppState) => AppState): void {
    this.state = fn(this.state);
  }
}
