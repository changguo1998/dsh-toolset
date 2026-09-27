// src/app/adapter/tool-bootstrap.ts — 锚定工具引导（anchored tool bootstrap）
//
// 完整移植自 dsh-anchored-standard/preset/tool-bootstrap.mjs（v2）：
// 任务感知的两阶段工具锁定-释放，作用于 TUI 持有的真实 agent：
//   1. 按会话首个真实 user message 分类 spec/react/weak（关键字证据），决定
//      persona 与首请求工具目录（bash+read，spec 加 edit / react 加 write；
//      glob/grep 永不进入，参考仓库测量的 V4 Pro 轨迹边界）。
//   2. 首请求 system-prompt/assemble：persona 为唯一 section、contexts 清空、
//      工具目录过滤到 core 集合——最干净的认知开局。
//   3. 会话记录首个 durable tool/call 后，后续请求恢复全量工具目录与完整
//      prompt sections，persona 恒定。
//
// 门控：全部 deepseek-* 模型（含 flash）应用本逻辑；非 deepseek 模型与配置开关
// 关闭时，system-prompt/assemble 原样透传（零改动）。
//
// 取舍（BACKLOG TUI#11，2026-09-27 放宽）：原设计前提是「V4 Pro 的能力上限由
// 首个 API 请求所见内容决定」，故门控曾限定 v4-pro；现放宽到全部 deepseek-*，
// flash 在 weak 模式取 PERSONA_WEAK_FLASH。其余各代/变体的实际表现待真机复核
// （单测只覆盖门控判定与人设分支）。
//
// 健壮性（与参考一致，fail-open）：promotion/mode 均按 session 记忆（进程内
// Set + durable 记录派生，resume-safe）。durable 记录的读取顺序见下方
// 「durable 记录读取」节：宿主提供 `session.events` 时以其为准；rc.2 宿主无
// 公开 events 属性，改经消息投影 `session.deriveMessages()` 判定；两者都
// 不可读时 fail-open 降级全量目录，绝不把会话锁死（BACKLOG TUI#13）。首个
// 文本在 agent/inbox/inserted 捕获（先于首组装事件），agent/pre-step 兜底；
// 缺失 shell、过滤异常同样降级全量目录，绝不阻塞步骤管线。
//
// 零运行时依赖，仅用 DshRuntime 结构面（ctx.on），与 installSessionModelSelection
// 挂钩同一条 system-prompt/assemble waterfall，顺序无关可共存。

import type { DshRuntime } from "./types.ts";

/** 进程内已提升的 session id（append-only） */
export type ToolBootstrapOptions = {
  /** 总开关（默认 true）。false 时任何模型都原样透传 */
  enabled?: boolean;
  /** 模型门控（默认 isDeepseekModel）：返回 false 时原样透传 */
  isTarget?: (modelId: string) => boolean;
};

/* ── 任务分类器（port from dsh-anchored-standard，零依赖） ───────────────── */

const REACT_RE =
  /(开发|创建|写一个|写个|生成|从零|做一个|做个|搞一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|添加|新增|build|create|develop|generate|implement|make a|new project)/gi;
const SPEC_RE =
  /(修复|修一下|修改|改一下|调整|完善|润色|排版|措辞|替换|删除|删掉|移除|去掉|清理|整理|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容|edit|modify|tweak|adjust|update|polish|rename|delete|remove|cleanup)/gi;

function countHits(regex: RegExp, text: string): number {
  return [...String(text ?? "").matchAll(regex)].length;
}

export type TaskAnchor = "spec" | "react" | "weak";

/** 分类任务文本：明确关键字证据取 spec/react；未匹配或歧义归 weak（模型自决） */
export function classifyTask(text: string): TaskAnchor {
  const react = countHits(REACT_RE, text);
  const spec = countHits(SPEC_RE, text);
  if (react > spec) return "react";
  if (spec > react) return "spec";
  return "weak";
}

/** 解包 durable user/message 事件的文本（防御性形状） */
export function extractText(data: unknown): string {
  if (!data) return "";
  const payload =
    data && typeof data === "object" && "message" in data
      ? (data as { message?: unknown }).message
      : data;
  const content = Array.isArray(
    (payload as { content?: unknown } | null)?.content,
  )
    ? ((payload as { content: unknown[] }).content ?? [])
    : [];
  return content
    .map((c) =>
      typeof c === "string"
        ? c
        : ((c && typeof c === "object" && "text" in c
            ? (c as { text?: unknown }).text
            : "") ?? ""),
    )
    .join(" ");
}

/** 从 durable 记录推导会话模式（resume-safe）：宿主 events 优先；rc.2 无
 *  events 时经消息投影读首个真实用户消息；两者皆不可读回落 weak。 */
export function sessionMode(
  session:
    | {
        events?: readonly Record<string, unknown>[];
        deriveMessages?: () => readonly BootstrapMessage[];
      }
    | undefined,
): TaskAnchor {
  if (!session) return "weak";
  if (!Array.isArray(session.events)) {
    const messages = sessionMessages(session);
    return messages === undefined ? "weak" : sessionModeFromMessages(messages);
  }
  const userMsg = session.events.find((e) => e && e.type === "user/message");
  return classifyTask(extractText(userMsg && userMsg.data));
}

/* ── personas（逐字对齐 dsh-anchored-standard） ──────────────────────────── */

const PERSONA_SPEC = "You are a helpful software engineer assistant.";

const PERSONA_REACT =
  "You are a hands-on software engineer who delivers working output fast.\n" +
  "Work directly: write or edit code, then verify it by reading and running. " +
  "Keep the loop tight — produce, verify, fix — and do not build test " +
  "harnesses, scaffolding, or ceremony the user did not ask for. " +
  "Finish with a usable deliverable and a short summary.";

/** Pro 最优（router-standard P11/P24）：规范句 + classify 指令，不注入锚 */
const PERSONA_WEAK_PRO =
  "You are a helpful software engineer assistant.\n" +
  "Before acting, decide the task type (build or fix) and adopt the matching " +
  "style: build → hands-on production; fix → inspect-and-plan.";

/** Flash 最优（P11/P23）：中性 + classify + 锚（门控外模型不应用，保留实现） */
const PERSONA_WEAK_FLASH =
  "You are a helpful assistant.\n" +
  "Before acting, decide the task type (build or fix) and adopt the matching " +
  "style: build → hands-on production; fix → inspect-and-plan.\n" +
  "Before acting, briefly review what you have already done in this session " +
  "and continue from where you left off; do not repeat completed steps. " +
  "Do not run environment checks (echo, whoami, uname, node --version, date) " +
  "or exhaustive grep/glob scans.";

function isFlashModel(modelId: string): boolean {
  return /flash/i.test(modelId);
}

/** 某模式的 persona；weak 按模型选内部路由文案 */
export function personaFor(mode: TaskAnchor, modelId: string): string {
  if (mode === "react") return PERSONA_REACT;
  if (mode === "spec") return PERSONA_SPEC;
  return isFlashModel(modelId) ? PERSONA_WEAK_FLASH : PERSONA_WEAK_PRO;
}

/* ── 首请求核心工具目录（shell 动态加入） ────────────────────────────────── */

/** bootstrap 目录按模式；glob/grep 有意缺席（参考轨迹边界）；edit/write 锚安全 */
export function coreFor(mode: TaskAnchor, shell: string): string[] {
  const common = [shell, "read"];
  if (mode === "spec") return [...common, "edit"];
  if (mode === "react") return [...common, "write"];
  return common;
}

/* ── 模型门控：全部 deepseek-* 模型 ───────────────────────────────────────── */

/** 目标模型判定：模型 id 含 `deepseek` 即生效（含 `provider/` 前缀形态，
 *  如 `provider/deepseek-*`）——各代与变体一并适用（BACKLOG TUI#11；
 *  此前仅 `/deepseek-v4.*pro/i`）。 */
export function isDeepseekModel(modelId: string): boolean {
  return /deepseek/i.test(modelId);
}

/* ── prompt-section 辅助 ──────────────────────────────────────────────────── */

/** 仅替换 persona section，保留其他（plan-mode 等，promoted 后回归） */
export function applyPersona<T extends { name?: string; text?: string }>(
  sections: T[] | undefined,
  personaText: string,
): T[] {
  const rest = (sections ?? []).filter(
    (s) => !s || (s.name !== "persona" && !/persona/i.test(s.name ?? "")),
  );
  return [
    { name: "anchored-persona", text: personaText, order: 0 },
    ...rest,
  ] as T[];
}

/* ── 插件 install：system-prompt/assemble 过滤器 ──────────────────────────── */

/** 供测试：组装会话相关结构面（agent.options.model / session / events / tool/call） */
export type BootstrapSession = {
  id: string;
  events?: readonly Record<string, unknown>[];
  /** 宿主消息投影（rc.2 公开 API `session.deriveMessages()` 的结构面；无 events 时的主判据） */
  deriveMessages?: () => readonly BootstrapMessage[];
};

/** 消息投影中的消息（仅声明判定所需字段；宿主可附加其它字段） */
export type BootstrapMessage = {
  role?: string;
  source?: { kind?: string };
  /** 内容块（读取用结构面；`Array.isArray` 收窄在 readonly 数组上会退化，故不标 readonly） */
  content?: (Record<string, unknown> | string)[];
  [key: string]: unknown;
};

/** 从 durable 事件推导是否已提升（宿主提供 events 数组时的判据；`undefined`
 *  视为未命中——「不可读」须由调用方另行 fail-open，勿以本函数代判）。 */
export function isPromotedFromEvents(
  events: readonly Record<string, unknown>[] | undefined,
): boolean {
  if (!Array.isArray(events)) return false;
  return events.some((e) => e && e.type === "tool/call");
}

/* ── durable 记录读取（rc.2 宿主无公开 `session.events`） ─────────────────── */

/** 读会话消息投影快照；API 缺失 / 抛错 / 非数组返回 undefined（= 不可读，
 *  调用方按 fail-open 处理）。来源为宿主公开 `session.deriveMessages()`
 *  （rc.2：增量缓存、返回冻结快照，可安全反复调用）。 */
export function sessionMessages(
  session: { deriveMessages?: () => readonly BootstrapMessage[] } | undefined,
): readonly BootstrapMessage[] | undefined {
  try {
    const derive = session?.deriveMessages;
    if (typeof derive !== "function") return undefined;
    const messages = derive.call(session);
    return Array.isArray(messages) ? messages : undefined;
  } catch {
    return undefined;
  }
}

/** 消息投影里是否已出现首个工具调用（解锁判据：assistant 消息含
 *  `tool-call` 内容块即视为已跨过首次工具使用门槛）。 */
export function hasToolCallInMessages(
  messages: readonly BootstrapMessage[] | undefined,
): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => {
    if (!m || !Array.isArray(m.content)) return false;
    return m.content.some(
      (block: Record<string, unknown> | string) =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool-call",
    );
  });
}

/** 从消息投影推导会话模式：取首个真实用户消息
 *  （`source.kind === "user"`，跳过 agent-instructions / skill-catalog 等注入）。 */
export function sessionModeFromMessages(
  messages: readonly BootstrapMessage[] | undefined,
): TaskAnchor {
  if (!Array.isArray(messages)) return "weak";
  const userMsg = messages.find(
    (m) => m && m.role === "user" && m.source?.kind === "user",
  );
  return classifyTask(extractText(userMsg));
}

/**
 * 挂接 agentCtx 的 system-prompt/assemble：对全部 deepseek-* 模型（默认门控）在
 * 首请求锁定工具目录 + persona-only，首次 durable tool/call 后恢复全量。
 * 返回解绑函数（与 installSessionModelSelection 同构）；setup 内 void 丢弃。
 */
export function installToolBootstrap(
  ctx: DshRuntime,
  options?: ToolBootstrapOptions,
): () => void {
  const enabled = options?.enabled ?? true;
  const isTarget = options?.isTarget ?? isDeepseekModel;
  /** 进程内已提升的会话集合（append-only；跨组装记忆，resume 由 events 派生兜底） */
  const promoted = new Set<string>();
  /** 进程内已解析模式（append-only） */
  const modes = new Map<string, TaskAnchor>();
  /** 首个真实 user 消息文本（agent/inbox/inserted 优先捕获，早于首组装事件） */
  const firstTexts = new Map<string, string>();
  let warned = false;
  // cordis 严格模式：logger 不在 DshRuntime 结构面，窄化访问（不可用则静默）
  const logger = (ctx as { logger?: unknown }).logger as
    { warn?: (msg: string) => void } | undefined;
  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    try {
      logger?.warn?.(message);
    } catch {
      // logger 不可用时仅护盾防刷屏
    }
  };

  interface MessageLike {
    role?: string;
    content?: unknown[];
    source?: { kind?: string };
  }
  const messageText = (message: MessageLike | undefined): string => {
    if (!message) return "";
    const content = Array.isArray(message.content) ? message.content : [];
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : ((c && typeof c === "object" && "text" in c
              ? (c as { text?: unknown }).text
              : "") ?? ""),
      )
      .join(" ");
  };

  const unbinds: Array<(() => void) | void> = [];

  // 捕获会话首个真实 user 消息（消息进入 inbox 时，严格早于任何 prompt 组装）
  unbinds.push(
    ctx.on("agent/inbox/inserted", (payload: unknown) => {
      try {
        const p = payload as {
          agent?: { session?: BootstrapSession };
          message?: MessageLike;
        };
        const session = p?.agent?.session;
        if (!session || firstTexts.has(session.id)) return;
        const msg = p?.message;
        if (!msg || !msg.source || msg.source.kind !== "user") return;
        const text = messageText(msg);
        if (text.trim()) firstTexts.set(session.id, text);
      } catch {
        void 0; // 仅观察
      }
    }),
  );

  // 兜底捕获点：见过 inbox/inserted 的会话不走这里
  unbinds.push(
    ctx.on("agent/pre-step", async (payload: unknown, next: unknown) => {
      const decision = await (next as () => unknown)();
      try {
        const p = payload as {
          agent?: { session?: BootstrapSession };
          messages?: MessageLike[];
        };
        const session = p?.agent?.session;
        if (!session || firstTexts.has(session.id)) return decision;
        const messages = Array.isArray(p.messages) ? p.messages : [];
        const first = messages.find(
          (m) => m && m.source && m.source.kind === "user",
        );
        if (first === undefined) return decision; // system reminder 不参与分类
        const text = messageText(first);
        if (text.trim()) firstTexts.set(session.id, text);
      } catch {
        void 0; // 仅观察，绝不干扰步骤管线
      }
      return decision;
    }),
  );

  const resolveMode = (session: BootstrapSession | undefined): TaskAnchor => {
    if (!session) return "weak";
    if (modes.has(session.id)) return modes.get(session.id)!;
    const cached = firstTexts.get(session.id);
    const mode =
      cached !== undefined && cached.trim() !== ""
        ? classifyTask(cached)
        : sessionMode(session);
    modes.set(session.id, mode);
    return mode;
  };

  const isPromoted = (session: BootstrapSession | undefined): boolean => {
    if (!session) return true;
    if (promoted.has(session.id)) return true;
    // 宿主提供 durable 事件数组时以其为准（参照实现的宿主形态）
    if (Array.isArray(session.events)) {
      if (isPromotedFromEvents(session.events)) {
        promoted.add(session.id);
        return true;
      }
      return false;
    }
    // rc.2 宿主无公开 events：经消息投影判定
    const messages = sessionMessages(session);
    if (messages === undefined) {
      // 不可读：fail-open 降级全量目录，绝不把会话锁死在引导目录（与参照实现一致）
      return true;
    }
    if (hasToolCallInMessages(messages)) {
      promoted.add(session.id);
      return true;
    }
    return false;
  };

  unbinds.push(
    ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
      // 下游错误原样传播；仅本过滤器自身逻辑受保护
      const assembled = await (next as () => unknown)();
      try {
        const ctxAgent = (context as { agent?: unknown } | undefined)?.agent as
          | { session?: BootstrapSession; options?: { model?: string } }
          | undefined;
        const session = ctxAgent?.session;
        if (session === undefined) return assembled;
        if (!enabled) return assembled;
        const modelId = ctxAgent?.options?.model ?? "";
        if (!isTarget(modelId)) return assembled;

        const mode = resolveMode(session);
        const persona = personaFor(mode, modelId);

        if (isPromoted(session)) {
          // 已解锁：全量工具；persona 恒定；contexts 清空；其余 sections 回归
          return {
            ...(assembled as object),
            sections: applyPersona(
              (
                assembled as {
                  sections?: Array<{ name?: string; text?: string }>;
                }
              ).sections,
              persona,
            ),
            contexts: [],
          } as unknown;
        }

        const tools = Array.isArray((assembled as { tools?: unknown[] }).tools)
          ? ((assembled as { tools?: unknown[] }).tools ?? [])
          : [];
        const available = new Set(
          tools
            .map((tool) => tool && (tool as { name?: string }).name)
            .filter((n): n is string => typeof n === "string" && n !== ""),
        );
        const shell = available.has("bash")
          ? "bash"
          : available.has("pwsh")
            ? "pwsh"
            : undefined;
        if (shell === undefined) {
          warnOnce(
            "tool-bootstrap: no platform shell in the catalog — full catalog exposed",
          );
          return assembled;
        }
        const core = new Set(coreFor(mode, shell));

        // 首请求：persona 为唯一 section + contexts 清空 + 任务匹配的引导目录
        return {
          ...(assembled as object),
          sections: [{ name: "anchored-persona", text: persona, order: 0 }],
          contexts: [],
          tools: tools.filter(
            (tool) => tool && core.has((tool as { name?: string }).name ?? ""),
          ),
        } as unknown;
      } catch (error) {
        // 过滤器 bug 绝不毁掉会话：降级全量目录
        warnOnce(
          "tool-bootstrap: bootstrap filter failed, exposing the full catalog: " +
            String((error && (error as Error).message) || error),
        );
        return assembled;
      }
    }),
  );

  return () => {
    for (const u of unbinds) if (typeof u === "function") u();
  };
}
