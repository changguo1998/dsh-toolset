/**
 * plan-mode 插件入口（DSH bundle 接入面）。
 *
 * 角色（决策项 6）：**流程定义插件**，与 flow-track 平级——本包定义 plan 三段
 * （探索 / 计划 / 实施）并提供入口工具 `plan_start`；建树经 task-engine 的编程服务面
 * `composeFromNodes`，建树之后节点推进 / 校验 / 验收 / 推送全部由 task-engine 接管。
 *
 * 写面拦截（阶段 3）：挂 `tools/pre-execute`，按会话映射与阶段判定，探索与计划段
 * 拒绝写类工具（决策项 3 / 4 / 5），拒绝回执带 `info.code === "plan_stage_readonly"`；
 * 判定核在 `guard.ts`，段推演在 `stage.ts`，会话归属在 `session-map.ts`。
 *
 * 权限预设切换与恢复（阶段 4）：`plan_start` 建树成功后切只读并记原预设，恢复走
 * 五个入口（计划段终态 / 切走 / 会话结束 / 树完成 / 插件卸载），轮询经
 * `pinNotes.hold("plan-mode")` 的 provider（每步一次）。逻辑在 `preset.ts`。
 *
 * 降级：`tools` 是硬依赖；`taskEngine` 可选（缺席时 `plan_start` 返回可读错误）；
 * `on` / `provide` 缺席时对应功能不生效并告警，不阻断启动。
 */

import { wrapToolDefinition } from "@dsh-toolset/tool-surface";

import { planStartTool, type PlanComposeFace } from "./plan-start.ts";
import { PLAN_ID, PLAN_NAME } from "./stages.ts";
import { STAGE_READONLY_CODE, decide, toolWriteKind } from "./guard.ts";
import {
  makeParentReader,
  nearestPlanRecord,
  type AgentsLike,
} from "./ancestor.ts";
import {
  currentStage,
  planDone,
  planTerminal,
  type Stage,
  type TaskLike,
} from "./stage.ts";
import {
  drop as dropRecord,
  get as getRecord,
  list as listRecords,
  set as setRecord,
  type PlanRecord,
} from "./session-map.ts";
import {
  enterPlanPreset,
  restorePreset,
  switchToReadonly,
  type PresetsService,
} from "./preset.ts";
import { stageMessage } from "./push.ts";

export const name = "plan-mode";

/** 注入面：装配期要注册工具面，`tools` 是硬依赖。 */
export const inject = ["tools"];

/** 对外只读服务面：TUI 段位条目消费 `planStage.current(sessionId)`。 */
export const provide = ["planStage"];

/** 技术面结构（插件上下文的最小形态）。 */
interface PluginContext {
  get?(name: string): unknown;
  tools?: { register(def: unknown): unknown };
  logger?: { warn?(message: string): void };
  on?(event: string, callback: (...args: unknown[]) => unknown): unknown;
  provide?(name: string, value: unknown): unknown;
}

/** `taskEngine` 服务面里本包用到的部分。 */
interface TaskEngineFace {
  composeFromNodes?(
    parentId: string | undefined,
    nodes: unknown[],
  ): Promise<{
    ok: boolean;
    accepted?: boolean;
    next?: string | null;
    feedback?: string;
  }>;
  query?(): { tasks?: readonly unknown[]; isComplete?: boolean };
}

/** `flowArbiter` 服务面里本包用到的部分（切走恢复用）。 */
interface FlowArbiterFace {
  register?(flow: { id: string; name: string; entry: string }): unknown;
  current?(sessionId: string): { id: string } | null;
}

/** `pinNotes` 服务面里本包用到的部分（轮询 provider）。 */
interface PinNotesFace {
  hold?(
    key: string,
    provider: (context: { sessionId: string }) => unknown,
  ): unknown;
}

/** 读一个服务（`ctx.get` 优先，退回属性读；缺失一律降级）。 */
function readService<T>(ctx: PluginContext, name: string): T | undefined {
  try {
    const value = ctx.get?.(name);
    if (value !== undefined) return value as T;
  } catch {
    /* ctx.get 抛错：落到属性读 */
  }
  try {
    return (ctx as Record<string, unknown>)[name] as T | undefined;
  } catch {
    return undefined;
  }
}

/** 建树帧 id 前缀（进程内递增 + 时间戳基数：跨轮 / 多次建树都不撞 id）。 */
let planSeq = 0;
function nextPlanPrefix(): string {
  planSeq += 1;
  return `plan-${Date.now().toString(36)}-${planSeq}`;
}

/** 从执行对象取会话：`exec.agent.session` 优先，退回 `exec.session`。 */
function sessionOf(exec: unknown): { id?: string } | undefined {
  const like = exec as
    | { agent?: { session?: { id?: string } }; session?: { id?: string } }
    | undefined;
  return like?.agent?.session ?? like?.session;
}

/** 从执行对象取会话 id（拿不到返回 undefined）。 */
function sessionIdOf(exec: unknown): string | undefined {
  const session = sessionOf(exec);
  return typeof session?.id === "string" ? session.id : undefined;
}

/** 只读服务面：当前段与是否只读（无映射且未选中 plan → null；无任务引擎 → null）。
 *  `idle` 为带外态：已选中 plan 但尚未建树（TUI 标题栏按绿显示）。 */
function planStageCurrent(
  ctx: PluginContext,
  sessionId: string,
): { stage: Stage | "idle"; readonly: boolean } | null {
  const record = getRecord(sessionId);
  // 无映射：若 flow-arbiter 已选中 plan 但尚未建树（没有任务）→ 报带外态 idle（绿），
  // 否则未进 plan 模式 → null（灰）。
  if (record === undefined) {
    const arbiter = readService<FlowArbiterFace>(ctx, "flowArbiter");
    const selected = arbiter?.current?.(sessionId);
    if (typeof selected?.id === "string" && selected.id === PLAN_ID) {
      return { stage: "idle", readonly: false };
    }
    return null;
  }
  const engine = readService<TaskEngineFace>(ctx, "taskEngine");
  const snapshot = engine?.query?.();
  if (snapshot === undefined) return null;
  const stage = currentStage(
    (snapshot.tasks ?? []) as readonly TaskLike[],
    record.frames,
  );
  return { stage, readonly: stage === "explore" || stage === "plan" };
}

export function apply(ctx: unknown, _config?: unknown): () => void {
  const c = (ctx ?? {}) as PluginContext;
  const disposers: Array<() => void> = [];
  const logger = readService<{ warn?(message: string): void }>(c, "logger");
  const warn = (message: string): void => {
    if (typeof logger?.warn === "function") {
      logger.warn(`[plan-mode] warn: ${message}`);
      return;
    }
    process.stderr.write(`[plan-mode] warn: ${message}\n`);
  };
  const presetsOf = (): PresetsService | undefined =>
    readService<PresetsService>(c, "permissionPresets");
  // 父会话链读取器（子代理写调用继承父会话阶段）：agents 缺席时恒 undefined →
  // 上溯退化放行（宿主 sandbox 创建时快照继承仍在文件层兜底）。
  const agentsOf = (): AgentsLike | undefined =>
    readService<AgentsLike>(c, "agents");

  const composeOf = (): PlanComposeFace | undefined => {
    const face = readService<TaskEngineFace>(c, "taskEngine");
    const entry = face?.composeFromNodes;
    if (face === undefined || typeof entry !== "function") return undefined;
    return async (parentId, nodes) => entry.call(face, parentId, nodes);
  };
  if (composeOf() === undefined) {
    warn("ctx.taskEngine 未暴露 composeFromNodes，plan_start 暂不可用");
  }
  const tools = readService<{ register(def: unknown): unknown }>(c, "tools");
  if (tools === undefined || typeof tools.register !== "function") {
    warn("ctx.tools 不可用，plan_start 不会出现");
    return () => undefined;
  }
  // 向流程仲裁登记自身（决策项 8 的协作面）：仲裁缺席时跳过（仲裁侧内置默认登记）
  const arbiter = readService<FlowArbiterFace>(c, "flowArbiter");
  if (arbiter !== undefined && typeof arbiter.register === "function") {
    try {
      arbiter.register({ id: PLAN_ID, name: PLAN_NAME, entry: "plan_start" });
    } catch (error) {
      warn(`向 flow-arbiter 登记流程失败（忽略）：${String(error)}`);
    }
  }

  // 建树成功后的钩子（阶段 1 / 4）：串起会话映射与预设切换。
  const handleStarted = async (input: {
    sessionId: string;
    session?: unknown;
    frames: readonly string[];
  }): Promise<{ presetSwitched: boolean; presetNote?: string }> => {
    const existing = getRecord(input.sessionId);
    const decision =
      existing === undefined
        ? switchToReadonly(presetsOf(), input.session)
        : enterPlanPreset(presetsOf(), input.session, existing);
    const frames = input.frames as [string, string, string];
    const originalPreset = decision.originalPreset ?? existing?.originalPreset;
    setRecord(input.sessionId, {
      frames,
      ...(originalPreset === undefined ? {} : { originalPreset }),
      restored: false,
      session: input.session,
    });
    return {
      presetSwitched: decision.presetSwitched,
      ...(decision.presetNote === undefined
        ? {}
        : { presetNote: decision.presetNote }),
    };
  };

  try {
    // 注册前套包装层: 模型侧只见短说明与宽松占位, 全文与完整 schema 留给 consult_tools 投递
    tools.register(
      wrapToolDefinition(
        planStartTool({
          compose: composeOf,
          prefix: nextPlanPrefix,
          onStarted: handleStarted,
        }),
      ),
    );
  } catch (error) {
    warn(`工具 plan_start 注册失败：${String(error)}`);
  }

  // 恢复动作：restoreOnly 恢复后保留映射（实施段仍要段位），restoreAndDrop 恢复后清映射。
  const restoreOnly = (
    sessionId: string,
    record: PlanRecord,
    trigger: string,
  ): void => {
    const result = restorePreset(
      presetsOf(),
      record.session,
      record.originalPreset,
      record.restored,
    );
    setRecord(sessionId, { ...record, restored: true });
    if (result.note !== undefined)
      warn(`恢复预设（${trigger}）: ${result.note}`);
  };
  const restoreAndDrop = (
    sessionId: string,
    record: PlanRecord,
    trigger: string,
  ): void => {
    const result = restorePreset(
      presetsOf(),
      record.session,
      record.originalPreset,
      record.restored,
    );
    dropRecord(sessionId);
    if (result.note !== undefined)
      warn(`恢复预设（${trigger}）: ${result.note}`);
  };

  // 轮询来源（阶段 4）：计划段终态与切走都没有事件可听, 挂在 pinNotes.hold 的 provider 上
  // （每步一次、带 sessionId）。阶段 5 把注入文案补进同一个 provider。
  const holdProvider = (context: { sessionId: string }): string | undefined => {
    const sessionId = context.sessionId;
    const record = getRecord(sessionId);
    if (record === undefined) return undefined;
    try {
      const engine = readService<TaskEngineFace>(c, "taskEngine");
      const snapshot = engine?.query?.();
      const tasks = (snapshot?.tasks ?? []) as readonly TaskLike[];
      // 计划段到终态（完成或失败）→ 只恢复预设, 不动映射（决策项 8a）
      if (!record.restored && planTerminal(tasks, record.frames[1])) {
        restoreOnly(sessionId, record, "计划段终态");
        return undefined;
      }
      // 树完成 → 恢复并清映射（兜底, 与「树完成删一条」对齐）
      if (!record.restored && snapshot?.isComplete === true) {
        restoreAndDrop(sessionId, record, "树完成");
        return undefined;
      }
      // flow_select 切走, 不再选中 plan → 恢复并清映射
      if (!record.restored) {
        const face = readService<FlowArbiterFace>(c, "flowArbiter");
        if (face !== undefined && typeof face.current === "function") {
          const selected = face.current(sessionId);
          if (selected === null || selected.id !== PLAN_ID) {
            restoreAndDrop(sessionId, record, "切走");
            return undefined;
          }
        }
      }
      // 阶段 5：当前段注入文案（探索 / 计划说明只读与下一步, 实施说明已放行, 未知段不输出）。
      const stage = currentStage(tasks, record.frames);
      return stageMessage(stage);
    } catch (error) {
      warn(`轮询恢复失败（忽略）: ${String(error)}`);
    }
    return undefined;
  };
  // 轮询挂载（阶段 4 补登记）：pinNotes 服务按依赖拓扑可能晚于本包就绪——apply 时只试
  // 一次会静默丢功能。仿 task-engine 的 `ensureTaskHold`（beforeExecute 补登记）同款机制：
  // 首次失败告警一次，此后每次工具调用前（pre-execute）再试，pin-note 就绪后补登记。
  let holdRegistered = false;
  let holdWarned = false;
  const ensurePlanHold = (): void => {
    if (holdRegistered) return;
    const face = readService<PinNotesFace>(c, "pinNotes");
    if (face === undefined || typeof face.hold !== "function") {
      if (!holdWarned) {
        holdWarned = true;
        warn(
          "ctx.pinNotes 不可用，轮询恢复不会发生（将在 pin-note 就绪后于下次工具调用前补登记；当前只剩会话结束与插件卸载两条入口）",
        );
      }
      return;
    }
    try {
      const off = face.hold("plan-mode", (context) => holdProvider(context));
      if (typeof off === "function") disposers.push(off as () => void);
      holdRegistered = true;
    } catch (error) {
      warn(`登记 pinNotes.hold("plan-mode") 失败（忽略）：${String(error)}`);
    }
  };
  ensurePlanHold();

  // 事件钩子：会话结束 / 插件卸载 → 恢复并清映射（兜底）。
  if (typeof c.on === "function") {
    const offPre = c.on("tools/pre-execute", (...args: unknown[]) => {
      // 每次工具调用前补登记轮询（决策项 1）：pin-note 晚就绪时靠这里把 hold 挂上
      ensurePlanHold();
      const exec = args[0] as
        { name?: string; arguments?: unknown } | undefined;
      const next = args[1] as (() => unknown) | undefined;
      const passthrough = (): unknown =>
        typeof next === "function" ? next() : { kind: "allow" };
      const toolName = exec?.name;
      if (typeof toolName !== "string") return passthrough();
      const sessionId = sessionIdOf(exec);
      if (sessionId === undefined) return passthrough();
      // 判定顺序 1：会话没有直接映射 → 沿父会话链上溯（子代理写调用继承父会话
      // 阶段, 见决策 A）；链尽 / 超限 / agents 缺席仍无命中 → 放行（非 plan 家庭）。
      const direct = getRecord(sessionId);
      const hit =
        direct !== undefined
          ? { sessionId, record: direct }
          : nearestPlanRecord(
              sessionId,
              getRecord,
              makeParentReader(agentsOf()),
            );
      if (hit === undefined) return passthrough();
      const record = hit.record;
      const engine = readService<TaskEngineFace>(c, "taskEngine");
      const tasks = (engine?.query?.()?.tasks ?? []) as readonly TaskLike[];
      // 判定顺序 2：推不出段（树缺失 / 帧对不上）→ 放行。
      const stage = currentStage(tasks, record.frames);
      if (stage === "unknown") return passthrough();
      // 判定顺序 3：计划段已 done，或段是实施 → 放行（决策项 4a 放行点）。
      const isPlanDone = planDone(tasks, record.frames[1]);
      if (isPlanDone || stage === "implement") return passthrough();
      // 判定顺序 4 / 5：工具分类后按分类判，命中即拒。
      const toolArgs = (exec?.arguments ?? {}) as Record<string, unknown>;
      const kind = toolWriteKind(toolName, toolArgs);
      const command =
        kind === "terminal"
          ? String(toolArgs["command"] ?? toolArgs["text"] ?? "")
          : undefined;
      const decision = decide({
        mapped: true,
        stage,
        planDone: isPlanDone,
        kind,
        ...(command === undefined ? {} : { command }),
      });
      if (!decision.deny) return passthrough();
      const inherited = hit.sessionId !== sessionId;
      const reason = decision.reason ?? "plan 只读段禁止写";
      return {
        kind: "deny",
        reason: inherited ? `${reason}（继承自父会话 plan 只读段）` : reason,
        info: { name: STAGE_READONLY_CODE, code: STAGE_READONLY_CODE },
      };
    });
    if (typeof offPre === "function") disposers.push(offPre as () => void);

    const offDisposed = c.on("session/disposed", (session: unknown) => {
      const id = (session as { id?: string } | null)?.id;
      if (typeof id !== "string") return;
      const record = getRecord(id);
      if (record === undefined) return;
      restoreAndDrop(id, record, "会话结束");
    });
    if (typeof offDisposed === "function")
      disposers.push(offDisposed as () => void);

    const offDispose = c.on("dispose", () => {
      for (const sessionId of listRecords()) {
        const record = getRecord(sessionId);
        if (record === undefined) continue;
        restoreAndDrop(sessionId, record, "插件卸载");
      }
    });
    if (typeof offDispose === "function")
      disposers.push(offDispose as () => void);
  } else {
    warn("ctx.on 不可用，写面拦截与会话结束恢复不会生效");
  }

  // 只读服务面（阶段 3）：供 TUI 段位条目消费，不新增工具（决策项 7）。
  if (typeof c.provide === "function") {
    try {
      c.provide("planStage", {
        current: (sessionId: string) => planStageCurrent(c, sessionId),
      });
    } catch (error) {
      warn(`服务面 planStage 暴露失败（忽略）：${String(error)}`);
    }
  } else {
    warn("ctx.provide 不可用，planStage 服务面未暴露");
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}
