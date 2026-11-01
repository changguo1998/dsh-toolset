// src/app/state/actions.ts — reducer 的 action 联合类型

import type {
  ApprovalItem,
  AgentStatus,
  SessionMeta,
  QuestionItem,
  SessionInfo,
  HistoryMessage,
  NoticeTone,
  CompactionSummaryPayloadLike,
  GoalOperation,
  GoalActivation,
  GoalRefLike,
  GoalSnapshotLike,
  TodoItemLike,
  JobInfo,
  CommandPanelRow,
  CommandPanelKind,
  AgentRowInfo,
} from "../adapter/dsh.ts";
import type { SectionsState } from "../layout/pipeline/sections.ts";
import type { ActiveAtToken, FileMentionCandidate } from "../file-mention.ts";
import type { DialogueTop } from "../layout/pipeline/rows.ts";
import { type CommandCandidate } from "../commands.ts";
import { type ThemeId } from "../../renderer/theme.ts";
import type {
  ActivityCategory,
  HistoryRow,
  InputMode,
  InputStatus,
  PanelId,
  PickerState,
  StatusPanelState,
  SystemStatus,
  TurnEndReason,
} from "./types.ts";
import type { NoticeLine } from "./updates.ts";

// src/app/state/actions.ts — reducer 的 action 联合类型

export type StateAction =
  | { type: "append"; text: string; time?: number }
  | { type: "user-line"; text: string }
  /** 排队消息登记：**追加**一条（不合并；发送走官方 followup，核心逐条认领） */
  | { type: "queued-push"; text: string; kind?: "followup" | "steer" }
  /** 核心认领最早一条排队消息（新回合开始）：弹出并作为用户行落历史 */
  | { type: "queued-claim" }
  /** TUI#43：认领最早一条 steer 排队项（宿主在 step 边界摘除 steer 时触发） */
  | { type: "queued-claim-steer" }
  | { type: "queued-clear" }
  | { type: "thinking"; text: string; time?: number }
  /** 运行中闪烁时间驱动（App 在 running 期间周期性发送）：无数据时虚拟速度
   *  衰减回落、虚拟总 token 持续积分（闪烁不停、频率渐降到最低） */
  | { type: "virt-tick"; time: number }
  | {
      type: "notice";
      text: string;
      /** 结构化多行（/help 表格）：每条独立成行并可带悬垂缩进；缺省走 text */
      lines?: NoticeLine[];
      error?: boolean;
      tone?: NoticeTone;
    }
  /** `$` 模式本地 shell 输出行（BACKLOG TUI#37）：kind="shell"，仅活动区本地显示 */
  | {
      type: "shell-lines";
      lines: readonly { text: string; tone?: NoticeTone }[];
    }
  | { type: "clear-buffer" }
  | { type: "agent-status"; status: AgentStatus }
  | {
      type: "approval";
      approval: ApprovalItem | null;
      /** 审批超时时刻（epoch ms；仅打开时有意义，3.2.5） */
      deadline?: number | null;
    }
  | { type: "approval-focus"; focus: "approve" | "reject" }
  | { type: "approval-tab" }
  | { type: "approval-no-timeout" }
  | { type: "approval-hint"; text: string | null }
  | { type: "picker-open"; picker: PickerState }
  | { type: "picker-move"; delta: number }
  | { type: "picker-tab" }
  | { type: "picker-phase"; delta: 1 | -1 }
  | { type: "picker-select" }
  /** 当前焦点列的筛选词整体替换（键入选入由 picker-filter.ts 逐键算出） */
  | { type: "picker-filter"; text: string }
  | {
      type: "picker-efforts";
      efforts: { id: string; name: string }[];
      /** 非 0 时代表预设高亮等级（模型行自带等级时的默认选中），匹配不到回退 0 */
      effortIndex?: number;
    }
  | { type: "picker-close" }
  | {
      type: "question-open";
      id: string;
      questions: QuestionItem[];
      /** 问题前正文（3.2.10） */
      source?: string;
    }
  | { type: "question-move"; delta: number } // 数字键直标需要跨多项跳转（BACKLOG 3.2.6）
  | { type: "question-nav"; delta: 1 | -1 }
  | { type: "question-select" }
  /** 自定义回答文本 + 编辑光标（TUI#35：caret = 字符偏移；null/缺省 = 未编辑态） */
  | { type: "question-custom"; text: string; caret?: number | null }
  /** 自定义回答光标左右移动（TUI#35；仅编辑态生效，越界 clamp 不动） */
  | { type: "custom-caret"; delta: 1 | -1 }
  | { type: "question-focus" }
  | { type: "question-desc-scroll"; delta: 1 | -1; max: number }
  | { type: "approval-scroll"; delta: 1 | -1; max: number }
  | { type: "question-close" }
  | { type: "history-open" }
  | { type: "history-list"; records: SessionInfo[] }
  | { type: "history-list-error"; error: string }
  | { type: "history-move"; delta: number }
  | { type: "history-scope-toggle" }
  | { type: "history-mark-toggle" }
  | { type: "history-mark-all" }
  | { type: "history-mark-clear" }
  | { type: "history-open-view" }
  | { type: "history-view"; id: string; messages: HistoryMessage[] }
  | { type: "history-view-error"; error: string }
  | { type: "history-resume"; id: string }
  | { type: "history-resume-error"; id: string; error: string }
  | {
      type: "history-resume-ok";
      id: string;
      title: string;
      /** 恢复行（P9 起含 step 概要行、TUI#17 起含 notice 摘要行；含回合分隔线行）——
       *  条目 16 段 C2：内容行形态由 `HistoryRow` 表达（缓冲不再承载它们） */
      rows: HistoryRow[];
    }
  /** TUI#40：启动即恢复（--resume / -c）——把既有消息折叠入历史行（无 /session 面板参与） */
  | {
      type: "history-restore";
      id: string;
      title: string;
      rows: HistoryRow[];
    }
  /** 切换活跃会话（/new 新建后切过去）：缓冲/滚动/窗口按空会话重置 */
  | { type: "session-switch"; id: string; title: string }
  | { type: "history-scroll"; delta: number }
  | { type: "history-back" }
  | { type: "history-result"; text: string }
  | { type: "history-refresh"; records: SessionInfo[] }
  | { type: "history-confirm-delete" }
  | { type: "history-confirm-clean" }
  | { type: "history-confirm-cancel" }
  | { type: "history-delete" }
  | { type: "history-delete-done"; ids: string[] }
  | { type: "history-clean" }
  | { type: "history-clean-done"; ids: string[] }
  | { type: "history-close" }
  | { type: "session-identify"; id: string; title: string }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "input"; text: string; cursor: number }
  | { type: "input-mode"; mode: InputMode }
  | { type: "input-status"; status: InputStatus }
  /** 输入历史（BACKLOG TUI#34）：push 入栈（提交时）/ prev 上翻 / next 下翻（回草稿） */
  | { type: "input-history"; action: "push" | "prev" | "next" }
  | { type: "move-cursor"; delta: number }
  /**
   * 对话区滚动到指定视口顶（位移换算在 App：拿到本帧段表与可视高，`null` = 贴底跟随最新）。
   * `offset` = 距底行数（段键失配时的回落基准）。
   */
  | { type: "dialogue-scroll"; top: DialogueTop | null; offset: number }
  | { type: "scroll-to-bottom" }
  /** 扩窗：只多物化更早回合组，视口位置不动（App 在施加位移之前调用） */
  | { type: "window-grow"; groups: number }
  /** 六步流水线节缓存整体替换（App 注入；undefined = 无会话） */
  | {
      type: "pipeline-state";
      pipeline: SectionsState | undefined;
    }
  /** clearActivity：是否清空活动区内容（缺省 true；核心自发回合传 false，见 appendTurnSeparator） */
  | {
      type: "turn-begin";
      clearActivity?: boolean;
      time?: number;
      turn?: number;
    }
  /** #3：宿主 `turn/start` 的回合号回填（本地 turn-begin 早于该事件，分隔线先落行后补号） */
  | { type: "turn-number"; turn: number }
  /** P1：reason 决定最新用户块的终态符号（completed→✓ / aborted→■ / error→✗ / 其余→?） */
  | { type: "turn-end"; reason?: TurnEndReason }
  | { type: "clear-stripped" }
  | { type: "status"; status: Partial<SystemStatus> }
  | { type: "set-theme"; themeId: ThemeId }
  | { type: "activity-compact"; categories: ActivityCategory[]; on: boolean }
  /** BACKLOG #8：活动区输出内容档位（think / tool / step） */
  | { type: "activity-show"; categories: ActivityCategory[]; on: boolean }
  /** P7：垂直状态列显隐（visible 缺省 = 取反；`Ctrl+S` 走 focus-panel 的聚焦 / 收起两态，本 action 供恢复或显式设值） */
  | { type: "status-column"; visible?: boolean }
  /** #9：下半区（Turn 流 + Tool 面板区）显隐（visible 缺省 = 取反；`Ctrl+T` 走 focus-panel） */
  | { type: "lower-panes"; visible?: boolean }
  | { type: "symbol-unify"; on: boolean }
  | { type: "tool-call"; sessionId: string; name: string; summary: string }
  | {
      type: "model-selection";
      sessionId: string;
      provider?: string;
      model?: string;
      reasoningEffort?: unknown;
    }
  | {
      type: "tool-result";
      sessionId: string;
      ok: boolean;
      detail: string;
      meta?: unknown;
    }
  | {
      type: "model-selection";
      sessionId: string;
      provider?: string;
      model?: string;
      reasoningEffort?: unknown;
    }
  | {
      type: "usage";
      sessionId: string;
      input: number;
      output: number;
      cacheRead: number;
      contextWindow?: number;
    }
  /** P8：sessionId 用于把「压缩中」记到该会话（缺省回退当前活跃会话） */
  | { type: "compaction"; phase: "start" | "end"; sessionId?: string }
  | {
      type: "retry";
      attempt: number;
      max: number;
      delayMs: number;
      code: string;
      message?: string;
    }
  // --- P2 阶段 A 新增（goal 为判别联合，compaction 摘要携完整 raw；step/subagent 阶段 A 透传） ---
  | {
      type: "goal-change";
      sessionId: string;
      operation: Exclude<GoalOperation, "clear">;
      goal: GoalSnapshotLike;
      roundsStarted?: number;
      createdAt?: number;
      updatedAt?: number;
    }
  | {
      type: "goal-change";
      sessionId: string;
      operation: "clear";
      cleared: GoalRefLike;
      clearedAt?: number;
    }
  /** goal 自动续轮开关（进程本地事件；`activation` 缺省 = 该会话已无当前 goal → 清记录） */
  | {
      type: "goal-activation";
      sessionId: string;
      activation?: GoalActivation;
    }
  | { type: "todo-write"; sessionId: string; todos: TodoItemLike[] }
  /** TUI#39：子代理目录快照（状态列 Agents 块；last-write-wins，按会话隔离） */
  | { type: "agents-changed"; sessionId: string; agents: AgentRowInfo[] }
  | {
      type: "mode";
      sessionId: string;
      kind: "plan" | "sandbox" | "permission";
      value: string;
    }
  | {
      type: "step";
      sessionId: string;
      turn: number;
      step: number;
      phase: "start" | "end";
      /** P6：step 事件时间（epoch ms）——分组头时间戳；缺省回退当前时刻 */
      time?: number;
    }
  | {
      type: "subagent";
      sessionId: string;
      label: string;
      mode: "one-shot" | "continuable";
    }
  | {
      type: "compaction-summary";
      sessionId: string;
      text: string;
      raw: CompactionSummaryPayloadLike;
    }
  | {
      type: "approval-policy";
      sessionId: string;
      policy: "ask" | "never";
    }
  | {
      type: "workflow";
      sessionId: string;
      phase: "run-start" | "agent-start" | "agent-end" | "run-end";
      label: string;
      detail?: string;
    }
  | {
      type: "command";
      sessionId: string;
      phase: "run" | "done";
      name: string;
      text?: string;
      ok?: boolean;
    }
  | {
      type: "code-dispatch";
      sessionId: string;
      phase: "start" | "settle";
      name: string;
      summary: string;
      ok: boolean;
    }
  | {
      type: "hook";
      sessionId: string;
      phase: "invoked" | "result";
      point: string;
      decision?: string;
      ok: boolean;
    }
  | {
      type: "schedule";
      sessionId: string;
      operation: "create" | "delete" | "dispatch";
      id?: string;
    }
  | {
      type: "compaction-prune";
      sessionId: string;
      nodeCount: number;
      tokenCount: number;
    }
  | { type: "feedback"; sessionId: string; text: string }
  | { type: "retry-started"; sessionId: string; attempt: number }
  | { type: "agent-preset"; sessionId: string; preset: string }
  | { type: "permission-catalog"; names: string[] }
  | { type: "agent-preset-catalog"; ids: string[] }
  | { type: "jobs-changed"; sessionId: string; jobs: JobInfo[] }
  | { type: "status-panel-open"; panel: StatusPanelState }
  | { type: "status-panel-move"; delta: number }
  | { type: "status-panel-select" }
  | { type: "status-panel-close" }
  | { type: "jobs-panel-open" }
  | { type: "jobs-panel-move"; focus: number; delta: number }
  | { type: "jobs-panel-page"; delta: number; page: number }
  | { type: "jobs-panel-close" }
  | { type: "command-panel-open"; kind: CommandPanelKind }
  | { type: "command-panel-move"; delta: number }
  | { type: "command-panel-page"; delta: number; page: number }
  | { type: "command-panel-close" }
  | {
      type: "command-panel-data";
      kind: CommandPanelKind;
      rows: CommandPanelRow[];
      error?: string;
    }
  | { type: "status-column-scroll"; delta: number }
  /** 聚焦指定面板（`Ctrl+E` 会话区 / `Ctrl+T` 回合区 / `Ctrl+S` 状态列）：已聚焦则收起 + 回会话区 */
  | { type: "focus-panel"; panel: PanelId }
  | {
      type: "activity-scroll";
      delta: number;
      max?: number;
      top?: DialogueTop | null;
      offset?: number;
    }
  /** max = 可视候选数上界（App 按活动区行数给；超出可视区的候选不参与焦点导航） */
  | { type: "completion-move"; delta: number; max?: number }
  | { type: "completion-close" }
  /** 异步文件候选回填（App 请求宿主 fileReferences 后回写；token 与当前不一致则丢弃） */
  | {
      type: "completion-data";
      token: ActiveAtToken;
      items: readonly FileMentionCandidate[];
    }
  /** 宿主文件提及服务可用性（启动探测一次；false = `@` 按普通字符输入，无面板） */
  | { type: "file-mention-available"; available: boolean }
  | { type: "command-catalog"; commands: readonly CommandCandidate[] };

/**
 * 输入变更的单一漏斗点：按「命令 token → 活动 `@` token」顺序重算候选。
 *
 * 命令候选同步可得；文件候选是**异步**的——这里只登记活动 token（items 首帧为空），
 * 由 App 请求宿主服务后用 `completion-data` 回填（回填带过期丢弃）。触发面限提示文本
 * （steer / followup）：`@` 提及是模型侧提示语法，slash 参数与 shell 命令里无意义
 * （decisions「触发范围」）；宿主服务未挂载（`fileMentionAvailable=false`）时不产生候选
 * ——`@` 按普通字符输入，无面板也无报错。
 */
