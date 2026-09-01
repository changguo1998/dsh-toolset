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
// 门控：仅 deepseek-v4-pro 模型应用本逻辑；其他模型（flash、非 deepseek）
// 与配置开关关闭时，system-prompt/assemble 原样透传（零改动）。
//
// 健壮性（与参考一致，fail-open）：promotion/mode 均按 session 记忆（进程内
// Set + session.events 派生，resume-safe）；首个文本在 agent/inbox/inserted
// 捕获（先于首组装事件），agent/pre-step 兜底；缺失 shell、过滤异常一律降级
// 全量目录，绝不阻塞步骤管线。
//
// 零运行时依赖，仅用 DshRuntime 结构面（ctx.on），与 installSessionModelSelection
// 挂钩同一条 system-prompt/assemble waterfall，顺序无关可共存。

import type { DshRuntime } from "./types.ts";

/** 进程内已提升的 session id（append-only） */
export type ToolBootstrapOptions = {
  /** 总开关（默认 true）。false 时任何模型都原样透传 */
  enabled?: boolean;
  /** 模型门控（默认 isV4ProModel）：返回 false 时原样透传 */
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

/** 从 durable 事件推导会话模式（resume-safe） */
export function sessionMode(
  session: { events?: readonly Record<string, unknown>[] } | undefined,
): TaskAnchor {
  if (!session || !Array.isArray(session.events)) return "weak";
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

/* ── 模型门控：仅 deepseek-v4-pro ─────────────────────────────────────────── */

/** 目标模型判定：deepseek-v4 系列中的 pro 变体（含 provider/model 前缀形态） */
export function isV4ProModel(modelId: string): boolean {
  return /deepseek-v4.*pro/i.test(modelId);
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
};

/** 供测试/内部使用：从 durable 事件推导是否已提升（首 tool/call 后永久解锁） */
export function isPromotedFromEvents(
  events: readonly Record<string, unknown>[] | undefined,
): boolean {
  if (!Array.isArray(events)) return false;
  return events.some((e) => e && e.type === "tool/call");
}

/**
 * 挂接 agentCtx 的 system-prompt/assemble：对 deepseek-v4-pro（默认门控）在
 * 首请求锁定工具目录 + persona-only，首次 durable tool/call 后恢复全量。
 * 返回解绑函数（与 installSessionModelSelection 同构）；setup 内 void 丢弃。
 */
export function installToolBootstrap(
  ctx: DshRuntime,
  options?: ToolBootstrapOptions,
): () => void {
  const enabled = options?.enabled ?? true;
  const isTarget = options?.isTarget ?? isV4ProModel;
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
    if (isPromotedFromEvents(session.events)) {
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
