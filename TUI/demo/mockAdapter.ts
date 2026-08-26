// demo/mockAdapter.ts — Mock DshAdapter
//
// 无 DSH 环境：喂模拟的流式文本（分片、跨行）+ 审批请求，走通 renderer→app 全栈。
// 实现 DshAdapter 契约，阶段 2 以真实实现替换。

import type {
  DshAdapter,
  DshEvent,
  AgentStatus,
  ModelCatalog,
  ModelInfo,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";

export class MockDshAdapter implements DshAdapter {
  private cbs: ((e: DshEvent) => void)[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private seq = 0;
  private sessionId = "mock-1";

  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    if (this.cbs.length === 1) this.schedule();
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }

  sendMessage(text: string): void {
    this.emit({
      type: "stream",
      sessionId: this.sessionId,
      text: `[你] ${text}`,
    });
    this.scheduleReply();
  }

  /**
   * mock 无 commands 注册表：本地渲染命令由 app 层直接处理，此处仅对非本地命令
   * 回 notice 提示(demo 模式下 slash 命令不可用)。
   */
  runCommand(line: string): void {
    this.emit({
      type: "notice",
      text: `[demo] slash 命令 "${line}" 在 demo 模式下不可用（无 commands 注册表）。`,
    });
  }

  approve(id: string, allow: boolean): void {
    this.emit({
      type: "stream",
      sessionId: this.sessionId,
      text: `[审批 ${id} → ${allow ? "批准 ✓" : "拒绝 ✗"}]`,
    });
  }

  interrupt(): void {
    this.emit({
      type: "notice",
      text: "[demo] 打断请求（demo 无真实 agent，已忽略）",
    });
  }

  private modelList: ModelInfo[] = [
    { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
    { provider: "deepseek", id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
  ];
  private currentModel: ModelSelection = {
    provider: "deepseek",
    model: "deepseek-chat",
  };

  async modelCatalog(): Promise<ModelCatalog> {
    return {
      providers: [{ provider: "deepseek", name: "deepseek" }],
      models: this.modelList,
      current: { ...this.currentModel },
    };
  }

  async setDefaultModel(sel: ModelSelection): Promise<ModelSelection> {
    this.currentModel = { ...sel };
    return { ...sel };
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.cbs = [];
  }

  private schedule(): void {
    log("mock adapter 已连接");
    // 初始：会话列表 + 一段说明
    this.timers.push(
      setTimeout(
        () =>
          this.emit({
            type: "session-list",
            sessions: [{ id: this.sessionId, title: "mock session" }],
          }),
        30,
      ),
    );
    this.timers.push(
      setTimeout(
        () =>
          this.emit({
            type: "stream",
            sessionId: this.sessionId,
            text: this.promptText(),
          }),
        60,
      ),
    );
  }

  private scheduleReply(): void {
    const delay = 400 + (this.seq % 4) * 180;
    this.seq++;
    this.timers.push(
      setTimeout(
        () =>
          this.emit({
            type: "agent-status",
            sessionId: this.sessionId,
            status: "thinking" as AgentStatus,
          }),
        delay,
      ),
    );
    const text = this.assistantText();
    // 分片流式输出
    const chunks = splitChunks(text, 6);
    for (let i = 0; i < chunks.length; i++) {
      this.timers.push(
        setTimeout(
          () =>
            this.emit({
              type: "stream",
              sessionId: this.sessionId,
              text: chunks[i]!,
            }),
          delay + 60 + i * 90,
        ),
      );
    }
    this.timers.push(
      setTimeout(
        () =>
          this.emit({
            type: "agent-status",
            sessionId: this.sessionId,
            status: "tool" as AgentStatus,
          }),
        delay + chunks.length * 90 + 40,
      ),
    );
    // 流式结束后补发 turn-end：演示 turn 分隔线与状态区
    this.timers.push(
      setTimeout(
        () => this.emit({ type: "turn-end" }),
        delay + chunks.length * 90 + 60,
      ),
    );
    if (this.seq === 2) {
      // 第二次回复后触发一次审批
      const apId = this.sessionId + "/" + this.seq;
      this.timers.push(
        setTimeout(
          () =>
            this.emit({
              type: "approval",
              id: apId,
              prompt: "允许工具执行 rm -rf /tmp/tui-demo?（y/n）",
            }),
          delay + chunks.length * 90 + 120,
        ),
      );
    }
  }

  private emit(e: DshEvent): void {
    for (const cb of this.cbs) {
      try {
        cb(e);
      } catch (err) {
        log("mock emit error: " + String(err));
      }
    }
  }

  private promptText(): string {
    return [
      "DSH TUI demo（阶段 1 renderer）",
      "",
      "这个 demo 用 mock adapter 喂数据，不接真实 DSH。",
      "你可以：",
      "  - 输入消息后回车 → 触发模拟流式回复",
      "  - ↑/↓/PageUp/PageDown 在 scrollback 里翻页（上滚暂停跟随）",
      "  - 等第二次回复后出现审批弹窗 → y 批准 / n 拒绝",
      "  - 输入 /help /clearscreen /cls /quit 体验本地渲染命令",
      "  - 其他 /xxx 在 demo 模式回提示（真实模式走 commands 注册表）",
      "  - Ctrl+C 或 Esc 退出",
      "",
    ].join("\n");
  }

  private assistantText(): string {
    const lines = [
      "收到！我（mock assistant）会分片输出这段话，模拟真实流式。",
      "这是一条很长很长的行，用来验证 wrapping：" +
        "长长的段落反复出现，".repeat(12),
      "第二行结束。你可以 ↑ 翻回去看刚才的内容（上滚会暂停跟随底部）。",
      "审批弹窗将在第二次回复后出现。",
    ];
    return lines[this.seq % lines.length] ?? "";
  }
}

function splitChunks(text: string, n: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / n));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

export function createMockDshAdapter(): DshAdapter {
  return new MockDshAdapter();
}

/** log stub — 阶段 1 demo；无需引入日志库 */
function log(msg: string): void {
  process.stderr.write("[mock] " + msg + "\n");
}
