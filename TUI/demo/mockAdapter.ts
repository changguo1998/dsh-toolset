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
  /** C 阶段冒烟断言：setApprovalPolicy 调用次数与最后一次策略 */
  setApprovalPolicyCalls = 0;
  lastPolicy: "ask" | "never" | undefined = undefined;
  selectPresetCalls = 0;
  lastPreset = "";
  killJobCalls = 0;
  lastKillId = "";
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

  async setApprovalPolicy(policy: "ask" | "never"): Promise<void> {
    // 模拟宿主 ctx.approval.setPolicy：记录 + 回发 approval/policy 事件（状态栏经事件回读）
    this.setApprovalPolicyCalls++;
    this.lastPolicy = policy;
    this.emit({
      type: "approval-policy",
      sessionId: this.sessionId,
      policy,
    });
  }

  async permissionCatalog() {
    // 模拟宿主 ctx.permissionPresets：rc.2 默认预设表（workspace-write / danger-full-access）
    return {
      current: "workspace-write",
      names: ["workspace-write", "danger-full-access"],
      entries: [
        {
          key: "workspace-write",
          name: "workspace-write",
          description:
            "Write inside the workspace; wider retries require approval.",
        },
        {
          key: "danger-full-access",
          name: "danger-full-access",
          description: "Full file access without approval prompts.",
        },
      ],
    };
  }

  async agentPresetCatalog() {
    // 模拟宿主 ctx.agentPresets：rc.2 演示目录（default + research + code-review）
    return {
      current: "research",
      defaultId: "default",
      presets: [
        {
          id: "default",
          name: "default",
          description: "General-purpose agent.",
        },
        {
          id: "research",
          name: "research",
          description: "Read-heavy research preset.",
        },
        {
          id: "code-review",
          name: "code-review",
          description: "Review-focused preset.",
        },
      ],
    };
  }

  async selectAgentPreset(id: string): Promise<void> {
    // 模拟宿主 ctx.agentPresets.recompose：记录 + 回发 agent-preset/selected 事件（状态栏回读）
    this.selectPresetCalls = (this.selectPresetCalls ?? 0) + 1;
    this.lastPreset = id;
    this.emit({ type: "agent-preset", sessionId: this.sessionId, preset: id });
  }

  /** jobs 快照（状态列 jobs 块 / 状态栏 / /jobs 面板共用） */
  private jobsSnapshot() {
    return [
      {
        id: "subprocess-1",
        kind: "subprocess",
        label: "run tests",
        status: "running",
      },
      {
        id: "subprocess-2",
        kind: "subprocess",
        label: "build demo",
        status: "done",
        detail: "ok",
      },
    ];
  }

  async refreshJobs(): Promise<void> {
    // 模拟 ctx.jobs.list()：回发 jobs-changed 全量快照（/jobs 面板 + 状态栏计数）
    this.emit({
      type: "jobs-changed",
      sessionId: this.sessionId,
      jobs: this.jobsSnapshot(),
    });
  }

  async killJob(id: string): Promise<void> {
    this.killJobCalls = (this.killJobCalls ?? 0) + 1;
    this.lastKillId = id;
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
    // P2 B1+B2 demo：注入 goal/todo/mode 事件（状态栏徽标 + /goal 面板场景）
    this.timers.push(
      setTimeout(
        () =>
          this.emit({
            type: "goal-change",
            sessionId: this.sessionId,
            operation: "create",
            goal: {
              id: "demo-goal-1",
              revision: 1,
              objective: "P2 阶段 B1+B2：/goal 迷你面板与状态栏模式徽标",
              phase: "active",
              maxGoalRounds: 10,
            },
            roundsStarted: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
        90,
      ),
    );
    this.timers.push(
      setTimeout(
        () =>
          this.emit({
            type: "todo-write",
            sessionId: this.sessionId,
            todos: [
              {
                content: "状态栏 goal 徽标与 todo 计数",
                status: "in_progress",
              },
              { content: "/goal 迷你面板", status: "in_progress" },
              { content: "模式徽标三合一", status: "completed" },
              {
                content:
                  "设计评审准备：这是一条较长的待办内容，用于演示状态列 todo 换行后的颜色保持与标记延续显示效果",
                status: "pending",
              },
            ],
          }),
        110,
      ),
    );
    // 模式徽标：plan 开启 + sandbox read-only + permission danger-full-access → plan·ro·full
    for (const [kind, value] of [
      ["plan", "on"],
      ["sandbox", "read-only"],
      ["permission", "danger-full-access"],
    ] as const) {
      this.timers.push(
        setTimeout(
          () =>
            this.emit({
              type: "mode",
              sessionId: this.sessionId,
              kind,
              value,
            }),
          130,
        ),
      );
    }
    // C 阶段 demo：启动注入 approval/policy（ask）→ 状态栏 ask 徽标（切换由 /policy 命令回发）
    this.timers.push(
      setTimeout(
        () =>
          this.emit({
            type: "approval-policy",
            sessionId: this.sessionId,
            policy: "ask",
          }),
        150,
      ),
    );
    // 启动注入 jobs 快照：状态列 jobs 块 / 状态栏 jobs 徽标默认可见；
    // /jobs 打开仍走 refreshJobs 重拉（行为不变）
    this.timers.push(
      setTimeout(
        () =>
          this.emit({
            type: "jobs-changed",
            sessionId: this.sessionId,
            jobs: this.jobsSnapshot(),
          }),
        170,
      ),
    );
  }

  private scheduleReply(): void {
    const delay = 400 + (this.seq % 4) * 180;
    this.seq++;
    // 本回合序号在调度时固化：场景分发/审批按 mySeq 匹配，
    // 避免定时器触发时共享 seq 已被后续回合递增导致场景错位（思考加长会推迟触发）
    const mySeq = this.seq;
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
    // 分片思考流：文本加长（总行数超出活动区可视高度），
    // 验证思考折叠上限=瞬态显示区高度，以及正文到达后清除。
    const thoughts = [
      "先理解问题：用户想了解 DSH 的交互模型，需要拆解为几个子问题。",
      "检查现有状态：面板布局、滚动语义与主题切换都是最近调整过的区域。",
      "活动区高度由终端行数动态计算，思考内容超过可视高度时折叠到最新几行。",
      "工具调用前后需要记录运行状态与输出摘要，避免把原始输出直接铺进活动区。",
      "通知行标题要保留，正文过长时截断到一行并补齐宽度，保持右缘对齐。",
      "组织回答结构：先结论后细节，把影响使用的差异点单独列出。",
      "历史区视口跟随底部开关在回答到达时复位，避免停留在旧位置。",
      "思考在正文首条到达或回合结束时整体清除，避免残留到下一回合。",
      "分隔线在回合开始时先画，正文使用打字机节奏逐字符铺出。",
      "顶部三面板用 Tab 循环，焦点面板由五行滚动键控制，状态列独立滚动。",
      "准备输出：检查主题色板与边框色在浅色下的对比度是否满足中性要求。",
      "对比官方会话事件词汇表，确认本轮要归一化的载荷形状与可选字段。",
      "状态栏按类分组聚合：环境组时间分支、会话组标题、LLM 组模型与上下文。",
      "审批弹窗由 approval/request 瀑布驱动，返回 outcome 即完成裁定。",
      "问答面板支持单选多选与自定义文本，Enter 逐题推进、末题整体提交。",
      "历史会话切换先切活跃引用再释放旧 handle，防止迟到异步结果误入面板。",
      "工具结果折叠为单行摘要，失败分支整行红色便于快速定位问题。",
      "notice 按 tone 分级着色，命令通知与压缩提示不污染对话正文。",
      "键盘解码区分 CSI 与 SS3 序列，方向键在普通与元键组合下对称响应。",
      "帧渲染按显示宽度切分，ANSI 转义不计宽、宽字符不在换行处被切断。",
      "缩放窗口时四区高度重新分配，活动区与对话区共用同一套计算口径。",
      "浅色主题下边框转为黑色中性色，正文与背景保持足够的对比度。",
      "思考内容是瞬态展示，回合开始先画分隔线、正文到达后整体清除。",
      "完成推理：以上问题均已在实现中落地，直接输出最终回答。",
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
        if (mySeq === 1) {
          // B3：step 分组——工具调用前先发 step/start，结束后 step/end（渲染出 `step 1` 分组头）
          this.emit({
            type: "step",
            sessionId: this.sessionId,
            turn: 1,
            step: 1,
            phase: "start",
          });
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
          this.emit({
            type: "step",
            sessionId: this.sessionId,
            turn: 1,
            step: 1,
            phase: "end",
          });
        } else if (mySeq === 2) {
          this.emit({
            type: "retry-started",
            sessionId: this.sessionId,
            attempt: 1,
          });
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
          // B3：第二个 step 组——失败工具调用也参与分组（`step 2` 分组头）
          this.emit({
            type: "step",
            sessionId: this.sessionId,
            turn: 1,
            step: 2,
            phase: "start",
          });
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
          this.emit({
            type: "step",
            sessionId: this.sessionId,
            turn: 1,
            step: 2,
            phase: "end",
          });
        } else if (mySeq === 3) {
          this.emit({
            type: "notice",
            text: "回合失败：E1301 mock 模拟 transport 错误",
            error: true,
            tone: "error",
          });
          // B4：subagent 行（`@ researcher os`）——append-only，与工具行同区
          this.emit({
            type: "subagent",
            sessionId: this.sessionId,
            label: "researcher",
            mode: "one-shot",
          });
          // B5：compaction 摘要 toast（`压缩完成：<text 首行>`；raw 携完整载荷入 state）
          // P3 演示：workflow 运行 / command 流 / code-dispatch / hook / schedule / prune / feedback
          this.emit({
            type: "workflow",
            sessionId: this.sessionId,
            phase: "run-start",
            label: "research-toolset",
          });
          this.emit({
            type: "workflow",
            sessionId: this.sessionId,
            phase: "agent-start",
            label: "reviewer",
            detail: "1",
          });
          this.emit({
            type: "workflow",
            sessionId: this.sessionId,
            phase: "agent-end",
            label: "",
            detail: "1 success",
          });
          this.emit({
            type: "workflow",
            sessionId: this.sessionId,
            phase: "run-end",
            label: "",
            detail: "completed",
          });
          this.emit({
            type: "command",
            sessionId: this.sessionId,
            phase: "run",
            name: "goal",
          });
          this.emit({
            type: "command",
            sessionId: this.sessionId,
            phase: "done",
            name: "goal",
            text: "任务不存在",
            ok: false,
          });
          this.emit({
            type: "code-dispatch",
            sessionId: this.sessionId,
            phase: "start",
            name: "read",
            summary: "src/app/index.ts",
            ok: true,
          });
          this.emit({
            type: "code-dispatch",
            sessionId: this.sessionId,
            phase: "settle",
            name: "read",
            summary: "",
            ok: true,
          });
          this.emit({
            type: "hook",
            sessionId: this.sessionId,
            phase: "invoked",
            point: "PreToolUse",
            ok: true,
          });
          this.emit({
            type: "hook",
            sessionId: this.sessionId,
            phase: "result",
            point: "PreToolUse",
            decision: "allow",
            ok: true,
          });
          this.emit({
            type: "schedule",
            sessionId: this.sessionId,
            operation: "dispatch",
            id: "sched-1",
          });
          // B5：compaction 摘要 toast（`压缩完成：<text 首行>`；raw 携完整载荷入 state）
          this.emit({
            type: "compaction-summary",
            sessionId: this.sessionId,
            text: "已压缩 182 条历史消息",
            raw: {
              summary: [{ type: "text", text: "已压缩 182 条历史消息" }],
            },
          });
          this.emit({
            type: "compaction-prune",
            sessionId: this.sessionId,
            nodeCount: 42,
            tokenCount: 36000,
          });
          this.emit({
            type: "feedback",
            sessionId: this.sessionId,
            text: "很好用",
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
    if (mySeq === 2 && this.autoApproval) {
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
      "  - 每次回复演示阶段 2：工具行 ○/✓/✗、状态栏 ctx/cache、retry/compaction toast、错误回合红字",
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
