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
 * 契约与工期记录见 `docs/archived/2026-09-29-title-cutoff-provider.md`。
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

/** 从工具参数 JSON 里取命令文本（无命令字段 → undefined；JSON 解析失败 → 原文兜底匹配）。 */
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
  /** 两个年代都要求：执行控制的校验与冻结。 */
  resolveSessionTitleLlmConfig(config: Record<string, unknown>): unknown;
  /** 0.2.1 起：execute 形态（prepared 由调用方组装，内部走 `ctx.llm.prepareCall`）。 */
  executeSessionTitleLlm?(
    ctx: unknown,
    config: unknown,
    request: unknown,
    titleProvider: unknown,
    prepared: TitlePrepared,
  ): Promise<TitleResponse>;
  /** 0.2.0 及之前：generate 形态（selectedMessages 由 helper 内部预备）。 */
  generateSessionTitleWithLlm?(
    ctx: unknown,
    config: unknown,
    request: unknown,
    selectedMessages: readonly unknown[],
    titleProvider: unknown,
  ): Promise<TitleResponse>;
}

/** execute 形态的「已预备请求」（system / input / 源消息 seq / 推理努力选择器）。 */
interface TitlePrepared {
  system: string;
  input: string;
  messageSeqs: readonly number[];
  selectReasoningEffort(model: unknown): string | undefined;
}

/** 标题模型响应（`blocks` 文本块 + 终止原因 + 路由）。 */
interface TitleResponse {
  blocks: readonly { type: string; text?: string }[];
  finish: { kind: string };
  model?: unknown;
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
    // 0.2.1 起 helper 改 `execute` 形态；0.2.0 为 `generate` 形态。
    // 两个时代各认一个可选面（升级过渡期兼容），都需 `resolveSessionTitleLlmConfig`。
    if (
      typeof mod.resolveSessionTitleLlmConfig !== "function" ||
      (typeof mod.executeSessionTitleLlm !== "function" &&
        typeof mod.generateSessionTitleWithLlm !== "function")
    ) {
      return undefined;
    }
    return mod as SessionTitleLlmHelper;
  } catch {
    return undefined;
  }
}

/** 合并配置缺省（只透传 helper 白名单字段，见下方键列表；空串视为未配置）。 */
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
 * 语言感知的标题系统提示（0.2.1 起 helper 不再内置，由调用方组装 prepared）。
 * 对齐官方 `session-title-first-prompt-llm` 0.2.1 的同款文案口径。
 */
export function titleSystemPrompt(config: {
  targetWords: number;
  targetCjkCharacters: number;
}): string {
  return [
    "Create a concise title for an AI coding-assistant session from the supplied human messages.",
    "Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.",
    "Use the language of the messages.",
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
    "If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.",
  ].join("\n");
}

/** 把选定消息帧成 JSON（用户文本不能破坏结构定界符）。 */
export function frameTitleMessages(
  messages: readonly { seq: number }[],
): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`;
}

/** 选 route 支持的最低推理努力（标题请求用最省档）。 */
export function selectReasoningEffort(model: unknown): string | undefined {
  const reasoning = (
    model as { reasoning?: { efforts?: readonly { id?: string }[] } }
  )?.reasoning;
  return reasoning?.efforts?.[0]?.id;
}

/** 清洗 + 字节截断标题（对齐官方 `normalizeSessionTitle`；终端安全单行）。 */
export function normalizeTitleText(input: string, maxBytes: number): string {
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(
      /[\u001b\u009b]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\u202a-\u202e/gu,
      "",
    )
    .replace(/\s+/gu, " ")
    .trim();
  if (Buffer.byteLength(cleaned, "utf8") <= maxBytes) return cleaned.trimEnd();
  let used = 0;
  let output = "";
  for (const character of cleaned) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

/** 取整行星号强调包裹内的内容（模型不守约时剥离）。 */
const EMPHASIS_WRAPPER_RE =
  /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u;

/** 模型输出 → 单行标题（首行、去整行星号强调、白名单记为 UTF-8 内）。 */
export function titleFromResponse(
  response: TitleResponse,
  maxTitleBytes: number,
): string {
  if (response.finish.kind === "tool-calls") {
    throw new Error("session-title-llm: title output must contain text only");
  }
  if (response.finish.kind === "max-tokens") {
    throw new Error("session-title-llm: title output reached maxOutputTokens");
  }
  const textBlocks = response.blocks.filter((block) => block.type === "text");
  if (response.blocks.some((block) => block.type === "tool-call")) {
    throw new Error("session-title-llm: title output must contain text only");
  }
  const joined = textBlocks.map((block) => block.text ?? "").join(" ");
  const line =
    joined
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? "";
  const groups = EMPHASIS_WRAPPER_RE.exec(line)?.groups;
  const marker = groups?.["marker"];
  const inner = groups?.["inner"];
  const unemphasized =
    marker === undefined || inner === undefined || inner.includes(marker)
      ? line
      : inner;
  return normalizeTitleText(unemphasized, maxTitleBytes);
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
        // 0.2.1 起 helper 为 execute 形态：prepared 由调用方组装（内部经 `ctx.llm.prepareCall`）。
        // 0.2.0 为 generate 形态：selectedMessages 交给 helper 内部预备。两个面按存在与否分支。
        if (typeof helper.executeSessionTitleLlm === "function") {
          const resolvedConfig = resolved as {
            targetWords?: number;
            targetCjkCharacters?: number;
            maxTitleBytes?: number;
          };
          const prepared: TitlePrepared = {
            system: titleSystemPrompt({
              targetWords: resolvedConfig.targetWords ?? 5,
              targetCjkCharacters: resolvedConfig.targetCjkCharacters ?? 15,
            }),
            input: frameTitleMessages(selected as { seq: number }[]),
            messageSeqs: (selected as { seq: number }[]).map(
              (message) => message.seq,
            ),
            selectReasoningEffort,
          };
          const response = await helper.executeSessionTitleLlm(
            ctx,
            resolved,
            request,
            name,
            prepared,
          );
          return {
            title: titleFromResponse(
              response,
              resolvedConfig.maxTitleBytes ?? 120,
            ),
            messageSeqs: prepared.messageSeqs,
            model: response.model,
          };
        }
        // 0.2.0 分支：execute 缺面时才走 generate（加载守卫保证至少一个存在）
        const generator = helper.generateSessionTitleWithLlm;
        if (generator === undefined) {
          throw new Error("title helper has no available generate function");
        }
        return await generator(ctx, resolved, request, selected, name); // 0.2.0 签名
      },
    });
  } catch (err) {
    warn(`标题 provider 注册失败（可能已有 provider）：${String(err)}`);
  }
}
