/**
 * 会话观测面：只**读**宿主会话日志（不写、不新增事件词汇），为三件事供料：
 *
 * 1. 会话 cwd 与请求头（`request/header.header.config` → LLM 审查段的路由与 `ENVIRONMENT` 段）；
 * 2. `callId → 参数` 的反查（`tool/call` 事件；参数表被清空 / 恢复会话时的兜底）；
 * 3. 过滤后的历史（`FILTERED_HISTORY` 段：只取人工指令与工具调用事实，排除 assistant 正文、
 *    reasoning 与工具结果原文 —— 见验收 13）。
 */

import type { ReviewHistoryItem, ReviewInstructionItem } from "./review.ts";

/** 会话日志事件（结构化子集）。 */
export interface SessionEventLike {
  seq?: number;
  type: string;
  data?: unknown;
}

/** 会话对象（结构化子集）。 */
export interface SessionLike {
  id?: string;
  header?: { cwd?: string; parentSession?: string };
  events?: readonly SessionEventLike[];
}

/** 会话快照（按会话 id 累积）。 */
interface SessionSnapshot {
  cwd?: string;
  provider?: string;
  model?: string;
  /** 最近看到的工具调用（`callId → {name, arguments}`），有界。 */
  calls: Map<string, { name: string; arguments: string }>;
}

/** 工具调用数上限（每会话）。 */
const CALL_HISTORY_LIMIT = 200;
/** 历史条目上限（送进审查的条数）。 */
const REVIEW_HISTORY_LIMIT = 24;
/** 单条历史文本上限（字符）。 */
const REVIEW_ITEM_MAX_CHARS = 1200;

/** 会话观测器：事件驱动的小状态机（无 I/O）。 */
export class SessionObserver {
  readonly #sessions = new Map<string, SessionSnapshot>();

  /** 吸收一条会话事件。 */
  observe(sessionId: string, event: SessionEventLike): void {
    const snapshot = this.#snapshot(sessionId);
    if (event.type === "request/header") {
      const header = asRecord(event.data)?.["header"];
      const config = asRecord(header)?.["config"];
      const provider = asRecord(config)?.["provider"];
      const model = asRecord(config)?.["model"];
      if (typeof provider === "string") snapshot.provider = provider;
      if (typeof model === "string") snapshot.model = model;
      return;
    }
    if (event.type === "tool/call") {
      const data = asRecord(event.data);
      const callId = data?.["callId"];
      const name = data?.["name"];
      const args = data?.["arguments"];
      if (typeof callId !== "string" || typeof name !== "string") return;
      snapshot.calls.set(callId, {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      });
      while (snapshot.calls.size > CALL_HISTORY_LIMIT) {
        const oldest = snapshot.calls.keys().next();
        if (oldest.done === true) break;
        snapshot.calls.delete(oldest.value);
      }
    }
  }

  /** 记一次会话的 cwd（来自 `exec.agent.session.header.cwd` 或配置）。 */
  setCwd(sessionId: string, cwd: string | undefined): void {
    if (cwd === undefined || cwd.length === 0) return;
    this.#snapshot(sessionId).cwd = cwd;
  }

  /** 会话 cwd（未观测到 → undefined）。 */
  cwdOf(sessionId: string): string | undefined {
    return this.#sessions.get(sessionId)?.cwd;
  }

  /** 会话最近一次请求的模型路由。 */
  routeOf(sessionId: string): { provider: string; model: string } | undefined {
    const snapshot = this.#sessions.get(sessionId);
    if (snapshot?.provider === undefined || snapshot.model === undefined) {
      return undefined;
    }
    return { provider: snapshot.provider, model: snapshot.model };
  }

  /** 按 `callId` 反查工具调用（本进程观测到的）。 */
  callOf(
    sessionId: string,
    callId: string,
  ): { name: string; arguments: string } | undefined {
    return this.#sessions.get(sessionId)?.calls.get(callId);
  }

  /** 过滤后的历史（人工指令 + 工具调用事实）。 */
  historyOf(session: SessionLike | undefined): ReviewHistoryItem[] {
    if (session?.events === undefined) return [];
    const items: ReviewHistoryItem[] = [];
    for (const event of session.events) {
      if (event.type === "user/message") {
        const data = asRecord(event.data);
        const role = data?.["role"];
        const source = asRecord(data)?.["source"];
        const kind = asRecord(source)?.["kind"];
        // 只收真正来自人类（`source.kind: "user"`）与目标续作轮（`goal`）的消息；
        // 注入类（skill / 通知 / 模型切换等）不是指令，排除
        if (role !== "user") continue;
        if (kind !== "user" && kind !== "goal") continue;
        const text = textOfContent(data?.["content"]);
        if (text.length === 0) continue;
        items.push({
          role: kind === "goal" ? "checkpoint" : "human-instruction",
          kind: "user-message",
          text: clip(text),
        });
        continue;
      }
      if (event.type === "tool/call") {
        const data = asRecord(event.data);
        const name = data?.["name"];
        const args = data?.["arguments"];
        if (typeof name !== "string") continue;
        items.push({
          role: "fact",
          kind: "tool-call",
          text: clip(
            `${name}(${typeof args === "string" ? args : JSON.stringify(args ?? {})})`,
          ),
        });
      }
    }
    return items.slice(-REVIEW_HISTORY_LIMIT);
  }

  /** 清空（dispose 用）。 */
  clear(): void {
    this.#sessions.clear();
  }

  #snapshot(sessionId: string): SessionSnapshot {
    let snapshot = this.#sessions.get(sessionId);
    if (snapshot === undefined) {
      snapshot = { calls: new Map() };
      this.#sessions.set(sessionId, snapshot);
    }
    return snapshot;
  }
}

/** 项目规则（`<cwd>/AGENTS.md`）—— 由调用方读盘后传入，本模块不做 I/O。 */
export function projectInstructionsFrom(
  readFile: (path: string) => string | undefined,
  cwd: string,
): ReviewInstructionItem[] {
  const sources = [`${cwd}/AGENTS.md`];
  const out: ReviewInstructionItem[] = [];
  for (const source of sources) {
    const text = readFile(source);
    if (text === undefined || text.trim() === "") continue;
    out.push({ source, text: clip(text, 4000) });
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.["type"] === "text" && typeof record["text"] === "string") {
      parts.push(record["text"]);
    }
  }
  return parts.join("\n");
}

function clip(text: string, max = REVIEW_ITEM_MAX_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}
