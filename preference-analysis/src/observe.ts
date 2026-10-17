/**
 * 观测：订阅会话事件，抽出三条结构化信号（设计 D2）——S1 重复约束 / S2 纠正加权 /
 * S3 审批拒绝。只产证据（`Observation`），不碰账簿、不写库、不看注入面。
 *
 * 取舍（设计 R4）：不可得的「用户对模型输出的修改」用「打断 + 纠正性重述 + 审批拒绝」代理；
 * 工具选择分布、快捷键 / 命令、提交信息风格不纳入首期。
 */
import {
  CORRECTION_WEIGHT,
  DEFAULT_CORRECTION_MARKERS,
  DEFAULT_MARKERS,
  MAX_CONSTRAINT_CHARS,
  extractConstraint,
  hasCorrectionMarker,
  normalizeKey,
  type EvidenceInput,
} from "./induce.ts";

/** 观测产物：一条待并账的证据，或一次「未成形观察」（只计数）。 */
export type Observation =
  | { kind: "evidence"; evidence: EvidenceInput }
  | { kind: "unformed"; sessionId: string; at: number };

/** 观测计数（排查用；不进账簿）。 */
export interface ObserveStats {
  /** 产出的约束证据数。 */
  constraints: number;
  /** 纠正语境里没有约束句、只计入未成形观察的次数。 */
  unformed: number;
  /** 审批拒绝产出的证据数。 */
  approvals: number;
  /** 被忽略的审批（非 rejected / 配对失败）。 */
  ignoredApprovals: number;
}

/** 观测器选项。 */
export interface ObserverOptions {
  markers?: readonly string[];
  correctionMarkers?: readonly string[];
  maxConstraintChars?: number;
  now?: () => number;
}

/** 会话内状态（回合号与「上一回合被打断」标记）。 */
interface SessionState {
  turn: number;
  interrupted: boolean;
}

/** 审批配对表上限：异常会话（大量审批）也不无限增长。 */
const MAX_PENDING_PAIRS = 500;

/** 观测器：`handle` 是纯同步的事件翻译，调用方负责节流与落账。 */
export class Observer {
  readonly #markers: readonly string[];
  readonly #correctionMarkers: readonly string[];
  readonly #maxConstraintChars: number;
  readonly #now: () => number;
  readonly #sessions = new Map<string, SessionState>();
  /** approval id -> 被审工具（`approval/decided` 只带 id 与 outcome，必须与 `asked` 配对）。 */
  readonly #asked = new Map<string, { toolName: string; callId?: string }>();
  /** callId -> 参数首段（`tool/call` 先到，审批后可查）。 */
  readonly #calls = new Map<string, string>();
  readonly #stats: ObserveStats = {
    constraints: 0,
    unformed: 0,
    approvals: 0,
    ignoredApprovals: 0,
  };

  constructor(options: ObserverOptions = {}) {
    this.#markers = options.markers ?? DEFAULT_MARKERS;
    this.#correctionMarkers =
      options.correctionMarkers ?? DEFAULT_CORRECTION_MARKERS;
    this.#maxConstraintChars =
      options.maxConstraintChars ?? MAX_CONSTRAINT_CHARS;
    this.#now = options.now ?? Date.now;
  }

  /** 计数快照。 */
  get stats(): ObserveStats {
    return { ...this.#stats };
  }

  /** 处理一条会话事件，返回本次产出的观测。 */
  handle(sessionId: string, project: string, event: unknown): Observation[] {
    if (sessionId.length === 0 || !isRecord(event)) return [];
    const type = event["type"];
    if (typeof type !== "string") return [];
    const data = isRecord(event["data"]) ? event["data"] : {};
    const at = timeOf(event, this.#now());
    const state = this.#session(sessionId);
    switch (type) {
      case "turn/start": {
        state.turn = numberOr(data["turn"], state.turn + 1);
        return [];
      }
      case "turn/end": {
        const reason = reasonOf(data["reason"]);
        if (reason === "aborted" || reason === "interrupted") {
          state.interrupted = true;
        }
        return [];
      }
      case "user/message":
        return this.#userMessage(sessionId, project, state, data, at);
      case "tool/call": {
        const callId = stringOf(data["callId"]);
        const name = stringOf(data["name"]);
        if (callId !== undefined && name !== undefined) {
          const head = paramHead(data["arguments"]);
          if (head !== undefined) this.#remember(this.#calls, callId, head);
        }
        return [];
      }
      case "approval/asked": {
        const id = stringOf(data["id"]);
        const toolName = stringOf(data["toolName"]);
        if (id === undefined || toolName === undefined) return [];
        const callId = stringOf(data["callId"]);
        this.#remember(this.#asked, id, {
          toolName,
          ...(callId === undefined ? {} : { callId }),
        });
        return [];
      }
      case "approval/decided": {
        return this.#decided(sessionId, project, data, at);
      }
      default:
        return [];
    }
  }

  /** S1 / S2：约束句与纠正加权。 */
  #userMessage(
    sessionId: string,
    project: string,
    state: SessionState,
    data: Record<string, unknown>,
    at: number,
  ): Observation[] {
    const message = data["message"];
    // 排除 rule-engine 自身注入（与 rule-engine 的 SOURCE_KIND 同值）
    if (sourceKind(message) === "rule-engine") return [];
    const text = messageText(message);
    if (text.trim().length === 0) return [];
    const corrected =
      state.interrupted || hasCorrectionMarker(text, this.#correctionMarkers);
    state.interrupted = false;
    const constraint = extractConstraint(
      text,
      this.#markers,
      this.#maxConstraintChars,
    );
    if (constraint === null) {
      if (!corrected) return [];
      this.#stats.unformed += 1;
      return [{ kind: "unformed", sessionId, at }];
    }
    this.#stats.constraints += 1;
    const weight = corrected ? CORRECTION_WEIGHT : 1;
    return [
      {
        kind: "evidence",
        evidence: {
          text: constraint,
          weight,
          sessionId,
          at,
          origin: "user",
          project,
        },
      },
    ];
  }

  /** S3：审批拒绝 -> 指纹为 `tool:参数首段` 的约束证据。 */
  #decided(
    sessionId: string,
    project: string,
    data: Record<string, unknown>,
    at: number,
  ): Observation[] {
    const id = stringOf(data["id"]);
    if (id === undefined) return [];
    const asked = this.#asked.get(id);
    this.#asked.delete(id);
    if (data["outcome"] !== "rejected" || asked === undefined) {
      this.#stats.ignoredApprovals += 1;
      return [];
    }
    const head =
      asked.callId === undefined ? undefined : this.#calls.get(asked.callId);
    if (asked.callId !== undefined) this.#calls.delete(asked.callId);
    if (head === undefined) {
      // 归因不明（缺 callId / 缺 tool/call 参数）不造弱偏好
      this.#stats.ignoredApprovals += 1;
      return [];
    }
    this.#stats.approvals += 1;
    return [
      {
        kind: "evidence",
        evidence: {
          text: approvalText(asked.toolName, head),
          key: normalizeKey(`${asked.toolName}:${head}`),
          weight: 1,
          sessionId,
          at,
          origin: "approval",
          project,
        },
      },
    ];
  }

  #session(sessionId: string): SessionState {
    let state = this.#sessions.get(sessionId);
    if (state === undefined) {
      state = { turn: 0, interrupted: false };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  /** 有上限的插入：超限时丢最早者（Map 保插入序）。 */
  #remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_PENDING_PAIRS) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
  }
}

/** 审批拒绝的偏好文案（机械生成；用户可在审阅里改写或撤销）。 */
export function approvalText(toolName: string, head: string): string {
  return `不要直接 ${toolName} ${head}; 如确需执行, 先说明影响并取得确认`;
}

/** 抽取消息正文：内容块中 `type === "text"` 的文本按序拼接（畸形输入给空串）。 */
export function messageText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message["content"];
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    }
  }
  return parts.join("");
}

/** 消息来源 kind（`user/message.source.kind`）。 */
export function sourceKind(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const source = message["source"];
  if (!isRecord(source)) return undefined;
  return stringOf(source["kind"]);
}

/**
 * 参数首段：命令类取首个子命令，路径类取 basename，URL 取主机名。
 * `arguments` 可能是 JSON 串（宿主的事件形态）或已解析对象（测试 / 其它通道）。
 */
export function paramHead(args: unknown): string | undefined {
  const value = parseArguments(args);
  if (value === undefined) return undefined;
  if (typeof value === "string") return commandHead(value);
  if (!isRecord(value)) return undefined;
  for (const key of ["command", "cmd", "script"]) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return commandHead(raw);
    }
  }
  for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return pathHead(raw);
    }
  }
  const url = value["url"];
  if (typeof url === "string" && url.trim().length > 0) return urlHead(url);
  for (const raw of Object.values(value)) {
    if (typeof raw === "string" && raw.trim().length > 0) {
      return commandHead(raw);
    }
  }
  return undefined;
}

/** 命令首段：跳过环境变量赋值与 `sudo` / `env`，再取第一个词（路径取 basename）。 */
export function commandHead(command: string): string | undefined {
  const tokens = command
    .replace(/["']/g, " ")
    .split(/[\s|;&<>()]+/u)
    .filter((token) => token.length > 0);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      index += 1;
      continue;
    }
    if (token === "sudo" || token === "env" || token === "command") {
      index += 1;
      continue;
    }
    return clip(pathHead(token));
  }
  return undefined;
}

/** 路径首段：basename（去引号、限长）。 */
export function pathHead(path: string): string | undefined {
  const trimmed = path.trim().replace(/^["']|["']$/g, "");
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split(/[\\/]+/u).filter((part) => part.length > 0);
  const last = parts[parts.length - 1];
  return clip(last ?? trimmed);
}

/** URL 首段：主机名（解析失败按原串截断）。 */
function urlHead(url: string): string | undefined {
  try {
    return clip(new URL(url).hostname);
  } catch {
    return clip(url);
  }
}

function parseArguments(args: unknown): unknown {
  if (typeof args !== "string") return args;
  const text = args.trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function clip(value: string | undefined, max = 40): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value.length <= max ? value : value.slice(0, max);
}

/** `turn/end.reason` 两种形态：字符串，或 `{ type }` / `{ reason }` 对象。 */
function reasonOf(value: unknown): string | undefined {
  const direct = stringOf(value);
  if (direct !== undefined) return direct;
  if (!isRecord(value)) return undefined;
  return stringOf(value["type"]) ?? stringOf(value["reason"]);
}

function timeOf(event: Record<string, unknown>, fallback: number): number {
  const value = event["time"];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
