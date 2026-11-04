// TUI/src/app/adapter/dsh-session.ts — 连接与会话: 会话读取 / 恢复 / 切换 / 模型
//
// 由 dsh.ts 的 createRealDshAdapter 机械搬出（行为不变）。只依赖上下文对象。

import {
  normalizeHistoryMessages,
  resolveModelReasoning,
} from "./history-normalize.ts";
import {
  deleteSessionDir,
  listSessionRecords,
  forkErrorMessage,
} from "./session-records.ts";
import type { FileMentionCandidate } from "../file-mention.ts";
import type {
  DshAdapter,
  ModelInfo,
  ModelCatalog,
  DshAgentLike,
  LiveSessionHandle,
  SessionSurfaceView,
  GoalChangeLike,
  TodoItemLike,
  PermissionPresetServiceLike,
} from "./types.ts";
import { buildUserMessage, readDefaultSelection } from "./normalize.ts";
import { sessionRoots } from "./session-paths.ts";
import {
  readSessionUiState,
  writeSessionUiState,
  type SessionUiState,
} from "./session-ui-state.ts";
import { buildBootstrapKickoffMessage } from "./tool-bootstrap.ts";
import type { AdapterContext } from "./context.ts";

export function createSessionBridge(ctx: AdapterContext) {
  const s = ctx.state;
  const { opts } = ctx;
  const sessionQuery = opts.sessionQuery;
  const fileReferences = opts.fileReferences;

  const resolveContextWindow = async (
    key: string,
  ): Promise<number | undefined> => {
    if (s.ctxWindowCache.has(key)) return s.ctxWindowCache.get(key);
    const i = key.indexOf(":");
    const provider = i < 0 ? key : key.slice(0, i);
    const model = i < 0 ? key : key.slice(i + 1);
    const llm = opts.llm;
    let w: number | undefined;
    if (llm && typeof llm.resolveModelInfo === "function") {
      try {
        const info = await llm.resolveModelInfo(provider, model);
        w = info?.context?.contextWindow;
      } catch {
        /* 解析失败视为未披露 */
      }
    }
    s.ctxWindowCache.set(key, w);
    return w;
  };

  /**
   * 回合边界补齐：`base` 是正文来源（live 内存事件 / persisted surface 折叠面），两者都可能
   * **缺回合边界**——`turn/start` 提供回合号（无号用户消息按它归属）、`turn/end` 提供收尾原因，
   * 缺任一用户块就拿不到终态（画面全是 `?`）。缺时从完整日志（`readSession`）并回这两类事件：
   *
   *  - 按 `seq` 去重（`base` 优先）后**整体按 `seq` 归位**：追加到末尾会让边界事件排在正文
   *    之后，处理用户消息时回合号还没推进，回填会把多条用户块判到同一个回合（真机实测：
   *    51 个用户块全变 turn 1）；
   *  - `base` 一条数字 `seq` 都没有时无法归位 → 退回追加（旧行为，不比原来差）；
   *  - 读失败 → 原样返回 `base` 并给一条 warn notice：否则画面只剩「全 `?`」，无法归因。
   */
  const withTurnBoundaries = async (
    id: string,
    base: readonly Record<string, unknown>[],
  ): Promise<readonly Record<string, unknown>[]> => {
    if (sessionQuery?.readSession === undefined) return base;
    const turnOf = (e: Record<string, unknown>): number | undefined => {
      const turn = (e.data as { turn?: unknown } | undefined)?.turn;
      return typeof turn === "number" ? turn : undefined;
    };
    const ended = new Set<number>();
    for (const e of base) {
      if (e.type !== "turn/end") continue;
      const turn = turnOf(e);
      if (turn !== undefined) ended.add(turn);
    }
    // 边界不完整：① 一条 `turn/end` 都没有；② 有用户消息没带回合号（等 `turn/start` 回填）
    // 或它引用的回合没有收尾；③ 用户块由 `agent/inbox/spliced` 承载（内存会话形态，取不到号）
    let incomplete = ended.size === 0;
    for (const e of base) {
      if (incomplete) break;
      if (e.type === "agent/inbox/spliced") incomplete = true;
      else if (e.type === "user/message") {
        const turn = turnOf(e);
        if (turn === undefined || !ended.has(turn)) incomplete = true;
      }
    }
    if (!incomplete) return base;
    try {
      const full = await sessionQuery.readSession(id);
      const seen = new Set(
        base
          .map((e) => e.seq)
          .filter((seq): seq is number => typeof seq === "number"),
      );
      const extra = full.events.filter(
        (e) =>
          (e.type === "turn/start" || e.type === "turn/end") &&
          !(typeof e.seq === "number" && seen.has(e.seq)),
      );
      if (extra.length === 0) return base;
      const merged = [...base, ...extra];
      if (!base.some((e) => typeof e.seq === "number")) return merged;
      const seqOf = (e: Record<string, unknown>): number =>
        typeof e.seq === "number" ? e.seq : Number.MAX_SAFE_INTEGER;
      return merged.sort((a, b) => seqOf(a) - seqOf(b));
    } catch {
      ctx.emit({
        type: "notice",
        text: "历史回合边界补齐失败：持久日志不可读，恢复的用户块可能显示 ?",
        tone: "warn",
      });
      return base;
    }
  };

  /** 只读会话表面（live 直接读内存事件；persisted 走 readSurface；兜底 readSession）。
   *  `boundaries: false` 供 `listSessions` 的标题 / 空会话探针用——那里只要正文，不必为每个
   *  活跃 live 会话多读一次完整日志。 */
  const doReadSessionSurface = async (
    id: string,
    readOpts?: { boundaries?: boolean },
  ): Promise<SessionSurfaceView> => {
    const boundaries = readOpts?.boundaries !== false;
    if (!sessionQuery) {
      throw new Error(
        "sessionQuery 未暴露 readSession/readSurface，无法读取会话内容",
      );
    }
    const live = opts.sessions?.get(id);
    if (live && Array.isArray(live.events)) {
      // 条目 27：内存 store 的事件里**可能缺回合边界**（真机实测：恢复出来的用户块读不到
      // 收尾原因 → 一律 `?`），也可能只覆盖一部分回合（旧回合缺、新回合有）。正文仍用 live
      // （保最新），缺的边界从完整日志补——补齐口径见 `withTurnBoundaries`
      const events: readonly Record<string, unknown>[] = boundaries
        ? await withTurnBoundaries(id, live.events)
        : live.events;
      const messages = normalizeHistoryMessages(events);
      // 刚 resume 的会话在内存 store 可能尚未完全入列：live 表面为空时
      // 回退到 persisted 读取面（readSurface）拿完整历史，避免切换后空屏
      if (messages.length > 0) {
        return { sessionId: id, messages };
      }
    }
    if (sessionQuery.readSurface) {
      const snap = await sessionQuery.readSurface(id);
      // surface fold **不含 turn/start 与 turn/end**（真机实测：517 条事件里两者都是 0）→
      // 用户块拿不到终态，恒 `?`。补边界口径与 live 分支同源（`withTurnBoundaries`）。
      const surfaceEvents: readonly Record<string, unknown>[] = boundaries
        ? await withTurnBoundaries(id, snap.events)
        : snap.events;
      const msgs = normalizeHistoryMessages(surfaceEvents);
      return { sessionId: id, messages: msgs };
    }
    if (sessionQuery.readSession) {
      const snap = await sessionQuery.readSession(id);
      const msgs = normalizeHistoryMessages(snap.events);
      return { sessionId: id, messages: msgs };
    }
    throw new Error(
      "sessionQuery 未暴露 readSession/readSurface，无法读取会话内容",
    );
  };

  /**
   * 会话状态回填：启动/恢复会话时把**宿主日志**（log-only 事件，切换会话不重放）
   * 与 **TUI 侧快照**（`<会话目录>/tui-state.json`）折叠成事件推给 App。
   *
   * 折叠口径（每项都是「宿主日志末条 → 快照 → 宿主默认」）：
   *  - model：末条 `model/selection`（显式意图）→ 快照 `model` → 末条
   *    `request/header.header.config`（该会话最近一次**实际使用**的 provider/model/
   *    effort）。命中即写回 `opts.sessionModel.current`（agent/request 钩子的生效源，
   *    也是 /model 面板与状态行的显示源）；三者都没有 → 清空会话内引用回落宿主默认。
   *  - mode：`plan/mode` / `sandbox/mode` / `permission/preset`；`approval/policy`
   *    同理单独成事件。宿主无记录时退回快照，再退回 permissionPresets.defaultPreset
   *    捆绑（= pinInitialPermission 会给全新会话钉上的组合），plan 无记录即 off。
   *  - goal：按 seq 顺序回放全部 `goal/change`（累积成会话 goal 历史，当前 + 旧 goal 一并展示）；
   *    todo：末条 `todo/write`（全量快照事件，latest-wins）。
   *  - TUI 本地开关（`/collapse`、`/symbol-unify`）宿主不认识，只在快照里 → ui-flags。
   *
   * 读取源：live 会话优先读内存 events（全量原始，最省事）；否则走
   * `sessionQuery.readSession`（readSurface 做 surface fold 会滤掉 log-only 事件）。
   * 宿主既无 live 会话也无 sessionQuery 时只回填快照能提供的部分；快照也没有则静默
   * （模式值保持事件驱动）。
   */
  const restoreSessionState = async (id: string): Promise<void> => {
    let events: readonly { type?: string; data?: unknown }[] | undefined;
    const live = opts.sessions?.get(id);
    if (live && Array.isArray(live.events) && live.events.length > 0) {
      events = live.events as readonly { type?: string; data?: unknown }[];
    } else if (sessionQuery?.readSession) {
      try {
        const snap = await sessionQuery.readSession(id);
        events = snap.events as readonly { type?: string; data?: unknown }[];
      } catch {
        events = undefined; // 混合日志校验失败等：退回快照/默认值，不阻断恢复
      }
    }
    const uiState = readSessionUiState(
      id,
      opts.sessionStateRoots ?? sessionRoots(),
    );
    const lastOf = <T>(type: string): T | undefined => {
      if (!events) return undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === type) return events[i]?.data as T;
      }
      return undefined;
    };
    // 宿主默认预设（全新会话会被 pin 的值）：presets 表属结构面之外，宽松读取，
    // 缺 defaultPreset/presets 条目时降级跳过对应旋钮（不发默认值、不臆造模式）。
    const svc = opts.permissionPresets as
      | (PermissionPresetServiceLike & {
          presets?: Record<string, { sandbox?: unknown; approval?: unknown }>;
        })
      | undefined;
    const defName = svc?.defaultPreset;
    const defSpec = defName ? svc?.presets?.[defName] : undefined;
    const defSandbox =
      typeof defSpec?.sandbox === "string" ? defSpec.sandbox : undefined;
    const defPolicy =
      defSpec?.approval === "ask" || defSpec?.approval === "never"
        ? defSpec.approval
        : undefined;

    // —— 模式（宿主末条事件 → 快照 → 宿主默认） ——
    const planRec = lastOf("plan/mode") as { active?: unknown } | undefined;
    // plan 是 opt-in：宿主无记录时看快照，仍无记录即未开启（off）
    const plan: "on" | "off" =
      planRec !== undefined
        ? planRec.active === true
          ? "on"
          : "off"
        : (uiState?.modes?.plan ?? "off");
    ctx.emit({ type: "mode", sessionId: id, kind: "plan", value: plan });
    const sandbox = lastOf("sandbox/mode") as { mode?: unknown } | undefined;
    const sandboxValue =
      typeof sandbox?.mode === "string"
        ? sandbox.mode
        : (uiState?.modes?.sandbox ?? defSandbox);
    if (sandboxValue !== undefined) {
      ctx.emit({
        type: "mode",
        sessionId: id,
        kind: "sandbox",
        value: sandboxValue,
      });
    }
    const perm = lastOf("permission/preset") as
      { preset?: unknown } | undefined;
    const permValue =
      typeof perm?.preset === "string"
        ? perm.preset
        : (uiState?.modes?.permission ?? defName);
    if (permValue !== undefined) {
      ctx.emit({
        type: "mode",
        sessionId: id,
        kind: "permission",
        value: permValue,
      });
    }
    const pol = lastOf("approval/policy") as { policy?: unknown } | undefined;
    const policyValue =
      pol?.policy === "ask" || pol?.policy === "never"
        ? pol.policy
        : (uiState?.modes?.policy ?? defPolicy);
    if (policyValue !== undefined) {
      ctx.emit({ type: "approval-policy", sessionId: id, policy: policyValue });
    }

    // —— 模型（宿主显式意图 → TUI 快照 → 宿主最近实际使用） ——
    const pick = (
      v:
        | { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
        | undefined,
    ):
      | { provider: string; model: string; reasoningEffort?: string }
      | undefined => {
      if (typeof v?.provider !== "string" || typeof v.model !== "string")
        return undefined;
      return {
        provider: v.provider,
        model: v.model,
        ...(typeof v.reasoningEffort === "string"
          ? { reasoningEffort: v.reasoningEffort }
          : {}),
      };
    };
    const header = lastOf("request/header") as
      { header?: { config?: Record<string, unknown> } } | undefined;
    const selected =
      pick(lastOf("model/selection")) ??
      pick(uiState?.model) ??
      pick(header?.header?.config);
    // sessionModel 引用是 agent/request 钩子的生效源：恢复后本会话的请求就用该模型。
    // 三者皆无 → 回到初始种子（config 固定模型；无种子即 undefined → 回落宿主实时默认），
    // 避免「上一个会话的选择」泄漏进本会话，也不把 config 固定的模型清掉。
    if (opts.sessionModel)
      opts.sessionModel.current = selected ?? s.sessionModelSeed;
    if (selected) {
      ctx.emit({
        type: "model-selection",
        sessionId: id,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort }),
      });
    }

    // —— goal / todo ——
    // goal：按 seq 顺序回放**全部** `goal/change`（状态列按会话累积成历史：当前 + 旧 goal；
    // 只取末条会丢掉已完成的历史）。activation 是进程本地态、不在日志里，故回放不产出
    // （重启后宿主即 disarmed，显示层按「无记录 → disarmed」推导）。todo：末条
    // `todo/write`（全量快照，latest-wins）。
    for (const ev of events ?? []) {
      if (ev.type !== "goal/change") continue;
      const change = ev.data as GoalChangeLike | undefined;
      if (change === undefined) continue;
      if (change.operation === "clear") {
        ctx.emit({
          type: "goal-change",
          sessionId: id,
          operation: "clear",
          cleared: change.cleared,
          clearedAt: change.clearedAt,
        });
      } else {
        ctx.emit({
          type: "goal-change",
          sessionId: id,
          operation: change.operation,
          goal: change.goal,
          roundsStarted: change.roundsStarted,
          createdAt: change.createdAt,
          updatedAt: change.updatedAt,
        });
      }
    }
    const todos = lastOf("todo/write") as { todos?: unknown } | undefined;
    if (todos !== undefined) {
      ctx.emit({
        type: "todo-write",
        sessionId: id,
        todos: Array.isArray(todos.todos)
          ? (todos.todos as TodoItemLike[])
          : [],
      });
    }

    // —— TUI 本地开关（宿主日志没有，只有快照） ——
    if (
      uiState?.symbolUnify !== undefined ||
      uiState?.statusColumn !== undefined ||
      uiState?.lowerPanes !== undefined
    ) {
      ctx.emit({
        type: "ui-flags",
        sessionId: id,
        ...(uiState.symbolUnify === undefined
          ? {}
          : { symbolUnify: uiState.symbolUnify }),
        // P7：垂直状态列显隐（缺省显示）
        ...(uiState.statusColumn === undefined
          ? {}
          : { statusColumn: uiState.statusColumn }),
        // #9：下半区（Turn/Tool）显隐（缺省显示）
        ...(uiState.lowerPanes === undefined
          ? {}
          : { lowerPanes: uiState.lowerPanes }),
      });
    }
  };

  // --- 流式块应用（实时帧与结算数组共用） ---
  // 按 (session, turn, step, index) 累计已流式输出的 delta，block-end 只补发未输出
  // 部分（docs/host/DSH-CTX-API.md §2 PartialAccumulator 折叠语义），避免完整正文重复显示。
  // 同一 index 跨 turn/step 不复用累计（key 含 turn/step；turn/end 亦清空）。
  // finish/usage 等载荷可能无 index；仅带 index 的块类型参与累计。
  // completedBlocks 拦截：实时帧已完整交付的块，结算数组不再输出。

  const part: Partial<DshAdapter> = {
    get sessionId() {
      return s.activeSessionId;
    },
    // TUI#40：启动即恢复（--resume / -c）标记，App 据此补一次历史折叠
    resumedAtLaunch: opts.resumedAtLaunch === true,
    canSteer() {
      // TUI#36：**优先看原始宿主 agent**（activeCommandAgent，随 resume/new 同步切换）。
      // 瘦 agent（opts.agent / resume 时新建）只转发 followup，早期实现只看它 → 真实会话里
      // 恒 false、`<` 提交静默降级成 followup（真机缺陷，2026-09-27）。
      const raw = s.activeCommandAgent as { steer?: unknown } | undefined;
      return (
        typeof raw?.steer === "function" ||
        typeof s.activeAgent.steer === "function"
      );
    },
    sendMessage(text, targetSessionId, target) {
      if (s.disposed) return;
      if (targetSessionId && targetSessionId !== s.activeSessionId) {
        process.stderr.write(
          "[dsh adapter] sendMessage: sessionId " +
            targetSessionId +
            " not active\n",
        );
        return;
      }
      // steer（BACKLOG TUI#36）：官方 agent.steer = 投递到最近 step 边界。
      // 走原始宿主 agent；两者都没有 steer（旧宿主）→ 回落 followup（App 侧另有降级提示）
      if (target === "next-step") {
        const message = buildUserMessage(text);
        const raw = s.activeCommandAgent as
          { steer?: (m: typeof message) => void } | undefined;
        if (typeof raw?.steer === "function") {
          raw.steer(message);
          return;
        }
        if (typeof s.activeAgent.steer === "function") {
          s.activeAgent.steer(message);
          return;
        }
      }
      s.activeAgent.followup(buildUserMessage(text));
    },
    /**
     * 启动自检 kickoff（锚定解锁）：以 `source.kind:"tool-bootstrap"` 发一条 user 消息
     * （正文 `[AUTO]` 开头），驱动模型发起首个工具调用完成解锁。真实 DSH 不回显非 notice
     * 的注入 user 消息，故回显由 App 侧负责；仅启动期由 App 门控后调用一次。
     */
    sendBootstrapKickoff() {
      if (s.disposed) return;
      const message = buildBootstrapKickoffMessage();
      // BACKLOG #2：kickoff 优先走 steer（next-step 队列 —— 投递到最近 step 边界，启动竞态下
      // 已有回合在跑也能被**当前回合**领取；空闲时立刻起回合），查找次序与 sendMessage 的
      // next-step 分支一致（优先原始宿主 agent，见 canSteer 的两层判据）；
      // 无 steer 的宿主（旧宿主）→ 回落 followup（降级不丢，日志可见）。
      const raw = s.activeCommandAgent as
        { steer?: (m: typeof message) => void } | undefined;
      if (typeof raw?.steer === "function") {
        raw.steer(message);
        return;
      }
      if (typeof s.activeAgent.steer === "function") {
        s.activeAgent.steer(message);
        return;
      }
      process.stderr.write(
        "[dsh adapter] sendBootstrapKickoff: 宿主无 steer，回落 followup\n",
      );
      s.activeAgent.followup(message);
    },
    interrupt() {
      if (s.disposed) return;
      s.activeCancel?.();
    },
    async modelCatalog() {
      const current =
        opts.sessionModel?.current ?? readDefaultSelection(opts.defaultModel);
      const providers: ModelCatalog["providers"] = [];
      const models: ModelInfo[] = [];
      const llm = opts.llm;
      if (llm && typeof llm.listProviders === "function") {
        for (const p of llm.listProviders() ?? []) {
          const pid = p.id ?? "";
          if (!pid) continue;
          providers.push({ provider: pid, name: p.name });
          if (typeof llm.listModels === "function") {
            const list = await llm.listModels(pid);
            for (const m of list ?? []) {
              if (!m.id) continue;
              models.push({
                provider: pid,
                id: m.id,
                name: m.name ?? m.id,
                description: m.description,
              });
            }
          }
        }
      }
      return { providers, models, current };
    },
    // 提示文本 `@` 提及候选（ctx.fileReferences.list，dsh-file-reference-local 提供实现）：
    // 服务未挂载 / agent 未就绪 → undefined（App 侧关闭该特性）；查询异常 → 空数组
    // （静默降级：输入不被补全故障打断，也不弹错）。仅取 path/kind，**不读文件内容**
    // （宿主契约：选择候选只插入提示文本，读文件由模型侧工具完成）。
    listFileCandidates: fileReferences
      ? async (query, signal) => {
          const agent = s.activeCommandAgent ?? s.activeAgent;
          if (!agent) return [];
          try {
            const raw = await fileReferences.list(agent, query, signal);
            const out: FileMentionCandidate[] = [];
            for (const r of raw ?? []) {
              const path = typeof r?.path === "string" ? r.path : "";
              if (!path) continue;
              out.push({
                path,
                kind: r?.kind === "directory" ? "directory" : "file",
              });
            }
            return out;
          } catch {
            return [];
          }
        }
      : undefined,
    // 历史会话列表（宿主挂载 sessionQuery 时可用）：按**编辑时间**从晚到早（TUI#1）；
    // 标题优先官方 session/title 事件（批量折叠），缺失时本地兜底首条用户消息；
    // 同一趟 surface 读取顺带判定 isEmpty（持久化且从未有用户消息 → 可清理）。
    // 归一化/排序单一来源 = 模块级 listSessionRecords（与 main.ts 的 -c 解析共用）。
    listSessions: sessionQuery
      ? () =>
          listSessionRecords({
            sessionQuery,
            readMessages: async (id) =>
              (await doReadSessionSurface(id, { boundaries: false })).messages,
            ...(s.activeSessionId === undefined
              ? {}
              : { activeSessionId: s.activeSessionId }),
          })
      : undefined,
    // 删除持久化会话（文件级）：安全 id + realpath 包含性校验后删除会话目录；
    // 当前活跃会话与内存中的 live 会话一律拒绝（面板侧另有前置守卫）
    deleteSession: sessionQuery
      ? async (id) => {
          if (s.activeSessionId !== undefined && id === s.activeSessionId) {
            return { ok: false as const, reason: "当前活跃会话不可删除" };
          }
          if (opts.sessions?.get(id) !== undefined) {
            return {
              ok: false as const,
              reason: "live 会话不可删除（仅可删除已持久化且不在内存中的会话）",
            };
          }
          const outcome = deleteSessionDir(id);
          return outcome.ok
            ? { ok: true as const }
            : { ok: false as const, reason: outcome.reason };
        }
      : undefined,
    // 退出前删除**当前活跃会话**（仅 App 的「清理并退出」收尾调用）：与 deleteSession 相反，
    // 它刻意不做 activeSessionId / live 守卫——调用点固定在 adapter.dispose() 之后（handle
    // 已释放、进程即将退出，无并发打开风险），且删除必须发生在 renderer.close() 之前。
    deleteSessionForExit: sessionQuery
      ? (id: string) => {
          const outcome = deleteSessionDir(id);
          return outcome.ok
            ? { ok: true as const }
            : { ok: false as const, reason: outcome.reason };
        }
      : undefined,
    readSessionSurface: sessionQuery
      ? (id) => {
          // 读取顺序（按 live/persisted 判定，避免走错接口）见 doReadSessionSurface
          return doReadSessionSurface(id);
        }
      : undefined,
    restoreSessionState:
      sessionQuery || opts.permissionPresets || opts.sessions
        ? async (id: string) => {
            await restoreSessionState(id);
          }
        : undefined,
    readSessionUiState: (id: string) =>
      readSessionUiState(id, opts.sessionStateRoots ?? sessionRoots()),
    saveSessionUiState: (id: string, state: SessionUiState) =>
      writeSessionUiState(id, state, opts.sessionStateRoots ?? sessionRoots())
        .ok,
    async sessionTitle(id) {
      if (!sessionQuery || typeof sessionQuery.readTitle !== "function") {
        return undefined;
      }
      try {
        const t = await sessionQuery.readTitle(id);
        return t?.title;
      } catch {
        return undefined;
      }
    },
    /** 重命名当前会话标题：宿主 sessionTitle.rename(live Session, title)。
     *  live Session 对象随 resume 变化，故始终取当前活跃 agent 的 session
     *  （DshAgentLike.session 运行时即 Session 实例，见 main.ts 的 agentLike 组装）。 */
    async renameSession(title: string): Promise<void> {
      const svc = opts.sessionTitle;
      if (!svc || typeof svc.rename !== "function") {
        throw new Error("sessionTitle 未挂载（宿主无会话标题服务）");
      }
      const session = (
        s.activeAgent as { session?: LiveSessionHandle } | undefined
      )?.session;
      if (!session) {
        throw new Error("活跃会话不可用，无法重命名");
      }
      svc.rename(session, title);
    },
    /** /fork：`sessions.fork(activeSessionId)`（省略 boundary/childSessionId =
     *  源会话当前最后事件 + store id 策略）；错误码 5 个映射中文后 reject（不抛穿）。 */
    async forkCurrentSession(): Promise<{
      id: string;
      title?: string | undefined;
    }> {
      const svc = opts.sessions;
      if (!svc || typeof svc.fork !== "function") {
        throw new Error("sessions 未挂载（宿主无会话 fork 服务）");
      }
      let child: { id: string; title?: string } | undefined;
      try {
        child = svc.fork(s.activeSessionId);
      } catch (err) {
        throw new Error(forkErrorMessage(err));
      }
      if (!child || typeof child.id !== "string" || child.id === "") {
        throw new Error(forkErrorMessage({ code: "SESSION_NOT_FOUND" }));
      }
      return { id: child.id, title: child.title };
    },
    async resumeTo(id) {
      if (s.disposed) {
        throw new Error("adapter 已释放，无法切换会话");
      }
      if (!opts.agents || typeof opts.agents.resume !== "function") {
        throw new Error("agents 未暴露 resume（宿主未配置会话持久化）");
      }
      // 契约顺序（P0 切换）：先释放当前 agent 的 handle（旧会话不再活跃），
      // 再 agents.resume 加载目标持久化会话；resume 失败 → 面板 error 态不崩溃。
      const prevDispose = s.activeDispose;
      if (prevDispose) {
        s.activeDispose = undefined;
        try {
          await prevDispose();
        } catch {
          /* 旧 handle 释放失败不阻断切换 */
        }
      }
      const handle = await opts.agents.resume({
        resumeSessionId: id,
        ...(opts.agentOptions ? { agentOptions: opts.agentOptions } : {}),
        ...(opts.setup ? { setup: opts.setup } : {}),
      });
      const rawAgent = handle.agent as
        | {
            session?: { id?: string };
            followup?: (m: ReturnType<typeof buildUserMessage>) => void;
            cancel?: (cause: { kind: "user" }) => void;
          }
        | undefined;
      if (!rawAgent?.session || !rawAgent.session.id) {
        try {
          await handle.dispose();
        } catch {
          /* 释放失败不阻断 */
        }
        throw new Error("resume 未返回有效 agent");
      }
      const newAgent = {
        session: rawAgent.session,
        followup: (m: ReturnType<typeof buildUserMessage>) =>
          rawAgent.followup?.(m),
      } as DshAgentLike;
      s.activeAgent = newAgent;
      s.activeCommandAgent = rawAgent as unknown;
      s.activeCancel =
        rawAgent.cancel === undefined
          ? () => {}
          : () => rawAgent.cancel?.({ kind: "user" });
      s.activeSessionId = id;
      s.activeDispose = () => handle.dispose();
      // 宿主 `agents.resume` 走 `sessions.prepare` → **重建 Session**：activation 是进程本地态，
      // 新 Session 即 disarmed，且 `setActivation(disarmed)` 与初值相同 → **不发 activation 边**。
      // 故此处清该会话的旧边，交由「无记录 → disarmed」推导；否则切走再切回会沿用切换前的
      // armed（显绿，实际已需用户驱动）。
      ctx.emit({ type: "goal-activation", sessionId: id });
    },
    /** /new：新建会话（dispose 旧 agent → agents.create 全新会话，同一 setup/agentOptions）。
     *  旧会话已持久化在磁盘上（handle 释放后变 persisted 非 live），可经 /session 切回。 */
    async newSession() {
      if (s.disposed) {
        throw new Error("adapter 已释放，无法新建会话");
      }
      if (!opts.agents || typeof opts.agents.create !== "function") {
        throw new Error("agents 未暴露 create（宿主未配置会话创建）");
      }
      // 与 resumeTo 同序：先释放当前 agent 的 handle，再建新会话（失败不留下双活 handle）
      const prevDispose = s.activeDispose;
      if (prevDispose) {
        s.activeDispose = undefined;
        try {
          await prevDispose();
        } catch {
          /* 旧 handle 释放失败不阻断新建 */
        }
      }
      const { randomUUID } = await import("node:crypto");
      const sessionId = "tui-" + randomUUID();
      const handle = await opts.agents.create({
        sessionId,
        ...(opts.sessionMeta ? { meta: opts.sessionMeta } : {}),
        ...(opts.agentOptions ? { agentOptions: opts.agentOptions } : {}),
        ...(opts.setup ? { setup: opts.setup } : {}),
      });
      const rawAgent = handle.agent as
        | {
            session?: { id?: string };
            followup?: (m: ReturnType<typeof buildUserMessage>) => void;
            cancel?: (cause: { kind: "user" }) => void;
          }
        | undefined;
      if (!rawAgent?.session || !rawAgent.session.id) {
        try {
          await handle.dispose();
        } catch {
          /* 释放失败不阻断 */
        }
        throw new Error("create 未返回有效 agent");
      }
      s.activeAgent = {
        session: rawAgent.session,
        followup: (m: ReturnType<typeof buildUserMessage>) =>
          rawAgent.followup?.(m),
      } as DshAgentLike;
      s.activeCommandAgent = rawAgent as unknown;
      s.activeCancel =
        rawAgent.cancel === undefined
          ? () => {}
          : () => rawAgent.cancel?.({ kind: "user" });
      s.activeSessionId = rawAgent.session.id;
      s.activeDispose = () => handle.dispose();
      return { id: s.activeSessionId };
    },
    async setSessionModel(sel) {
      if (!opts.sessionModel) {
        throw new Error("会话模型引用未注入，无法切换模型");
      }
      // 只改会话语义内的引用，绝不写宿主 settings（避免覆盖配置默认模型）
      opts.sessionModel.current = sel;
      return sel;
    },
    async modelEfforts(provider, model) {
      return (await resolveModelReasoning(opts, provider, model))?.efforts;
    },
    // 推理元数据（efforts + provider 默认等级）：状态行/面板按实际生效值展示
    modelReasoning(provider, model) {
      return resolveModelReasoning(opts, provider, model);
    },
  };

  return {
    part,
    withTurnBoundaries,
    doReadSessionSurface,
    restoreSessionState,
    resolveContextWindow,
  };
}
