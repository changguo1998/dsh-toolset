// TUI/src/app/adapter/session-records.ts — 历史会话列举 / 续接目标 / 删除

import { isUserMessage } from "../state.ts";
import type { HistoryMessage, SessionInfo, SessionQueryLike } from "./types.ts";
import { localTitleFromText } from "./normalize.ts";
import { rmSync } from "node:fs";
import { locateSessionDir, sessionRoots } from "./session-paths.ts";

// ---------------------------------------------------------------------------
// 历史会话清理（文件级）：安全语义对齐官方 dsh-tui 的 compat/sessionLog
// ---------------------------------------------------------------------------

/** surface 探针：一次读取同时给出标题兜底、是否有用户消息、是否可读 */
interface SessionSurfaceProbe {
  title: string | undefined;
  hasPrompt: boolean;
  readable: boolean;
}

/** 有界并发助手（会话列表读取用，避免 180+ 会话顺序读拖慢面板） */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  };
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/** 官方标题：批量折叠 session/title 事件（readTitleSnapshots 优先；缺失逐条 readTitle） */
async function officialTitles(
  sessionQuery: SessionQueryLike | undefined,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!sessionQuery) return map;
  try {
    if (typeof sessionQuery.readTitleSnapshots === "function") {
      const snaps = await sessionQuery.readTitleSnapshots([...ids]);
      for (const snap of snaps) {
        // 官方 settlement 形态：仅消费 fulfilled 的 value.title；rejected 隔离到单会话
        if (
          snap.status === "fulfilled" &&
          snap.value?.title?.title &&
          snap.sessionId
        ) {
          map.set(snap.sessionId, snap.value.title.title);
        }
      }
    } else if (typeof sessionQuery.readTitle === "function") {
      await mapLimit([...ids], 8, async (id) => {
        try {
          const t = await sessionQuery.readTitle!(id);
          if (t?.title) map.set(id, t.title);
        } catch {
          /* 单个会话标题读取失败不阻断 */
        }
      });
    }
  } catch {
    /* 标题服务不可用 → 全走本地兜底 */
  }
  return map;
}

/** 编辑时间（TUI#1）：会话日志末条事件 `time`（listEvents 轻量面）。
 *  无事件 / 读取失败 / 服务缺失 → undefined（调用方回退 `createdAt`）。 */
async function lastEventTime(
  sessionQuery: SessionQueryLike,
  id: string,
): Promise<number | undefined> {
  if (typeof sessionQuery.listEvents !== "function") return undefined;
  try {
    const events = await sessionQuery.listEvents(id);
    let last: number | undefined;
    for (const e of events) {
      const t = (e as { time?: unknown }).time;
      if (typeof t === "number" && Number.isFinite(t)) last = t;
    }
    return last;
  } catch {
    return undefined;
  }
}

/**
 * 历史会话记录（TUI#1）：宿主 `listSessions` 归一化 + **编辑时间**（listEvents 末条
 * 事件 time，缺失回退 createdAt）+ 标题 / 空会话探针；按编辑时间**从晚到早**排序
 * （并列 createdAt 降序、id 兜底）。
 *
 * 单一来源：`adapter.listSessions`（面板）与 `main.ts` 的 `-c` / `--continue` 启动
 * 解析共用；`readMessages` 缺省时跳过标题兜底与 isEmpty 判定（CLI 路径省 surface 读取）。
 */
export async function listSessionRecords(deps: {
  sessionQuery: SessionQueryLike;
  /** 读取某会话的归一化消息（标题兜底 + isEmpty 判定用；缺省跳过该探针） */
  readMessages?: (id: string) => Promise<HistoryMessage[]>;
  activeSessionId?: string;
}): Promise<SessionInfo[]> {
  const { sessionQuery, readMessages, activeSessionId } = deps;
  const rs = await sessionQuery.listSessions();
  const ids = rs.map((r) => r.header.id);
  const official = await officialTitles(sessionQuery, ids);
  // 编辑时间：listEvents 末条事件 time（轻量面；读取失败/缺失回退 createdAt）
  const times = await mapLimit(ids, 8, async (id) => {
    return [id, await lastEventTime(sessionQuery, id)] as const;
  });
  const updatedById = new Map<string, number>();
  for (const [id, t] of times) if (t !== undefined) updatedById.set(id, t);
  // 无官方标题的会话：本地兜底标题 + 空会话判定；
  // 读取失败 → readable:false（不臆断为空，清理时跳过）
  // 探针：无官方标题的会话（标题兜底 + 空会话判定）；另**当前活跃会话**必探（TUI#23：
  // hasPrompt 供 /continue 区分「用过的当前会话」与「刚起的新会话」）
  const probeIds =
    readMessages === undefined
      ? []
      : ids.filter((id) => !official.has(id) || id === activeSessionId);
  const probes = await mapLimit(probeIds, 8, async (id) => {
    try {
      const messages = await readMessages!(id);
      const first = messages.find((m) => isUserMessage(m.role));
      return [
        id,
        {
          title: localTitleFromText(first?.text),
          hasPrompt: first !== undefined,
          readable: true,
        },
      ] as [string, SessionSurfaceProbe];
    } catch {
      return [id, { title: undefined, hasPrompt: true, readable: false }] as [
        string,
        SessionSurfaceProbe,
      ];
    }
  });
  const probeById = new Map(probes);
  const records: SessionInfo[] = rs.map((r) => {
    const probe = probeById.get(r.header.id);
    const title = official.get(r.header.id) ?? probe?.title;
    // 空会话：持久化 + 非 live + surface 确认无用户消息
    // （有官方标题即视为有对话；读取面缺失 → 不判空）
    const isEmpty =
      r.persisted &&
      !r.live &&
      probe !== undefined &&
      probe.readable &&
      !probe.hasPrompt;
    return {
      id: r.header.id,
      createdAt: r.header.createdAt,
      updatedAt: updatedById.get(r.header.id) ?? r.header.createdAt,
      cwd: r.header.cwd,
      live: r.live,
      persisted: r.persisted,
      // 当前活跃判定以 adapter 视角为准（活跃会话在内存 store 中必为 live）
      ...(r.live && r.header.id === activeSessionId ? { current: true } : {}),
      ...(isEmpty ? { isEmpty: true } : {}),
      ...(probe === undefined ? {} : { hasPrompt: probe.hasPrompt }),
      ...(title === undefined ? {} : { title }),
    };
  });
  // TUI#1：面板/选择一律按「编辑时间」从晚到早（并列 createdAt 降序、id 兜底）
  records.sort(byUpdatedDesc);
  return records;
}

/** 记录排序比较器（TUI#1）：编辑时间降序、并列创建时间降序、id 兜底 */
function byUpdatedDesc(a: SessionInfo, b: SessionInfo): number {
  return (
    (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt) ||
    b.createdAt - a.createdAt ||
    a.id.localeCompare(b.id)
  );
}

/**
 * 「最近退出」会话选择（TUI#1 / #2 共用）：当前目录（cwd 精确匹配，与 `/session`
 * project 范围同口径）+ 已持久化 + 非 live（当前活跃必为 live，天然排除），
 * 取编辑时间（`updatedAt`，缺省 `createdAt`）最大的一条；无匹配 → undefined。
 */
export function pickRecentSession(
  records: readonly SessionInfo[],
  cwd: string | undefined,
): SessionInfo | undefined {
  if (cwd === undefined) return undefined;
  const candidates = records.filter(
    (r) => r.cwd === cwd && r.persisted === true && !r.live,
  );
  if (candidates.length === 0) return undefined;
  return [...candidates].sort(byUpdatedDesc)[0];
}

/** `/continue` 目标（TUI#23，用户裁定「最新会话」语义） */
export type ContinueTarget =
  { kind: "current" } | { kind: "session"; record: SessionInfo };

/**
 * `/continue` 目标选择（TUI#23）：候选 = 同目录已持久化且非 live 的会话 ∪ **当前会话**
 * （仅当它已有用户消息——刚起的新会话不算，仍可回退到最近退出的会话）。取编辑时间
 * 最大者；若它就是当前会话 → `{ kind: "current" }`（调用方提示「已是最新」、不切换）；
 * 无候选 → undefined。CLI `-c` 仍用 `pickRecentSession`（启动时无当前会话）。
 */
export function pickContinueTarget(
  records: readonly SessionInfo[],
  cwd: string | undefined,
): ContinueTarget | undefined {
  if (cwd === undefined) return undefined;
  const current = records.find((r) => r.current === true);
  const candidates = records.filter(
    (r) =>
      r.cwd === cwd &&
      ((r.persisted === true && !r.live) ||
        (current !== undefined &&
          r.id === current.id &&
          current.hasPrompt !== false)),
  );
  if (candidates.length === 0) return undefined;
  const top = [...candidates].sort(byUpdatedDesc)[0]!;
  return current !== undefined && top.id === current.id
    ? { kind: "current" }
    : { kind: "session", record: top };
}

/** 会话目录删除结果：ok=true 时 path 为实际删除的目录（realpath 解析后） */
export type SessionDeleteOutcome =
  { ok: true; path: string } | { ok: false; reason: string };

/**
 * 文件级删除一个持久化会话目录。
 * 安全线由 `locateSessionDir` 承担（单段 id 校验 → 各根下按 <project-slug>/<id>
 * 定位 → realpath 包含性校验，slug 或会话目录为指向根外的符号链接则跳过）；
 * 本函数只负责找到后 rmSync(recursive)。未找到 → 返回失败且无副作用。
 */
export function deleteSessionDir(
  id: string,
  roots: readonly string[] = sessionRoots(),
): SessionDeleteOutcome {
  const found = locateSessionDir(id, roots);
  if (!found.ok) {
    return {
      ok: false,
      reason:
        found.reason === "会话 id 非法"
          ? "会话 id 非法，拒绝删除"
          : "未找到该会话的持久化文件（可能仅存在于内存或已删除）",
    };
  }
  try {
    rmSync(found.path, { recursive: true, force: true });
    return { ok: true, path: found.path };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/** 展示用设置值：对象/数组 → 单行 JSON；超长值截断（notice 每行再按面板宽截断） */
export function formatSettingValue(v: unknown): string {
  if (v === undefined || v === null) return "∅";
  if (typeof v === "string") {
    const s = v.replace(/\s+/g, " ").trim();
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  }
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** SessionForkErrorCode（dsh-session lib/types/index.d.ts:296-305）→ 中文提示，不抛穿宿主错误对象 */
export function forkErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case "SESSION_NOT_FOUND":
      return "源会话不存在";
    case "SESSION_NOT_LIVE":
      return "源会话不可用";
    case "SESSION_ALREADY_EXISTS":
      return "目标会话已存在";
    case "INVALID_BOUNDARY":
      return "分叉边界无效";
    case "OPEN_TURN":
      return "上一回合未闭合，无法分叉";
    default:
      return err instanceof Error && err.message !== ""
        ? err.message
        : "未知错误";
  }
}
