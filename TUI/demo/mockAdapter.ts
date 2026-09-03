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
  QuestionAnswer,
} from "../src/app/adapter/dsh.ts";

export class MockDshAdapter implements DshAdapter {
  private cbs: ((e: DshEvent) => void)[] = [];
  /** 冒烟断言用：问答提交/取消记录 */
  answeredQuestions: { id: string; answer: QuestionAnswer }[] = [];
  cancelledQuestions: string[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private seq = 0;
  /** 第二次回复后是否自动触发审批（冒烟用 false，由脚本显式驱动审批弹窗） */
  private autoApproval: boolean;
  private sessionId = "mock-1";

  constructor(autoApproval: boolean = true) {
    this.autoApproval = autoApproval;
  }
  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    if (this.cbs.length === 1) this.schedule();
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }

  sendMessage(text: string): void {
    // App 在发送前本地回显用户行；mock 只负责模拟模型响应（冒烟断言记 sent）。
    this.sent.push(text);
    this.scheduleReply();
  }

  /** 冒烟自断言计数：收到 sendMessage 的文本（不含 mock 自动回复） */
  sent: string[] = [];
  /** 冒烟自断言计数：interrupt 调用次数 */
  interrupts = 0;
  /** 冒烟驱动：向 app 推送任意事件 */
  emitEvent(e: DshEvent): void {
    this.emit(e);
  }

  /**
   * mock 无 commands 注册表：本地渲染命令由 app 层直接处理，此处仅对非本地命令
   * 回 notice 提示(demo 模式下 slash 命令不可用)。
   */
  runCommand(line: string): void {
    this.emit({
      type: "notice",
      text: `[demo] slash 命令 "${line}" 在 demo 模式下不可用（无 commands 注册表）。`,
      error: true,
    });
  }

  approve(id: string, allow: boolean): void {
    this.emit({
      type: "stream",
      sessionId: this.sessionId,
      text: `[审批 ${id} → ${allow ? "批准 ✓" : "拒绝 ✗"}]`,
    });
  }

  answerQuestion(id: string, answer: QuestionAnswer): void {
    this.answeredQuestions.push({ id, answer });
    this.emit({
      type: "stream",
      sessionId: this.sessionId,
      // demo 无真实 ask()，收到回答说明有人在测接口——直接回报即可
      text: `[问答已提交：${JSON.stringify(answer)}]`,
    });
  }

  cancelQuestion(id: string): void {
    this.cancelledQuestions.push(id);
    this.emit({
      type: "stream",
      sessionId: this.sessionId,
      text: `[问答 ${id} 已取消]`,
    });
  }

  interrupt(): void {
    this.interrupts++;
    this.emit({
      type: "notice",
      text: "[demo] 打断请求（demo 无真实 agent，已忽略）",
    });
  }

  private modelList: ModelInfo[] = [
    { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
    {
      provider: "deepseek",
      id: "deepseek-reasoner",
      name: "DeepSeek Reasoner",
    },
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

  async setSessionModel(sel: ModelSelection): Promise<ModelSelection> {
    this.currentModel = { ...sel };
    return { ...sel };
  }

  async modelEfforts(
    _provider: string,
    _model: string,
  ): Promise<{ id: string; name: string }[] | undefined> {
    return [
      { id: "minimal", name: "minimal" },
      { id: "low", name: "low" },
      { id: "medium", name: "medium" },
      { id: "high", name: "high" },
      { id: "max", name: "max" },
    ];
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
    // 分片思考流：验证最新几行限高与正文到达后清除。
    const thoughts = [
      "先理解问题…",
      "检查现有状态…",
      "组织回答结构…",
      "准备输出…",
      "完成推理。",
    ];
    for (let i = 0; i < thoughts.length; i++) {
      this.timers.push(
        setTimeout(
          () =>
            this.emit({
              type: "thinking",
              sessionId: this.sessionId,
              text: thoughts[i]! + "\n",
            }),
          delay + i * 55,
        ),
      );
    }
    const replyStart = delay + thoughts.length * 55 + 60;
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
          replyStart + i * 90,
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
        replyStart + chunks.length * 90 + 40,
      ),
    );
    // 流式结束后补发 turn-end：演示 turn 分隔线与状态区
    this.timers.push(
      setTimeout(
        () => this.emit({ type: "turn-end" }),
        replyStart + chunks.length * 90 + 60,
      ),
    );
    // 阶段 2 演示场景：工具调用/结果行、compaction/retry toast、错误回合红字、
    // token 用量（状态栏 contextLen/cacheHit，cacheRead 随 seq 递增演示命中率）
    const sceneAt = replyStart + chunks.length * 90 + 45;
    this.timers.push(
      setTimeout(() => {
        if (this.seq === 1) {
          // 归一化事件 tool-call（对应真实适配器 raw "tool/call"，阶段 3 联调由 dsh.ts 产出）
          this.emit({
            type: "tool-call",
            sessionId: this.sessionId,
            name: "bash",
            summary: "ls -la src/app",
          });
          this.emit({
            type: "tool-result",
            sessionId: this.sessionId,
            ok: true,
            detail: "总用量 3 目录，代码 2.4k 行",
          });
        } else if (this.seq === 2) {
          this.emit({
            type: "retry",
            attempt: 1,
            max: 2,
            delayMs: 1500,
            code: "TRANSPORT",
            message: "连接被重置",
          });
          this.emit({ type: "compaction", phase: "start" });
          this.emit({ type: "compaction", phase: "end" });
          this.emit({
            type: "tool-call",
            sessionId: this.sessionId,
            name: "bash",
            summary: "rm -rf /tmp/tui-demo",
          });
          this.emit({
            type: "tool-result",
            sessionId: this.sessionId,
            ok: false,
            detail: "EACCES: 13 权限不足",
          });
        } else if (this.seq === 3) {
          this.emit({
            type: "notice",
            text: "回合失败：E1301 mock 模拟 transport 错误",
            error: true,
            tone: "error",
          });
        }
      }, sceneAt),
    );
    this.timers.push(
      setTimeout(
        () =>
          this.emit({
            type: "usage",
            sessionId: this.sessionId,
            input: 4000 + this.seq * 2000,
            output: 900 + this.seq * 120,
            cacheRead: this.seq * 8000,
          }),
        sceneAt + 40,
      ),
    );
    if (this.seq === 2 && this.autoApproval) {
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
          replyStart + chunks.length * 90 + 120,
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
      "  - 每次回复演示阶段 2：工具行 ⚙/✓/✗、状态栏 ctx/cache、retry/compaction toast、错误回合红字",
      "  - 输入 /help /clearscreen /cls /quit 体验本地渲染命令",
      "  - 其他 /xxx 在 demo 模式回提示（真实模式走 commands 注册表）",
      "  - 输入框为空按 $ / / 切模式（空输入 Backspace 回退）；Esc 打断运行；Alt+Enter 打断并发送；退出用 /quit",
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

export function createMockDshAdapter(opts?: {
  autoApproval?: boolean;
}): DshAdapter {
  return new MockDshAdapter(opts?.autoApproval ?? true);
}

/** log stub — 阶段 1 demo；无需引入日志库 */
function log(msg: string): void {
  process.stderr.write("[mock] " + msg + "\n");
}
