/**
 * session-title-cutoff — 接管 `ctx.sessionTitle` 的唯一标题 provider（BACKLOG #56）。
 *
 * 行为：触发策略保持 `all-prompts`（每条真实用户消息触发一次自动标题，手动 `/rename` 的
 * pin 语义不变），但参考窗口改为「最近一次会话内提交动作（`git commit`）之后的人类消息」。
 * 窗口 = `messages.filter(m => m.seq > cutoffSeq)`；无提交记录 / 过滤后为空 / 事件不可读
 * → 回退全量（保证标题仍可生成）。
 *
 * 宿主依赖姿态（零依赖）：本包不声明 `@deepseek-ai/*` 依赖，运行时经
 * `createRequire($DSH_HOME/profiles/node_modules/x.js)` 解析并动态 `import()` 官方 LLM helper
 * （宿主官方兜底解析路径，解析到与宿主同版的副本）；解析失败 → 告警且不注册 provider。
 *
 * 契约与工期记录见 `docs/implementation/2026-09-29-title-cutoff-provider.md`。
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const name = "session-title-cutoff";

/** 硬依赖：标题服务 + LLM 服务（generateSessionTitleWithLlm 需要两者）。 */
export const inject = ["sessionTitle", "llm"];

/** 插件配置（缺省值见 `DEFAULT_CONFIG`；`provider`/`model` 须成对，缺省 = 复用会话已记录路由）。 */
export interface Config {
  /** 非 CJK 标题目标词数（缺省 5）。 */
  targetWords?: number;
  /** CJK 标题目标字数（缺省 15）。 */
  targetCjkCharacters?: number;
  /** 入模提示体积上限（UTF-8 字节，缺省 32768）。 */
  maxInputBytes?: number;
  /** 标题生成输出 token 上限（缺省 512）。 */
  maxOutputTokens?: number;
  /** 标题请求超时 ms（缺省 60000）。 */
  timeoutMs?: number;
  /** 显式路由（与 model 成对；**建议配置**：all-prompts 首条消息时可能尚无已记录路由）。 */
  provider?: string;
  /** 显式模型 id（与 provider 成对）。 */
  model?: string;
}

/** 配置缺省（与官方 all-prompts 在本仓 profile 的口径一致）。 */
export const DEFAULT_CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 15,
  maxInputBytes: 32768,
  maxOutputTokens: 512,
  timeoutMs: 60000,
} as const;

/** 记账容量（每会话一条 cutoff，FIFO 淘汰，避免长跑进程无限增长）。 */
export const CUTOFF_CAPACITY = 256;

/**
 * 提交动作判定：把命令按 `;` / `&&` / `||` / `|` / 换行切段后，**某段以 `git commit` 开头**
 * 才算提交（放行 `sudo` 与 `git -C <目录>` 前缀）。
 * 只按「文本里出现 git commit」判定会误判：核对脚本、命令里提到文档正文等都会被算成提交
 * （2026-09-29 真机日志实证：核查脚本把 cutoff 顶高）。
 */
export const COMMIT_SEGMENT_RE =
  /^\s*(?:sudo\s+)?git(?:\s+-C\s+\S+)?\s+commit\b/;

/** 命令是否包含一次提交调用（按命令段落判定）。 */
export function isCommitCommand(command: string): boolean {
  return command
    .split(/\r?\n|;|&&|\|\||\|/)
    .some((segment) => COMMIT_SEGMENT_RE.test(segment));
}

/** 从工具参数 JSON 里取命令文本（解析失败 / 无命令字段 → undefined）。 */
export function commandOf(argumentsJson: unknown): string | undefined {
  if (typeof argumentsJson !== "string" || argumentsJson === "")
    return undefined;
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    for (const key of ["command", "cmd"]) {
      const value = parsed[key];
      if (typeof value === "string" && value !== "") return value;
    }
    return undefined;
  } catch {
    // 参数不是合法 JSON：退化为原文匹配（命令里出现 git commit 的可能性仍在）
    return argumentsJson;
  }
}

/** 是否「会话内提交」类工具调用（只看命令文本，不绑定具体工具名）。 */
export function isCommitCall(argumentsJson: unknown): boolean {
  const command = commandOf(argumentsJson);
  return command !== undefined && isCommitCommand(command);
}

/** 取窗口内消息：`seq > cutoff`；无 cutoff 或过滤后为空 → 全量（回退）。 */
export function selectSinceCommit<T extends { seq: number }>(
  messages: readonly T[],
  cutoff: number | undefined,
): readonly T[] {
  if (cutoff === undefined) return messages;
  const selected = messages.filter((message) => message.seq > cutoff);
  return selected.length === 0 ? messages : selected;
}

/** 每会话「最近一次提交」记账（FIFO 上限，容量内不淘汰）。 */
export class CommitCutoffTracker {
  readonly #cutoffs = new Map<string, number>();
  readonly #capacity: number;

  constructor(capacity = CUTOFF_CAPACITY) {
    this.#capacity = capacity;
  }

  /** 记一条提交（seq 单调推进；同会话重复记账只保留最新）。 */
  note(sessionId: string, seq: number): void {
    if (sessionId === "" || !Number.isFinite(seq)) return;
    this.#cutoffs.delete(sessionId);
    this.#cutoffs.set(sessionId, seq);
    while (this.#cutoffs.size > this.#capacity) {
      const oldest = this.#cutoffs.keys().next().value;
      if (oldest === undefined) break;
      this.#cutoffs.delete(oldest);
    }
  }

  /** 该会话的 cutoff（无记录 → undefined）。 */
  cutoffOf(sessionId: string): number | undefined {
    return this.#cutoffs.get(sessionId);
  }

  /** 当前记账的会话数（测试与诊断用）。 */
  size(): number {
    return this.#cutoffs.size;
  }
}

/** 宿主 ctx 的结构面（只声明用到的成员，不引宿主类型依赖）。 */
interface SessionTitleLlmHelper {
  SessionTitleLlmConfigFields?: unknown;
  resolveSessionTitleLlmConfig(config: Record<string, unknown>): unknown;
  generateSessionTitleWithLlm(
    ctx: unknown,
    config: unknown,
    request: unknown,
    selectedMessages: readonly unknown[],
    titleProvider: unknown,
  ): Promise<{
    title: string;
    messageSeqs: readonly unknown[];
    model?: unknown;
  }>;
}

interface SessionTitleProviderLike {
  id: string;
  automatic: "first-prompt" | "all-prompts";
  generate(request: unknown): Promise<unknown>;
}

interface SessionTitleServiceLike {
  register(provider: SessionTitleProviderLike): unknown;
}

interface PluginContext {
  sessionTitle?: SessionTitleServiceLike;
  llm?: unknown;
  on?: (
    event: string,
    listener: (session: { id?: unknown }, event: unknown) => void,
  ) => unknown;
}

/** profiles 兜底解析根（宿主官方兜底：`$DSH_HOME/profiles/node_modules`）。 */
function fallbackRequire(): NodeJS.Require {
  const dshHome = process.env["DSH_HOME"] ?? join(homedir(), ".dsh");
  return createRequire(join(dshHome, "profiles", "node_modules", "x.js"));
}

/** 运行时加载宿主同版官方 helper（解析失败 → undefined，调用方告警并降级）。 */
export async function loadTitleLlmHelper(): Promise<
  SessionTitleLlmHelper | undefined
> {
  try {
    const entry = fallbackRequire().resolve(
      "@deepseek-ai/dsh-session-title-llm",
    );
    const mod = (await import(
      pathToFileURL(entry).href
    )) as Partial<SessionTitleLlmHelper>;
    if (
      typeof mod.resolveSessionTitleLlmConfig !== "function" ||
      typeof mod.generateSessionTitleWithLlm !== "function"
    ) {
      return undefined;
    }
    return mod as SessionTitleLlmHelper;
  } catch {
    return undefined;
  }
}

/** 合并配置缺省（只保留 helper 白名单字段：多传会被 resolveSessionTitleLlmConfig 拒绝）。 */
export function resolveConfig(config: Config = {}): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const key of [
    "targetWords",
    "targetCjkCharacters",
    "maxInputBytes",
    "maxOutputTokens",
    "timeoutMs",
    "provider",
    "model",
  ] as const) {
    const value = config[key];
    if (value !== undefined && value !== "") merged[key] = value;
  }
  return merged;
}

/** 读会话事件（结构面；不可读 → 空数组）。用于重启后重建 cutoff。 */
async function readSessionEvents(
  ctx: unknown,
  sessionId: string,
): Promise<readonly { seq?: unknown; type?: unknown; data?: unknown }[]> {
  try {
    const query = (
      ctx as {
        get?: (name: string) => unknown;
      }
    )?.get?.("sessionQuery") as
      | { readSession?: (id: string) => Promise<{ events?: unknown }> }
      | undefined;
    const snapshot = await query?.readSession?.(sessionId);
    const events = snapshot?.events;
    return Array.isArray(events)
      ? (events as readonly { seq?: unknown; type?: unknown; data?: unknown }[])
      : [];
  } catch {
    return [];
  }
}

/** 从事件里取最近一次提交的 seq（无 → undefined）。 */
export function latestCommitSeq(
  events: readonly { seq?: unknown; type?: unknown; data?: unknown }[],
): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    if (event.type !== "tool/call") continue;
    const data = event.data as { arguments?: unknown } | undefined;
    if (!isCommitCall(data?.arguments)) continue;
    const seq = Number(event.seq);
    if (Number.isFinite(seq) && (latest === undefined || seq > latest)) {
      latest = seq;
    }
  }
  return latest;
}

/** apply 的可替换依赖（测试注入用；缺省走运行时加载）。 */
export interface ApplyDeps {
  loadHelper?: () => Promise<SessionTitleLlmHelper | undefined>;
}

/**
 * dsh 宿主按 bundle 契约调用：注册唯一标题 provider（异步：需先加载宿主 helper）。
 * 失败只告警不抛（加载失败时官方 provider 若已禁用 → 标题回落宿主确定性 fallback）。
 */
export async function apply(
  ctx: unknown,
  config: Config = {},
  deps: ApplyDeps = {},
): Promise<void> {
  const warn = (message: string): void => {
    process.stderr.write(`[session-title-cutoff] warn: ${message}\n`);
  };
  const c = (ctx ?? {}) as PluginContext;
  const service = c.sessionTitle;
  if (service === undefined || typeof service.register !== "function") {
    warn("ctx.sessionTitle 不可用，标题窗口裁剪不会生效");
    return;
  }
  const helper = await (deps.loadHelper ?? loadTitleLlmHelper)();
  if (helper === undefined) {
    warn(
      "未能加载宿主 @deepseek-ai/dsh-session-title-llm（约定路径 $DSH_HOME/profiles/node_modules）；不注册 provider",
    );
    return;
  }
  let resolved: unknown;
  try {
    resolved = helper.resolveSessionTitleLlmConfig(resolveConfig(config));
  } catch (err) {
    warn(`标题 provider 配置非法：${String(err)}`);
    return;
  }

  const tracker = new CommitCutoffTracker();
  // 实时记账：会话事件里的提交类工具调用（seq 取自事件信封）
  c.on?.("session/event", (session, event) => {
    const e = event as { type?: unknown; seq?: unknown; data?: unknown };
    if (e.type !== "tool/call") return;
    if (
      !isCommitCall((e.data as { arguments?: unknown } | undefined)?.arguments)
    )
      return;
    const sessionId = typeof session?.id === "string" ? session.id : "";
    tracker.note(sessionId, Number(e.seq));
  });

  try {
    service.register({
      id: name,
      automatic: "all-prompts",
      generate: async (request: unknown) => {
        const r = request as {
          session?: { id?: unknown };
          messages?: readonly { seq: number }[];
        };
        const sessionId = typeof r.session?.id === "string" ? r.session.id : "";
        const messages = r.messages ?? [];
        let cutoff = tracker.cutoffOf(sessionId);
        if (cutoff === undefined && sessionId !== "") {
          // 重启后缓存为空：按会话事件重建一次（失败即回退全量）
          cutoff = latestCommitSeq(await readSessionEvents(ctx, sessionId));
          if (cutoff !== undefined) tracker.note(sessionId, cutoff);
        }
        const selected = selectSinceCommit(messages, cutoff);
        return await helper.generateSessionTitleWithLlm(
          ctx,
          resolved,
          request,
          selected,
          name,
        );
      },
    });
  } catch (err) {
    warn(`标题 provider 注册失败（可能已有 provider）：${String(err)}`);
  }
}
