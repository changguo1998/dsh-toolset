// src/app/index.ts — App 组装层：renderer + 状态 + adapter 事件流
//
// 只依赖 renderer 公共 API 与 adapter 接口契约，不感知 adapter 实现。
// 处理按键、接收事件、重绘。

import type { Renderer, KeyEvent } from "../renderer/index.ts";
import type { AppState, PickerOption } from "./state.ts";
import { initialState, reduceState } from "./state.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelCatalog,
  ModelSelection,
} from "./adapter/dsh.ts";
import { parseSlashCommand } from "./adapter/dsh.ts";
import { buildFrame } from "./layout.ts";
import { StatusTicker, type StatusQueries } from "./status.ts";

export interface AppDeps {
  renderer: Renderer;
  adapter: DshAdapter;
  /** 可选：系统状态区数据源；提供后 App 自动启动合并节流 ticker */
  status?: {
    queries: StatusQueries;
    intervalMs?: number;
  };
}

export class App {
  private state: AppState = initialState();
  private unbindEvents: (() => void)[] = [];
  private disposed = false;
  private statusTicker: StatusTicker | null = null;

  constructor(private deps: AppDeps) {}

  /** 预留日志注入点（当前无内部消费方，保持 API 兼容为 no-op） */
  setLogger(_fn: (msg: string) => void): void {}

  start(): void {
    this.deps.renderer.onKey((k) => this.handleKey(k));
    this.deps.renderer.onResize(() => this.paint());
    this.unbindEvents.push(
      this.deps.adapter.onEvent((e) => this.handleEvent(e)),
    );
    // 系统状态区：合并节流 ticker（tick 一次批量查 cwd/git/time）
    if (this.deps.status) {
      this.statusTicker = new StatusTicker({
        queries: this.deps.status.queries,
        intervalMs: this.deps.status.intervalMs ?? 5000,
        apply: (status) => {
          this.apply((s) => reduceState(s, { type: "status", status }));
          this.paint();
        },
      });
      this.statusTicker.start();
      this.unbindEvents.push(() => this.statusTicker?.stop());
    }
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
        // turn 结束：追加分隔线，让对话历史每个 turn 之间可见分隔
        this.apply((s) => reduceState(s, { type: "turn-end" }));
        break;
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

    // 审批模式：y/n + 滚动
    if (this.state.approval && (name === "y" || name === "n")) {
      const allow = name === "y";
      this.deps.adapter.approve(this.state.approval.id, allow);
      this.apply((s) => reduceState(s, { type: "approval", approval: null }));
      this.paint();
      return;
    }

    // 模型选择模式（/model 无参）：↑/↓ 移动，Enter 确认，Esc 取消；其余按键忽略
    if (this.state.picker) {
      if (name === "up") {
        this.apply((s) => reduceState(s, { type: "picker-move", delta: -1 }));
        this.paint();
      } else if (name === "down") {
        this.apply((s) => reduceState(s, { type: "picker-move", delta: 1 }));
        this.paint();
      } else if (name === "enter") {
        void this.confirmModelPicker();
      } else if (name === "escape") {
        this.apply((s) => reduceState(s, { type: "picker-close" }));
        this.paint();
      }
      return;
    }

    // Ctrl+D：仅 idle 且输入区为空时退出（输入非空时按无操作忽略）
    if (ctrl && name === "d") {
      if (this.state.agentStatus === "idle" && this.state.inputText === "") {
        this.deps.renderer.close();
      }
      return;
    }

    // Ctrl+L：强制整帧重绘（绕过 delta 优化）。放在 switch 前，避免吞掉普通 'l' 输入。
    if (ctrl && name === "l") {
      this.refresh();
      return;
    }

    switch (name) {
      case "escape":
        // Esc 打断思考：真实链路映射 agent.cancel({kind:'user'})，demo 为 notice
        this.deps.adapter.interrupt();
        break;
      case "tab":
        // ponytail: 单会话占位，多会话基建落地后再实现真正的标签页切换
        this.apply((s) =>
          reduceState(s, {
            type: "notice",
            text: "标签页切换待实现（当前为单会话）",
          }),
        );
        break;
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
        // 可打印字符：插入输入框（Esc/Ctrl+C 不再触发退出；退出请用 /quit 或系统信号）
        if (name.length === 1 && !ctrl) this.insertChar(name);
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
   *  - 渲染相关命令(/help /clearscreen /cls /quit)→ 本地小命令表
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
      case "clearscreen":
      case "cls":
        this.apply((s) => reduceState(s, { type: "clear-buffer" }));
        return;
      case "quit":
        this.deps.renderer.close();
        return;
      case "model":
        void this.handleModelCommand(line);
        return;
      default:
        // 非本地命令 → 注册表调用
        this.deps.adapter.runCommand(
          line,
          this.state.activeSessionId ?? undefined,
        );
    }
  }

  /** /model 命令：无参进入交互选择；带参切换默认模型（保留当前 reasoningEffort） */
  private async handleModelCommand(line: string): Promise<void> {
    const spec = line.slice("/model".length).trim();
    try {
      if (!spec) {
        const catalog = await this.deps.adapter.modelCatalog();
        this.openModelPicker(catalog);
        return;
      }
      const catalog = await this.deps.adapter.modelCatalog();
      const resolved = resolveModelSpec(catalog, spec);
      if ("error" in resolved) {
        this.notice(resolved.error);
        return;
      }
      await this.applyModelSelection(resolved.selection);
    } catch (err) {
      this.notice("model command failed: " + String(err));
    }
  }

  /** 无参 /model：进入交互选择模式（当前模型行始终显示，不在候选目录中也补行） */
  private openModelPicker(catalog: ModelCatalog): void {
    const current = catalog.current;
    const options: PickerOption[] = [];
    // 当前默认模型恒为首行并标 current（listModels 为 advisory 目录，可能不在其中）
    if (current?.provider && current?.model) {
      options.push({
        label: `${current.provider}/${current.model}`,
        selection: {
          provider: current.provider,
          model: current.model,
          reasoningEffort: current.reasoningEffort,
        },
        current: true,
      });
    }
    for (const m of catalog.models) {
      const isCurrent =
        current?.provider === m.provider && current?.model === m.id;
      if (isCurrent) continue;
      options.push({
        label: `${m.provider}/${m.id}`,
        selection: { provider: m.provider, model: m.id },
        current: false,
      });
    }
    if (options.length === 0) {
      this.notice(
        "no available models (llm service missing or no adapter registered)",
      );
      return;
    }
    this.apply((s) =>
      reduceState(s, {
        type: "picker-open",
        picker: { options, index: 0 },
      }),
    );
    this.paint();
  }

  /** 选择面板确认：应用选中模型后退出面板（失败也退出并提示） */
  private async confirmModelPicker(): Promise<void> {
    const picker = this.state.picker;
    if (!picker) return;
    const opt = picker.options[picker.index];
    this.apply((s) => reduceState(s, { type: "picker-close" }));
    if (!opt) return;
    try {
      await this.applyModelSelection(opt.selection);
    } catch (err) {
      this.notice("model command failed: " + String(err));
    }
  }

  /** 持久切换默认模型（保留当前 reasoningEffort）；/model 带参与交互选择共用 */
  private async applyModelSelection(selection: ModelSelection): Promise<void> {
    const catalog = await this.deps.adapter.modelCatalog();
    const cur = catalog.current;
    if (
      cur &&
      cur.provider === selection.provider &&
      cur.model === selection.model
    ) {
      this.notice(
        `already on default model ${selection.provider}/${selection.model}`,
      );
      return;
    }
    const reasoningEffort = cur?.reasoningEffort;
    const sel: ModelSelection = reasoningEffort
      ? { ...selection, reasoningEffort }
      : selection;
    const saved = await this.deps.adapter.setDefaultModel(sel);
    this.apply((s) =>
      reduceState(s, {
        type: "status",
        status: { model: `${saved.provider}/${saved.model}` },
      }),
    );
    this.notice(`default model -> ${saved.provider}/${saved.model}`);
  }

  /** 追加一条命令通知并重绘（/model 结果/错误统一入口） */
  private notice(text: string): void {
    if (this.disposed) return;
    this.apply((s) => reduceState(s, { type: "notice", text }));
    this.paint();
  }

  private helpText(): string {
    return [
      "本地命令：",
      "  /help   显示本帮助",
      "  /clearscreen (/cls)  清空缓冲(只清显示，不动上下文)",
      "  /quit   退出",
      "  /model [provider/]model  switch default model; bare /model: interactive picker",
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

  /** 强制整帧重绘（Ctrl+L）：绕过 delta，走 renderer.refresh */
  private refresh(): void {
    if (this.disposed) return;
    const size = this.deps.renderer.getSize();
    const frame = buildFrame(this.state, size);
    this.deps.renderer.refresh(frame);
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


// ---------------------------------------------------------------------------
// /model 辅助（纯函数，便于单测）
// ---------------------------------------------------------------------------

/** 格式化模型目录为多行文本（/model 无参输出）：纯 ASCII，当前模型前 ->、其余空格缩进 */
export function formatModelCatalog(catalog: ModelCatalog): string {
  const current = catalog.current;
  const lines: string[] = [];
  // listModels 为 advisory 目录，当前默认模型可能不在其中——始终渲染为首行并带 -> 标记
  if (current?.provider && current?.model) {
    lines.push(`  -> ${current.provider}/${current.model}`);
  }
  for (const m of catalog.models) {
    const key = `${m.provider}/${m.id}`;
    const isCurrent =
      current?.provider === m.provider && current?.model === m.id;
    if (isCurrent) continue;
    lines.push(`     ${key}`);
  }
  if (lines.length === 0) {
    return "no available models (llm service missing or no adapter registered)";
  }
  return lines.join("\n");
}

/** 解析 /model <spec>：显式 provider/model 直通；裸 model id 需跨 provider 唯一匹配 */
export function resolveModelSpec(
  catalog: ModelCatalog,
  spec: string,
): { error: string } | { selection: ModelSelection; same: boolean } {
  const current = catalog.current;
  const same = (p: string, m: string): boolean =>
    current?.provider === p && current?.model === m;
  const slash = spec.indexOf("/");
  if (slash >= 0) {
    const provider = spec.slice(0, slash);
    const model = spec.slice(slash + 1);
    if (!provider || !model)
      return {
        error: "usage: /model <provider>/<model> or /model <modelId>",
      };
    return { selection: { provider, model }, same: same(provider, model) };
  }
  const matches = catalog.models.filter((m) => m.id === spec);
  if (matches.length === 0)
    return {
      error: `model "${spec}" not found in available models. Use /model to list.`,
    };
  if (matches.length > 1) {
    const ps = matches.map((m) => m.provider).join(", ");
    return {
      error: `model "${spec}" exists in multiple providers (${ps}). Use /model <provider>/<model>.`,
    };
  }
  const m = matches[0]!;
  return {
    selection: { provider: m.provider, model: m.id },
    same: same(m.provider, m.id),
  };
}
