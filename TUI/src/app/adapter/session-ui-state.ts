// app/adapter/session-ui-state.ts — TUI 侧会话状态快照（tui-state.json）
//
// 宿主只在会话日志里记它自己掌握的状态（模型选择、plan/sandbox/permission/policy、
// goal/todo）。TUI 本地开关（活动区详略 /verbose、符号统一 /symbol-unify）与
// 「已选但尚未发起请求」的模型选择宿主并不知情，重启后无法恢复——这里把它们
// **按会话**落一份小快照到会话目录旁（`<会话目录>/tui-state.json`）：
//  - 随会话目录删除一起清理（`deleteSessionDir` 删的是整个目录）；
//  - resume 时优先用宿主日志折叠值，日志里没有的字段回落到本快照；
//  - 读写一律 best-effort：文件不存在/损坏/目录不可写都静默降级，绝不影响渲染。

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateSessionDir, sessionRoots } from "./session-paths.ts";

/** 快照文件名（会话目录内；同一目录还有宿主的 session.v3.jsonl.zstd / session.lock） */
export const SESSION_UI_STATE_FILE = "tui-state.json";

/** 快照版本（结构变更时递增；版本不匹配按「无快照」处理，不猜测旧结构） */
export const SESSION_UI_STATE_VERSION = 1;

/** 会话状态快照（全部字段可选：缺字段 = 该状态没有记录，走宿主日志/默认值） */
export interface SessionUiState {
  version: number;
  /** 会话内模型选择（模型面板/`/model` 的结果；宿主日志无 model/selection 时兜底） */
  model?: { provider: string; model: string; reasoningEffort?: string };
  /** 活动区详略（/verbose on|off；TUI 本地） */
  verbose?: boolean;
  /** 模型输出符号统一（/symbol-unify on|off；TUI 本地） */
  symbolUnify?: boolean;
  /** P7：垂直状态列是否显示（Ctrl+S 切换；TUI 本地。缺省 = 显示） */
  statusColumn?: boolean;
  /** Mode 块兜底值（宿主日志无对应事件时使用；plan/sandbox/permission + 审批策略） */
  modes?: {
    plan?: "on" | "off";
    sandbox?: string;
    permission?: string;
    policy?: "ask" | "never";
  };
}

/** 快照读写结果（写失败不抛错：调用方只做 silent 降级） */
export type SessionUiStateWriteResult =
  { ok: true; path: string } | { ok: false; reason: string };

/** 非空字符串 */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** 宽松解析快照 JSON：字段类型不符即丢弃该字段（不整体失败，也不抛错） */
function parseSessionUiState(raw: unknown): SessionUiState | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (o.version !== SESSION_UI_STATE_VERSION) return undefined;
  const out: SessionUiState = { version: SESSION_UI_STATE_VERSION };
  const m = o.model as Record<string, unknown> | undefined;
  if (m && typeof m === "object") {
    const provider = str(m.provider);
    const model = str(m.model);
    if (provider && model) {
      const effort = str(m.reasoningEffort);
      out.model = {
        provider,
        model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      };
    }
  }
  if (typeof o.verbose === "boolean") out.verbose = o.verbose;
  if (typeof o.symbolUnify === "boolean") out.symbolUnify = o.symbolUnify;
  if (typeof o.statusColumn === "boolean") out.statusColumn = o.statusColumn;
  const modes = o.modes as Record<string, unknown> | undefined;
  if (modes && typeof modes === "object") {
    const plan =
      modes.plan === "on" || modes.plan === "off" ? modes.plan : undefined;
    const sandbox = str(modes.sandbox);
    const permission = str(modes.permission);
    const policy =
      modes.policy === "ask" || modes.policy === "never"
        ? modes.policy
        : undefined;
    const kept = { plan, sandbox, permission, policy };
    if (Object.values(kept).some((v) => v !== undefined)) {
      out.modes = {
        ...(plan === undefined ? {} : { plan }),
        ...(sandbox === undefined ? {} : { sandbox }),
        ...(permission === undefined ? {} : { permission }),
        ...(policy === undefined ? {} : { policy }),
      };
    }
  }
  return out;
}

/**
 * 读会话状态快照。目录不存在、文件缺失、JSON 损坏、版本不匹配 → undefined
 * （调用方按「无快照」处理，全部字段回落宿主日志 / 默认值）。
 */
export function readSessionUiState(
  id: string,
  roots: readonly string[] = sessionRoots(),
): SessionUiState | undefined {
  const dir = locateSessionDir(id, roots);
  if (!dir.ok) return undefined;
  let text: string;
  try {
    text = readFileSync(join(dir.path, SESSION_UI_STATE_FILE), "utf8");
  } catch {
    return undefined; // 无快照（首次运行/未落盘）
  }
  try {
    return parseSessionUiState(JSON.parse(text));
  } catch {
    return undefined; // 损坏文件按无快照处理（下次落盘覆盖）
  }
}

/**
 * 写会话状态快照（**先写临时文件再 rename**，避免半截 JSON 被下次启动读到）。
 * 会话目录不存在（仅内存会话/未持久化）→ 失败返回，不创建目录也不抛错。
 */
export function writeSessionUiState(
  id: string,
  state: SessionUiState,
  roots: readonly string[] = sessionRoots(),
): SessionUiStateWriteResult {
  const dir = locateSessionDir(id, roots);
  if (!dir.ok) return { ok: false, reason: dir.reason };
  const target = join(dir.path, SESSION_UI_STATE_FILE);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameSync(tmp, target);
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
  return { ok: true, path: target };
}
