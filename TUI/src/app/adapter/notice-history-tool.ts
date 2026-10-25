// app/adapter/notice-history-tool.ts — 模型侧工具 `notice_history`（读宿主 notice 历史原文）
//
// 数据源见 notice-history.ts：宿主把 `source.form:'notice'` 消息全量落会话持久日志
// （`session.v4.jsonl.zstd`，拼接多帧 zstd），本工具按需解压读取——compaction 保留尾段
// 之外被折叠的 notice 原文即可由此取回。
//
// 工具在 TUI 插件里**全局**注册（main.ts 的 ctx.get("tools").register）：调用方会话由
// `exec.agent.session` 给出（与 tui_local_log / context-report 同口径），也可显式传
// session_id。参数契齐齐平 `tui_local_log`：limit 缺省 20 / 上限 200；kind 过滤取
// `source.kind`（生产者类别，条目判别字段 `source.form` 恒为 'notice'，本身无过滤
// 区分度）；session_id 缺省当前会话。

import {
  NOTICE_DEFAULT_LIMIT,
  NOTICE_MAX_LIMIT,
  readNoticeHistory,
  type NoticeEntry,
  type NoticeReadOptions,
} from "./notice-history.ts";

/** 工具入参（结构面宽松：非法值在 execute 内归一化，不抛错） */
interface ToolArgs {
  kind?: unknown;
  limit?: unknown;
  session_id?: unknown;
}

/** 调用方会话结构面（宿主 ToolRunContext 的 agent.session 子集） */
interface CallerSessionLike {
  readonly id?: string;
}

/** 工具执行结果（结构化 + 供 render 的预渲染文本） */
export interface NoticeHistoryResult {
  ok: boolean;
  sessionId?: string;
  /** 生产者类别过滤（未过滤时为 undefined / "all"） */
  kind: string | undefined;
  /** 实际返回条数 */
  count: number;
  /** 预渲染文本（模型直接读这段） */
  text: string;
  /** 错误原因（ok=false 时） */
  error?: string;
  /** 跳过帧 / 坏行计数（诊断用） */
  skipped?: { frames: number; lines: number };
}

/** 归一化 limit：缺省 NOTICE_DEFAULT_LIMIT；非法回落缺省；超上限钳到 NOTICE_MAX_LIMIT */
function normalizeLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) {
    return NOTICE_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(v), NOTICE_MAX_LIMIT);
}

/** epoch ms → `HH:mm:ss`（只做展示；时区跟随本机） */
function clock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 单条 → 文本块：时刻 + 类别 + 摘要 + 原文 */
function entryText(entry: NoticeEntry, index: number): string {
  const head = `[${clock(entry.ts)}] kind=${entry.kind} (${entry.id})`;
  const summary =
    entry.summary !== undefined && entry.summary !== ""
      ? `\n摘要: ${entry.summary}`
      : "";
  return `#${index} ${head}${summary}\n${entry.content}`;
}

/** 条目数组 → 一段可读文本（空 → 明确说明无记录） */
export function renderNoticeHistory(
  sessionId: string,
  entries: readonly NoticeEntry[],
  kind: string | undefined,
  note: string | undefined,
): string {
  if (entries.length === 0) {
    const reason = note !== undefined ? `（${note}）` : "";
    return `会话 ${sessionId}: 无 ${kind === undefined || kind === "" ? "" : kind + " "}notice 记录${reason}`;
  }
  const lines = [
    `会话 ${sessionId}: 最近 ${entries.length} 条 notice 原文（kind=${kind === undefined || kind === "" ? "all" : kind}）`,
  ];
  entries.forEach((entry, i) => {
    lines.push("", entryText(entry, i + 1));
  });
  if (note !== undefined) lines.push("", `提示: ${note}`);
  return lines.join("\n");
}

/** 构造工具定义（宿主 tools registry 可注册对象） */
export function createNoticeHistoryTool(): unknown {
  return {
    name: "notice_history",
    description:
      "用途: 读 notice 历史原文, 即已被 compaction 折叠出上下文、会话日志里仍在的一次性事件交代。\n" +
      "用法: kind=生产者类别(source.kind, 如 tool-jobs / subagent-settled / model-selection; 缺省不过滤); limit 缺省 20(上限 200); session_id 缺省当前调用方会话。\n" +
      "效果: 取回这些事件的最近 N 条, 含 subagent 收尾 / 后台任务 / 模型切换(source.form:'notice')。\n" +
      "边界: 只读; TUI 命令提示与 $ 模式命令输出在 tui_local_log。\n" +
      "相关: tui_local_log。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          description:
            "只按生产者类别看某类（source.kind 精确匹配；如 tool-jobs / subagent-settled / model-selection / plan-mode / webhook / repeat-tool-reminder / tool-goal；缺省不过滤）",
        },
        limit: {
          type: "number",
          description: `返回最近 N 条（缺省 ${NOTICE_DEFAULT_LIMIT}，上限 ${NOTICE_MAX_LIMIT}）`,
        },
        session_id: {
          type: "string",
          description: "目标会话 id（缺省：当前调用方会话）",
        },
      },
    },
    execute(args: unknown, exec: unknown): NoticeHistoryResult {
      const input = (args ?? {}) as ToolArgs;
      const callerSession = (
        exec as { agent?: { session?: CallerSessionLike } } | undefined
      )?.agent?.session;
      const sessionId =
        typeof input.session_id === "string" && input.session_id !== ""
          ? input.session_id
          : callerSession?.id;
      const kind =
        typeof input.kind === "string" && input.kind !== ""
          ? input.kind
          : undefined;
      const limit = normalizeLimit(input.limit);
      if (sessionId === undefined || sessionId === "") {
        return {
          ok: false,
          kind,
          count: 0,
          error: "无法定位会话：请显式传 session_id（当前会话未知）",
          text: "无法定位会话：请显式传 session_id（当前会话未知）",
        };
      }
      const opts: NoticeReadOptions = {
        ...(kind === undefined ? {} : { kind }),
        limit,
      };
      const result = readNoticeHistory(sessionId, opts);
      return {
        ok: result.ok,
        sessionId,
        kind,
        count: result.count,
        ...(result.ok ? {} : { error: result.error }),
        ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
        text: renderNoticeHistory(
          sessionId,
          result.entries,
          kind,
          result.ok ? result.error : undefined,
        ),
      };
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown): unknown[] => [
        {
          type: "text",
          text:
            value !== null &&
            typeof value === "object" &&
            typeof (value as { text?: unknown }).text === "string"
              ? String((value as { text: string }).text)
              : JSON.stringify(value),
        },
      ],
    },
  };
}
