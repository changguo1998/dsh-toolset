// src/engine-types.ts — 引擎对外类型面：根契约、执行请求 / 结果、终态钩子与选项
//
// 纯类型模块（无运行时代码）：引擎、执行面适配器与工具面都从这里取类型，
// 避免互相 import 实现文件。

import type {
  AcceptanceHooks,
  AuditRequest,
  AuditVerdict,
} from "./acceptance.ts";
import type { GateConfig } from "./gate.ts";
import type {
  Acceptance,
  ChildSpec,
  ExecutorSpec,
  Frame,
  FrameId,
  LoggedPlanEvent,
  NestedTaskItem,
  TokenKind,
} from "./types.ts";

export interface RootSpec {
  /** 缺省 "root" */
  id?: FrameId;
  title: string;
  spec: string;
  acceptance: Acceptance[];
  /** 根是否需要再拆（默认 true；false = 根即叶子） */
  needDecompose?: boolean;
  /** 根即叶子时的执行后端声明（同 ChildSpec.executor） */
  executor?: ExecutorSpec;
}

/**
 * executor 执行请求（引擎 → 后端适配器，`main.ts` 接线真实宿主面）。
 * 引擎只做发起：拼装请求、回填证据、交给既有 RET 验收。
 */
export interface ExecuteRequest {
  frame: FrameId;
  title: string;
  spec: string;
  acceptance: Acceptance[];
  executor: ExecutorSpec;
  /** 上一次打回反馈（重试时带上，便于后端修正） */
  feedback?: string;
}

/** executor 执行结果（证据回填；ok=false 走打回通道，除非 `retryable === false`） */
export interface ExecuteOutcome {
  ok: boolean;
  /** 证据正文（ok=true 时写回 `plan/frame-implemented`） */
  result?: string;
  /** 失败反馈（ok=false 时打回给模型） */
  feedback?: string;
  /** 结构化产出（workflow `value` 等；记入 `plan/frame-executed`，不进证据正文） */
  structured?: unknown;
  /** 事后计量 / 后端自报的 token 用量（②） */
  tokens?: number;
  /**
   * 计量口径：`pressure` = 会话上下文压力（`tokenMeter.measure` 的 totalTokens，含系统
   * 提示词与工具定义）；`usage` = provider 上报的输出 token（投影 `totals`，跨请求累计）。
   * 两者都只是**信息量**，不参与数值比较（见 `overBudget`）。
   */
  tokensKind?: TokenKind;
  /**
   * 后端给出的**超预算权威信号**（subagent = 宿主 `stopReason === "max-tokens"`：输出被
   * **每次请求**的上限截断）。引擎只在叶子声明了 `budget.maxTokens` 时采纳；不是数值比较。
   */
  overBudget?: boolean;
  /** 实际使用的模型（`provider/model`；未覆盖时为空 = 随宿主默认） */
  model?: string;
  /**
   * 失败是否可重试（缺省 true = 走 bounded retry 打回）。
   * `false` = 声明 / 环境问题（脚本语法错、宿主面缺失、能力位不足、用户取消）：
   * 引擎**不打回、不计重试、不改帧状态**，只把反馈交给模型去改声明。
   */
  retryable?: boolean;
  /**
   * 执行前命令复查（security-guard）**被跳过**（服务不可用 / 抛错 → fail-open 放行，未复查即执行）：
   * 记入 `plan/frame-executed.guardSkipped`（D1：复查不可用要可见，不静默）。
   */
  guardSkipped?: boolean;
}

/** executor 后端适配器（宿主侧接线；未注入时 execute fail-closed 打回） */
export type ExecutorRunner = (req: ExecuteRequest) => Promise<ExecuteOutcome>;

/**
 * 帧进入**终态**（done / failed）时的钩子（executor 隔离据此回收 worktree）：
 * 在帧被标记终态**之前**调用，返回非空字符串 = 终态注记（原样写进 `plan/frame-completed` /
 * `plan/frame-failed` 的 `notice` 字段，并随 `stop` 的返回透出）。抛错不冒泡：转成注记文本。
 * 缺省不注入 → 既有行为逐字不变。
 */
export type TerminalHook = (
  frame: FrameId,
  status: "done" | "failed",
) => Promise<string | undefined> | string | undefined;

/** execute 结果（与 stop 同口径的 step 级裁决 + 证据摘要 + 用量） */
export interface ExecuteResult {
  ok: boolean;
  accepted: boolean;
  /** 建议下一步：成功 = 本帧（待 stop 验收）；失败 = 本帧（重做）或 null（已 failed） */
  next: FrameId | null;
  feedback?: string;
  /** 证据摘要（截断，供工具返回值直接展示） */
  evidence?: string;
  /** 用量与预算标注（②；超预算只标注、不据此打回） */
  usage?: { tokens?: number; tokensKind?: TokenKind; overBudget?: boolean };
}

/** 语义蕴含（第二道门）hook：独立 entail run 判定 ∧Qᵢ ⟹ Q_parent（§17.2）。宿主侧实现。 */
export type EntailHook = (
  parent: Frame,
  children: ChildSpec[],
) => Promise<{
  ok: boolean;
  feedback: string;
  /**
   * 裁决 run **不可用**（环境 / 超时 / 输出不可解析）而跳过该门：不据此打回、不烧重试预算
   * （区分「模型判出不成立」与「跑不起来」——后者不该把可拆解变成整树 failed）。
   */
  skipped?: boolean;
}>;

export interface TaskEngineOptions {
  root: RootSpec;
  /** 从既有事件流恢复（resume；与 root 二选一） */
  log?: LoggedPlanEvent[];
  gate?: Partial<GateConfig>;
  runCommand?: AcceptanceHooks["runCommand"];
  approve?: AcceptanceHooks["approve"];
  /** 语义级验收的独立 audit run（§16.2）。未配置时语义级 fail-closed。 */
  audit?: (req: AuditRequest) => Promise<AuditVerdict>;
  /** 语义蕴含第二道门（§17.2）。未配置时只做机械门禁（结构蕴含跳过）。 */
  entail?: EntailHook;
  /** executor 后端适配器（①）。未配置时声明了非 model 后端的帧 execute fail-closed。 */
  executor?: ExecutorRunner;
  /** 帧进入终态时的钩子（executor 隔离的 worktree 回收走这里） */
  onFrameTerminal?: TerminalHook;
  /** 配置后每次变更自动写快照（周期快照，§15.1 L3） */
  snapshotPath?: string;
}

export type ActionResult =
  | { ok: true; guardSkipped?: true }
  | { ok: false; feedback: string; guardSkipped?: true };

/** decompose 结果（BACKLOG #5：step 级 accepted/next） */
export type DecomposeResult =
  | { ok: true; accepted: true; next: FrameId | null }
  | { ok: false; accepted: false; next: null; feedback: string };

/** stop 结果（BACKLOG #5：step 级 accepted/next + 打回反馈） */
export interface StopResult {
  ok: boolean;
  /** 本步验收是否通过（accepted 与 ok 在 stop 上一致；ok=false 表示打回/拒绝） */
  accepted: boolean;
  /** 建议下一步帧：打回指向本帧（重做），终态指向 null，通过指向就绪池候选 */
  next: FrameId | null;
  /**
   * 打回反馈**或终态注记**：通过路径也可能带（如隔离 worktree 回收失败保留现场的路径，
   * 走 `plan/frame-completed.notice` 同一份文本；不静默）。
   */
  feedback?: string;
}

/** 只读查询面快照（TUI /task 面板接线；纯读取，无副作用） */
export interface TaskEngineSnapshot {
  /** 嵌套任务清单（标题/状态，先序） */
  tasks: NestedTaskItem[];
  /** 当前帧栈（DFS 就绪池；数组末位 = 下一待处理帧） */
  frameStack: FrameId[];
  /** 在途（active）帧数 */
  activeCount: number;
  /** 是否已完成（根帧 done） */
  isComplete: boolean;
}
