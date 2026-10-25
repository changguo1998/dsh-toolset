// app/adapter/local-log-tool.ts — 模型侧工具 `tui_local_log`（读 TUI 本地输出旁路日志）
//
// 数据源见 local-log.ts：TUI 里「只给用户看」的输出（`$` 模式的命令与结果、App 自造
// 命令提示）按会话落 `<会话目录>/tui-local.jsonl`，本工具按需读最近 N 条。
//
// 工具在 TUI 插件里**全局**注册（main.ts 的 ctx.get("tools").register）：调用方会话由
// `exec.agent.session` 给出（与 context-report 同口径），也可显式传 session_id。

import {
  LOCAL_LOG_DEFAULT_LIMIT,
  LOCAL_LOG_MAX_LIMIT,
  readLocalLog,
  type LocalLogEntry,
  type LocalLogKind,
  type LocalLogReadOptions,
} from "./local-log.ts";

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
export interface TuiLocalLogResult {
  ok: boolean;
  sessionId?: string;
  kind: LocalLogKind | "all";
  /** 实际返回条数 */
  count: number;
  /** 预渲染文本（模型直接读这段） */
  text: string;
  /** 错误原因（ok=false 时） */
  error?: string;
}

/** 归一化 kind：缺省 all；非法值回落 all */
function normalizeKind(v: unknown): LocalLogKind | "all" {
  return v === "shell" || v === "notice" ? v : "all";
}

/** 归一化 limit：缺省 20；非数字/非正 → 缺省；超上限钳到 200 */
function normalizeLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) {
    return LOCAL_LOG_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(v), LOCAL_LOG_MAX_LIMIT);
}

/** epoch ms → `HH:mm:ss`（只做展示；时区跟随本机） */
function clock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 单条 → 文本块：时间 + 类别 + 正文（shell 另附关键 meta） */
function entryText(entry: LocalLogEntry): string {
  const head = `[${clock(entry.ts)}] ${entry.kind}`;
  const meta = entry.meta;
  const suffix: string[] = [];
  if (meta !== undefined) {
    const command = meta["command"];
    if (typeof command === "string" && command !== "")
      suffix.push(`command=${command}`);
    const exitCode = meta["exitCode"];
    if (typeof exitCode === "number") suffix.push(`exit=${exitCode}`);
    const ms = meta["ms"];
    if (typeof ms === "number") suffix.push(`${Math.round(ms)}ms`);
    if (meta["timedOut"] === true) suffix.push("timedOut");
  }
  const tail = suffix.length === 0 ? "" : ` (${suffix.join(", ")})`;
  return `${head}${tail}\n${entry.text}`;
}

/** 条目数组 → 一段可读文本（空 → 明确说明无记录） */
export function renderLocalLog(
  sessionId: string,
  entries: readonly LocalLogEntry[],
  kind: LocalLogKind | "all",
): string {
  if (entries.length === 0) {
    return `会话 ${sessionId}: 无 ${kind === "all" ? "" : kind + " "}本地输出记录（TUI 尚未产生，或 localLog 已关闭）`;
  }
  const lines = [
    `会话 ${sessionId}: 最近 ${entries.length} 条本地输出（kind=${kind}）`,
  ];
  entries.forEach((entry, i) => {
    lines.push("", `#${i + 1} ${entryText(entry)}`);
  });
  return lines.join("\n");
}

/** 构造工具定义（宿主 tools registry 可注册对象） */
export function createTuiLocalLogTool(): unknown {
  return {
    name: "tui_local_log",
    description:
      "用途: 读 TUI 本地输出旁路日志, 含 $ 模式执行的命令与结果(含退出码)、TUI 命令的提示行(notice)。\n" +
      "用法: kind=shell / notice / all(缺省); limit 缺省 20(上限 200); session_id 缺省当前会话。\n" +
      "效果: 按需取最近 N 条, 这些内容默认不进模型上下文。\n" +
      "边界: 一次性事件交代(subagent 收尾 / 后台任务 / 模型切换)在 notice_history。\n" +
      "相关: notice_history。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: ["shell", "notice", "all"],
          description:
            "shell=`$` 模式命令与结果；notice=TUI 命令提示；all（缺省）",
        },
        limit: {
          type: "number",
          description: `返回最近 N 条（缺省 ${LOCAL_LOG_DEFAULT_LIMIT}，上限 ${LOCAL_LOG_MAX_LIMIT}）`,
        },
        session_id: {
          type: "string",
          description: "目标会话 id（缺省：当前调用方会话）",
        },
      },
    },
    execute(args: unknown, exec: unknown): TuiLocalLogResult {
      const input = (args ?? {}) as ToolArgs;
      const callerSession = (
        exec as { agent?: { session?: CallerSessionLike } } | undefined
      )?.agent?.session;
      const sessionId =
        typeof input.session_id === "string" && input.session_id !== ""
          ? input.session_id
          : callerSession?.id;
      const kind = normalizeKind(input.kind);
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
      const opts: LocalLogReadOptions = { kind, limit };
      const entries = readLocalLog(sessionId, opts);
      return {
        ok: true,
        sessionId,
        kind,
        count: entries.length,
        text: renderLocalLog(sessionId, entries, kind),
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
