// src/app/state/updates.ts — 状态更新入口（缓冲追加、面板开关、光标移动）

import type {
  ApprovalItem,
  AgentStatus,
  SessionMeta,
  NoticeTone,
} from "../adapter/dsh.ts";
import { displayWidth } from "../layout/markdown.ts";
import { createSections } from "../layout/pipeline/sections.ts";
import { estimateOutputTokens, nextRunVirt } from "../layout.ts";
import type { AppState, InputStatus, SystemStatus } from "./types.ts";
import { trimBufferHead } from "./types.ts";

// src/app/state/updates.ts — 状态更新入口（缓冲追加、面板开关、光标移动）

/** 清理文本中的非打印控制字符（渲染保护）：CRLF/孤立 CR 归一为 LF，
 *  其余 C0/C1 控制字符（含 \t）剔除；返回清理后文本与被剔除字符数。
 *  ponytail: 按码点扫描，不处理组合符/零宽字符（宽度原语同样不处理）。 */
export function sanitizeText(text: string): { text: string; stripped: number } {
  // 1) 换行符归一：CRLF/孤立 CR → LF（\r 属换行语义，不计入 stripped）
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // 2) 剔除其余 C0/C1 控制字符（\n 保留；终端遇 \r 回行首抹内容、遇其他控制符
  //    会乱码或破坏帧布局，统一移除）。完整 ANSI 转义序列（CSI ESC[…、OSC ESC]…BEL/ST）
  //    是样式/光标控制，属已有功能（渲染着色、/copy 剥离），保留不剔；孤立/残缺序列剔除。
  let out = "";
  let stripped = 0;
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === "\n") {
      out += ch;
      i++;
      continue;
    }
    if (ch === "\x1b") {
      const rest = normalized.slice(i);
      const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(rest);
      if (csi) {
        out += csi[0];
        i += csi[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
      if (osc) {
        out += osc[0];
        i += osc[0].length;
        continue;
      }
      stripped++; // 孤立/残缺 ESC
      i++;
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
      stripped++;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, stripped };
}
/**
 * 用户消息判定（唯一口径）：消息的 `role`、展示投影的 `kind`、宿主 `source.kind`
 * 都取 `"user"`，适配层 / 状态层 / 渲染层一律经此判定，不再各文件自比字符串。
 */
export function isUserMessage(value: unknown): boolean {
  return value === "user";
}

/**
 * 内容类 action 的**状态事实**记写（条目 16 段 C2）：内容行不再有缓冲形态（唯一来源是节缓存
 * `state.pipeline`），这里只保留缓冲时代遗留的可观测事实——剔除计数（`strippedChars`，
 * turn-end 警告用）、流式分片的虚拟状态推进（`runVirt` / `stepEstTokens`，●/○ 闪烁与
 * P5 token 校准的来源）。
 *
 * 已随内容行退场的口径：缓冲续写/拆行、回合分隔线与 final / 用户块终态 / steer 标记的
 * 行内改写——等价物都在节模型里（`sections.ts` 的交接口径、`panes.ts` 的符号打标）。
 */
export function appendStream(
  state: AppState,
  text: string,
  kind: "assistant" | "thinking" | "user",
  /** 流式事件到达时刻（ms；assistant/thinking 时驱动虚拟速度/虚拟总 token 更新） */
  time?: number,
): AppState {
  // 渲染保护：剔除非打印控制字符（CRLF/孤立 CR 归一为 LF、其余 C0/C1 移除），
  // 剔除计数累计入 state.strippedChars，turn-end 时统一警告
  const { text: clean, stripped } = sanitizeText(text);
  // 模型流式输出（assistant/thinking）推进虚拟状态（窗口速率估计 → slew/clamp 虚拟速度 →
  // 虚拟总 token 积分，驱动 ●/○ 交替）；用户行不参与。估算 token 按 tokenCalib 校正
  // （P5：流末 usage 真值学习）；stepEstTokens 累计原始估算量供校准对比
  const streamed = !isUserMessage(kind);
  const estTokens = streamed ? estimateOutputTokens(clean) : 0;
  const virt = streamed
    ? nextRunVirt(state.runVirt, time, estTokens * state.tokenCalib)
    : undefined;
  return {
    ...state,
    strippedChars: state.strippedChars + stripped,
    ...(virt
      ? { runVirt: virt, stepEstTokens: state.stepEstTokens + estTokens }
      : {}),
  };
}

/**
 * 追加模型思考行（条目 16 段 C2：只记写状态事实；思考行本体进节缓存）。
 */
export function appendThinking(
  state: AppState,
  text: string,
  time?: number,
): AppState {
  return appendStream(state, text, "thinking", time);
}

/**
 * 追加一条命令通知(notice)：独立成行，不并入 buffer 末行(与流式 append 不同)。
 * 用于 slash 命令的提示/结果文本(绝不进入模型历史，仅 UI 展示)。
 */
export function appendNotice(
  state: AppState,
  text: string,
  error = false,
  tone?: NoticeTone,
): AppState {
  // 多行 notice 拆成多行 buffer，否则 wrapLine 把 \n 当普通字符(宽1)会让列宽对不齐，
  // 字词在中间被截断(例如 /quit 在 i 与 t 之间换行)。
  const buffer = state.local.length ? [...state.local] : [];
  for (const line of sanitizeText(text).text.split("\n"))
    buffer.push({
      text: line,
      kind: "notice",
      ...(tone ? { tone } : {}),
    });
  trimBufferHead(buffer);
  // 失败标记(error notice，如未知 slash 命令 fail-close)→ 输入栏失败色(红)；
  // agent 仍活跃时保持黄（活跃守卫），绿/红仅空闲时暴露
  return {
    ...state,
    local: buffer,
    inputStatus: error ? statusFor(state, "failure") : state.inputStatus,
  };
}

/** 一条可挂载悬垂缩进的 notice 行（/help 双列表格：折行续行停靠到描述列） */
export interface NoticeLine {
  text: string;
  hanging?: number;
  /** 紧凑模式（/collapse off）豁免：仍完整折行显示（如 /help 双列表格），不被压成 1 行 */
  noCompact?: boolean;
}

/**
 * 追加多条命令通知（带可选悬垂缩进）：每条独立成行（不并入 buffer 末行）。
 * /help 双列表格用它让续行停靠到描述列起点；普通 notice 仍走 appendNotice。
 */
export function appendNoticeLines(
  state: AppState,
  lines: readonly NoticeLine[],
  tone?: NoticeTone,
): AppState {
  const buffer = state.local.length ? [...state.local] : [];
  for (const l of lines) {
    for (const line of sanitizeText(l.text).text.split("\n"))
      buffer.push({
        text: line,
        kind: "notice",
        ...(tone ? { tone } : {}),
        ...(l.hanging !== undefined ? { hanging: l.hanging } : {}),
        ...(l.noCompact === true ? { noCompact: true } : {}),
      });
  }
  trimBufferHead(buffer);
  return { ...state, local: buffer };
}

/**
 * 追加 `$` 模式本地 shell 输出行（BACKLOG TUI#37）：kind="shell"，活动区本地显示；
 * **不进模型历史**（不经 adapter 发送，模型不可见）；tone 复用 notice 语义色。
 */
export function appendShellLines(
  state: AppState,
  lines: readonly { text: string; tone?: NoticeTone }[],
): AppState {
  const buffer = state.local.length ? [...state.local] : [];
  for (const l of lines) {
    buffer.push({
      text: sanitizeText(l.text).text,
      kind: "shell",
      ...(l.tone !== undefined ? { tone: l.tone } : {}),
    });
  }
  trimBufferHead(buffer);
  return { ...state, local: buffer };
}

/**
 * 追加一条工具行（工具调用 ○ / 结果 ✓|✗）：独立成行、不进模型历史（与 notice 同）。
 * tone=error 时渲染红色（工具结果失败 ✗），其余默认色。
 */
export function appendToolLine(
  state: AppState,
  text: string,
  tone?: NoticeTone,
  params?: { keepLineBreaks?: boolean; time?: number },
): AppState {
  // 工具内容可能夹带 \r/\n/控制符（参数/结果原文）。剔除其余非打印字符、避免控制符
  // 干扰终端（宽度限制由渲染层按窗口宽度处理）；\n 默认折叠成单行（结果/辅助行），
  // 工具调用参数行保留换行（keepLineBreaks，渲染层 split + 续行 4 空格缩进）
  const clean = sanitizeText(text).text;
  const text2 = params?.keepLineBreaks ? clean : clean.replace(/\n/g, " ");
  const buffer = state.local.length ? [...state.local] : [];
  buffer.push({
    text: text2,
    kind: "tool",
    ...(tone ? { tone } : {}),
    // step 头的时间随行存一份：恢复重放据此还原 `hh:mm:ss ⇆N #M`（文本里虽有格式化时间，
    // 但那是显示态、无法反解 epoch；行元数据是权威来源）
    ...(params?.time === undefined ? {} : { time: params.time }),
  });
  trimBufferHead(buffer);
  return { ...state, local: buffer };
}

/** P8：当前活跃会话是否正在压缩上下文（压缩期间视为活跃：状态符号显示运行中、
 *  新消息走排队、Ctrl+D 退出守卫不触发）。非活跃会话的标记不影响当前视图。 */
export function isCompacting(state: AppState): boolean {
  const sid = state.activeSessionId;
  return typeof sid === "string" && state.compactingBySession[sid] === true;
}

/** 输入状态权威：审批/问答面板打开 = 等待用户决策（黄△）；agent 活跃期间
 *  不接受绿/红结果覆盖（压回运行中黄●/○），绿/红仅空闲时暴露 */
export function statusFor(state: AppState, fallback: InputStatus): InputStatus {
  if (state.approval || state.question) return "waiting";
  return state.agentStatus === "idle" ? fallback : "running";
}

/** 合并更新系统状态区（StatusTicker 每 tick 调用；缺失字段保持原值） */
export function setSystemStatus(
  state: AppState,
  status: Partial<SystemStatus>,
): AppState {
  return { ...state, systemStatus: { ...state.systemStatus, ...status } };
}

/** 清空显示缓冲(本地 /clearscreen，别名 /cls)——只清 UI，不动会话上下文。 */
export function clearBuffer(state: AppState): AppState {
  return {
    ...state,
    local: [],
    scrollOffset: 0,
    followBottom: true,
    activityScroll: 0,
    // 六步流水线的节缓存同源清空（否则 /cls 后旧内容仍会从节缓存渲染出来）
    ...(state.pipeline === undefined ? {} : { pipeline: createSections() }),
  };
}

/** 追加 agent 状态 */
export function setAgentStatus(state: AppState, status: AgentStatus): AppState {
  return { ...state, agentStatus: status };
}

/**
 * 审批面板：打开 = 等待用户决策（黄△）；关闭按 agent 活跃度恢复（运行中/上次结果）。
 * `deadline`（epoch ms）由调用方传入（reducer 不依赖时钟），供拒绝项倒计时显示（3.2.5）。
 */
export function setApproval(
  state: AppState,
  approval: ApprovalItem | null,
  deadline: number | null = null,
): AppState {
  if (!approval) {
    const next = {
      ...state,
      approval: null,
      approvalScroll: 0,
      approvalFocus: "approve" as const,
      approvalWindow: "options" as const,
      approvalDeadline: null,
      approvalHint: null,
    };
    return { ...next, inputStatus: statusFor(next, "success") };
  }
  // 新审批请求：描述窗滚动归零（3.2.1）、焦点归批准项（3.2.4）、记录超时时刻（3.2.5）
  return {
    ...state,
    approval,
    approvalScroll: 0,
    approvalFocus: "approve",
    approvalWindow: "options",
    approvalDeadline: deadline,
    approvalHint: null,
    inputStatus: "waiting",
  };
}

/** 审批选项焦点切换（←/→；3.2.4）：只在「批准 / 拒绝」两项间切换，不循环 */
export function focusApproval(
  state: AppState,
  focus: "approve" | "reject",
): AppState {
  if (!state.approval || state.approvalFocus === focus) return state;
  return { ...state, approvalFocus: focus, approvalHint: null };
}

/** Tab 切审批焦点窗（BACKLOG 3.3.4）：草稿 <-> 选项，与问答面板同为两态切换 */
export function toggleApprovalWindow(state: AppState): AppState {
  if (!state.approval) return state;
  return {
    ...state,
    approvalWindow: state.approvalWindow === "desc" ? "options" : "desc",
    approvalHint: null,
  };
}

/** 审批态无效键提示（3.3.1）：切换焦点 / 提交 / 关闭面板时由调用方传 null 清空 */
export function setApprovalHint(
  state: AppState,
  text: string | null,
): AppState {
  if (state.approvalHint === text) return state;
  return { ...state, approvalHint: text };
}

export function setSessions(
  state: AppState,
  sessions: SessionMeta[],
): AppState {
  const active =
    state.activeSessionId &&
    sessions.some((s) => s.id === state.activeSessionId)
      ? state.activeSessionId
      : (sessions[0]?.id ?? null);
  return { ...state, sessions, activeSessionId: active };
}

/** 针对 buffer 做一次只读操作（Reducer 模式入口），返回新的不改动原对象 */
/** 输入区光标所在行的起止下标（PgUp = 行首、PgDn = 行尾；无换行时即整串首尾） */
export function inputLineBounds(
  text: string,
  cursor: number,
): { start: number; end: number } {
  const c = Math.max(0, Math.min(cursor, text.length));
  const start = c === 0 ? 0 : text.lastIndexOf("\n", c - 1) + 1;
  const nl = text.indexOf("\n", c);
  return { start, end: nl < 0 ? text.length : nl };
}

/** 输入区上/下移一行（↑/↓）：尽量落在同一**显示列**（宽字符按列宽算） */
export function inputLineMove(
  text: string,
  cursor: number,
  dir: 1 | -1,
): number {
  const c = Math.max(0, Math.min(cursor, text.length));
  const { start } = inputLineBounds(text, c);
  const col = displayWidth(text.slice(start, c));
  let tStart: number;
  let tEnd: number;
  if (dir < 0) {
    if (start === 0) return c; // 首行：不动
    tEnd = start - 1; // 上一行的行尾（换行符位置）
    tStart = tEnd === 0 ? 0 : text.lastIndexOf("\n", tEnd - 1) + 1;
  } else {
    const nl = text.indexOf("\n", c);
    if (nl < 0) return c; // 末行：不动
    tStart = nl + 1;
    const nl2 = text.indexOf("\n", tStart);
    tEnd = nl2 < 0 ? text.length : nl2;
  }
  let i = tStart;
  let w = 0;
  while (i < tEnd && w < col) {
    w += displayWidth(text[i]!);
    i += 1;
  }
  return i;
}
