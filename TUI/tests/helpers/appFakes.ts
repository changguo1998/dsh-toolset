// tests/helpers/appFakes.ts — App 层测试共用假件（原在 app.test.ts，input-history.test.ts 亦复用）
//
// FakeRenderer：记录渲染帧与按键回调；FakeAdapter：记录发送/命令/事件的最小 DshAdapter 形状。
// 从 app.test.ts 抽出以免「跨测试文件 import」导致被导入文件的用例被重复执行。

import type { KeyEvent, Renderer } from "../../src/renderer/index.ts";
import type { FrameRow, Size } from "../../src/renderer/screen.ts";
import type { ThemeId } from "../../src/renderer/theme.ts";
import type {
  DshAdapter,
  DshEvent,
  AgentRowInfo,
  ModelCatalog,
  ModelReasoning,
  ModelSelection,
  QuestionAnswer,
  SessionInfo,
  SessionSurfaceView,
  HistoryMessage,
} from "../../src/app/adapter/dsh.ts";
import type { SessionUiState } from "../../src/app/adapter/session-ui-state.ts";
import { flushApp } from "./paintFlush.ts";
import { rowAnsi } from "./rowText.ts";

/** 记录行为的 fake renderer */
export class FakeRenderer implements Renderer {
  keys: KeyEvent[] = [];
  private renderCount = 0;
  /** 读帧前同步冲刷合帧（生产语义：同 tick 多次标脏只画一次） */
  get renders(): number {
    flushApp();
    return this.renderCount;
  }
  private refreshCount = 0;
  get refreshes(): number {
    flushApp();
    return this.refreshCount;
  }
  closed = 0;
  size: Size = { cols: 80, rows: 24 };
  /** 最近一次 render 的文本行（含 ANSI SGR，等价旧 RenderLine.text） */
  private lastRenderRows: string[] = [];
  get lastRender(): string[] {
    flushApp();
    return this.lastRenderRows;
  }
  /** 当前主题（初始 dark；/theme 切换经 setTheme 更新） */
  themeId: ThemeId = "dark";

  render(rows: FrameRow[]): void {
    this.lastRenderRows = rows.map((r) => rowAnsi(r, this.themeId));
    this.renderCount++;
  }
  refresh(_rows: FrameRow[]): void {
    this.refreshCount++;
  }
  onKey(cb: (k: KeyEvent) => void): void {
    this.keys.length = 0;
    // 简单起见保留最后注册的 cb
    this.keys.push({ name: "__cb__", ctrl: false } as KeyEvent);
    this.press = cb;
  }
  emitKey(k: KeyEvent): void {
    this.press(k);
  }
  onResize(cb: (cols: number, rows: number) => void): void {
    this.resize = cb;
  }
  getSize(): Size {
    return this.size;
  }
  /** 记录 setTheme 调用（断言初始主题与 /theme 切换用）；同时用于行序列化主题 */
  themeCalls: ThemeId[] = [];
  setTheme(id: ThemeId): void {
    this.themeCalls.push(id);
    this.themeId = id;
  }
  close(): void {
    this.closed++;
  }
  press!: (k: KeyEvent) => void;
  resize!: (cols: number, rows: number) => void;
}

/** 记录行为的 fake adapter（导出：App 层测试共用） */
export class FakeAdapter implements DshAdapter {
  sessionId = "s1";
  sent: string[] = [];
  commands: string[] = [];
  events: DshEvent[] = [];
  disposed = 0;
  private cbs: ((e: DshEvent) => void)[] = [];
  /** 非空时 restoreSessionState 会把这些事件推给 app（模拟宿主状态回读） */
  modeSnapshotEvents: DshEvent[] | null = null;
  async restoreSessionState(): Promise<void> {
    if (!this.modeSnapshotEvents) return;
    for (const e of this.modeSnapshotEvents) this.push(e);
  }
  /** /new 新建会话调用次数与返回的新会话 id（模拟 agents.create 换成新会话） */
  newSessionCalls = 0;
  newSessionId = "s-new";
  async newSession(): Promise<{ id: string }> {
    this.newSessionCalls++;
    return { id: this.newSessionId };
  }
  /** 会话状态快照落盘记录（saveSessionUiState；模拟写入会话目录 tui-state.json） */
  savedUiStates: { sessionId: string; state: SessionUiState }[] = [];
  saveSessionUiState(sessionId: string, state: SessionUiState): boolean {
    this.savedUiStates.push({ sessionId, state });
    return true;
  }
  readSessionUiState(): SessionUiState | undefined {
    return undefined;
  }

  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }
  /** 有序行为日志（断言互操作顺序，如打断先于发送） */
  log: string[] = [];
  /** steer 投递记录（target='next-step'，BACKLOG TUI#36 断言用） */
  steered: string[] = [];
  /** 模拟宿主 agent 是否支持 steer（缺省 true；置 false 验证降级提示） */
  steerSupported = true;
  canSteer(): boolean {
    return this.steerSupported;
  }
  sendMessage(text: string, _sessionId?: string, target?: "next-step"): void {
    this.sent.push(text);
    if (target === "next-step") this.steered.push(text);
    this.log.push(target === "next-step" ? `steer:${text}` : `send:${text}`);
  }
  runCommand(line: string): void {
    this.commands.push(line);
    this.log.push(`cmd:${line}`);
    // 真实适配器对未命中注册表的命令回 error notice（fail-close）
    this.push({
      type: "notice",
      text: "未知命令，输入 /help 查看可用命令。",
      error: true,
    });
  }
  dispose(): void {
    this.disposed++;
  }
  /** TUI#39：状态列 Agents 块数据源；用例置 agentsRows 后（事件或定时）刷新即推送快照 */
  agentsRows: AgentRowInfo[] | null = null;
  refreshAgentsCalls = 0;
  async refreshAgents(): Promise<void> {
    this.refreshAgentsCalls++;
    if (this.agentsRows) {
      this.push({
        type: "agents-changed",
        sessionId: this.sessionId,
        agents: this.agentsRows,
      });
    }
  }
  /** 审批应答记录（BACKLOG 3.2.4 / 3.3.1 断言用） */
  approvals: { id: string; allow: boolean }[] = [];
  approve(id: string, allow: boolean): void {
    this.approvals.push({ id, allow });
  }
  cancelledApprovals: string[] = [];
  cancelApproval(id: string): void {
    this.cancelledApprovals.push(id);
  }
  /** 收到过「停止超时」通知的审批 id（BACKLOG 3.3.5） */
  stoppedTimeouts: string[] = [];
  stopApprovalTimeout(id: string): void {
    this.stoppedTimeouts.push(id);
  }
  /** 审批超时（ms）：用例可注入，验证 App 倒计时取 adapter 值（BACKLOG 3.3.2 同源） */
  timeoutMs?: number;
  approvalTimeoutMs(): number {
    return this.timeoutMs ?? 60_000;
  }
  /** 问答提交记录（含整批答案），供测试断言 */
  answeredQuestions: { id: string; answer: QuestionAnswer }[] = [];
  cancelledQuestions: string[] = [];
  answerQuestion(id: string, answer: QuestionAnswer): void {
    this.answeredQuestions.push({ id, answer });
    this.log.push(`answer:${id}`);
  }
  cancelQuestion(id: string): void {
    this.cancelledQuestions.push(id);
    this.log.push(`cancel:${id}`);
  }
  interrupts = 0;
  interrupt(): void {
    this.interrupts++;
    this.log.push("interrupt");
  }
  catalogCalls = 0;
  savedSelections: ModelSelection[] = [];
  modelCatalogData: ModelCatalog = {
    providers: [{ provider: "deepseek", name: "deepseek" }],
    models: [
      { provider: "deepseek", id: "deepseek-test-a", name: "Test A" },
      {
        provider: "deepseek",
        id: "deepseek-test-b",
        name: "Test B",
      },
    ],
    current: { provider: "deepseek", model: "deepseek-test-a" },
  };
  async modelCatalog(): Promise<ModelCatalog> {
    this.catalogCalls++;
    return this.modelCatalogData;
  }
  async setSessionModel(sel: ModelSelection): Promise<ModelSelection> {
    this.savedSelections.push(sel);
    this.modelCatalogData = { ...this.modelCatalogData, current: { ...sel } };
    return { ...sel };
  }
  modelEffortsCalls: { provider: string; model: string }[] = [];
  async modelEfforts(
    provider: string,
    model: string,
  ): Promise<{ id: string; name: string }[] | undefined> {
    this.modelEffortsCalls.push({ provider, model });
    return [
      { id: "low", name: "low" },
      { id: "high", name: "high" },
      { id: "max", name: "max" },
    ];
  }
  /** 模拟 provider 默认等级（未显式选择时状态栏/面板按它显示）；缺省 undefined=无默认 */
  modelReasoningData: ModelReasoning | undefined = undefined;
  async modelReasoning(
    provider: string,
    model: string,
  ): Promise<ModelReasoning | undefined> {
    this.modelEffortsCalls.push({ provider, model });
    if (this.modelReasoningData) return this.modelReasoningData;
    return {
      efforts: [
        { id: "low", name: "low" },
        { id: "high", name: "high" },
        { id: "max", name: "max" },
      ],
    };
  }
  // --- 输入补全：宿主命令注册表目录（undefined = 模拟服务未暴露 list） ---
  commandListData: { name: string; desc: string }[] | undefined = [
    { name: "compact", desc: "压缩会话上下文" },
    { name: "feedback", desc: "提交反馈" },
    { name: "model", desc: "宿主同名命令（应被本地目录去重屏蔽）" },
  ];
  commandList(): { name: string; desc: string }[] | undefined {
    return this.commandListData;
  }
  // --- /history 历史会话（置 undefined 模拟宿主未挂载 sessionQuery） ---
  sessionRecords: SessionInfo[] = [];
  sessionSurfaces: Record<string, HistoryMessage[]> = {};
  listSessionsCalls = 0;
  readSurfaceCalls: string[] = [];
  /** TUI#40：模拟「本次进程启动即恢复」（--resume / -c）；缺省 false = 全新会话启动 */
  resumedAtLaunch = false;
  listSessions: (() => Promise<SessionInfo[]>) | undefined = async () => {
    this.listSessionsCalls++;
    return this.sessionRecords;
  };
  readSessionSurface:
    ((id: string) => Promise<SessionSurfaceView>) | undefined = async (id) => {
    this.readSurfaceCalls.push(id);
    const m = this.sessionSurfaces[id];
    if (!m) throw new Error('stored session "' + id + '" is corrupt');
    return { sessionId: id, messages: m };
  };
  resumeCalls: string[] = [];
  resumeReject?: string;
  resumeTo: ((id: string) => Promise<void>) | undefined = async (id) => {
    this.resumeCalls.push(id);
    if (this.resumeReject) throw new Error(this.resumeReject);
  };
  /** 官方 session/title 标题（缺省无 → app 走 deriveTitle 本地兜底） */
  sessionTitleValues: Record<string, string> = {};
  sessionTitleCalls: string[] = [];
  sessionTitle: ((id: string) => Promise<string | undefined>) | undefined =
    async (id) => {
      this.sessionTitleCalls.push(id);
      return this.sessionTitleValues[id];
    };

  /** 测试辅助：注入事件 */
  push(e: DshEvent): void {
    for (const cb of this.cbs) cb(e);
  }
}
