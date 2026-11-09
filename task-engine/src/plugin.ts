// task-engine/src/plugin.ts — cordis 插件入口：配置面、装配与生命周期
//
// 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
// name / inject / provide / Config / apply，Config 以类型声明给出（interface Config；
// 无运行时 schema，不引入 schemastery；宿主不校验，配置原样透传给 apply；缺省/非法值
// 沿用本包既有语义——root 缺省示例根、level 非法归一 mechanical，不新增校验）。
//
// 运行时依赖只有 `clock-base` 的定时器族（排期统一面），其余一律结构面访问宿主。
//
// 惰性、防御：可选服务缺失时降级而非抛错——`tools` 缺失告警并跳过注册，`approval` 缺失
// 静默 fail-closed（human 级一律视为未批准）；工具注册按结构面构造，失败只告警——保证
// dsh 加载本 bundle 时不崩。
//
// 已知边界（README 注明）：v1 引擎侧不做真实并行调度（只做在途帧记账）、单会话实例；
// 验收命令由本插件以 /bin/sh -c 执行（信任契约内命令）；human 级审批在工具 execute 内
// 调用 ctx.approval.request（工具执行发生在 open turn 内，满足 turn-enclosed）。
//
// 执行期复查（2026-10-02）：executor 的 command 后端与 mechanical 验收命令在执行**之前**
// 各过一次 security-guard（惰性 `ctx.get('guard')`，不要求挂载）：命中即不执行、回执原文作
// 失败原因；未挂载 / 复查抛错 → fail-open 放行 + 只告警一次，并把「这条命令没复查过」
// 留痕到事件流与反馈（`guardSkipped`，不静默）。

import { createDeadline, resolveClock } from "@dsh-toolset/clock-base";

import type { AuditRequest, AuditVerdict } from "./acceptance.ts";
import { makeRunCommand } from "./command.ts";
import { toDshTool } from "./dsh-tools.ts";
import { TaskEngine } from "./engine.ts";
import type { EntailHook, RootSpec } from "./engine.ts";
import { truncateEvidence } from "./evidence.ts";
import { makeExecutor } from "./executor.ts";
import { makeCommandGuard } from "./guard.ts";
import type { ApprovalLike, SubagentsLike, ToolsRegistrar } from "./host.ts";
import { readService, SUBAGENT_PROVIDER } from "./host.ts";
import { judgeToolFilter, runChildOnce } from "./subagent.ts";
import { createTools } from "./tools.ts";
import type { ToolExecuteCtx } from "./tools.ts";
import type { Acceptance, AcceptanceLevel, FrameId } from "./types.ts";
import {
  auditPrompt,
  entailPrompt,
  readVerdictValue,
  verdictEnvelope,
} from "./verdict.ts";
import { makeWorktreeIsolator } from "./worktree.ts";

export const name = "task-engine";
export const inject = ["tools"];
/** 只读查询面挂载声明（BACKLOG C1 补全：TUI /task 经 ctx.get('taskEngine') 接线） */
export const provide = ["taskEngine"];

export interface Config {
  /** 根任务契约（缺省提供示例根） */
  root?: {
    title: string;
    spec: string;
    acceptance: {
      id: string;
      check: string;
      level: string;
      command?: string;
    }[];
    needDecompose?: boolean;
  };
  /** 每次变更自动写快照的路径（周期快照） */
  snapshotPath?: string;
  /** 命令执行超时（ms，默认 30s）：mechanical 验收命令与 executor `command` 后端共用 */
  commandTimeoutMs?: number;
  /** fan-out 并发上限（BACKLOG #13，默认 4）：active 帧数达上限时不再弹栈 */
  maxConcurrent?: number;
  /** 打回重试上限（缺省 8，与 `DEFAULT_GATE.maxRetries` 同值）：decompose 拒绝与验收失败共用 */
  maxRetries?: number;
  /**
   * 语义面（audit / entail）开关与超时：两者各跑一次**裁决子代理**（经 `ctx.subagents`）。
   * 缺省都开（`audit` 关掉 → semantic 验收仍 fail-closed；`entail` 关掉 → 该门跳过，回到旧行为）；
   * 裁决 run 不可用（失败 / 超时 / 输出不可解析）时的分流：audit → **fail-closed 打回**（不假通过）；
   * entail → **跳过该门**并告警（环境故障不烧重试预算，见 engine 的 `EntailHook.skipped`）。
   */
  semantic?: {
    /** 语义级验收的独立 audit run（缺省 true） */
    audit?: boolean;
    /** 拆解第二道门的 entail run（缺省 true） */
    entail?: boolean;
    /** 单次裁决 run 超时 ms（缺省 120000） */
    timeoutMs?: number;
  };
}

const LEVELS: readonly AcceptanceLevel[] = ["mechanical", "semantic", "human"];

function isLevel(v: string): v is AcceptanceLevel {
  return (LEVELS as readonly string[]).includes(v);
}

/** 归一化根契约（容忍非法 level → 自动修成 mechanical 打回由裁决层兜底） */
function normalizeRoot(raw: Config["root"]): RootSpec {
  const acceptance: Acceptance[] = (raw?.acceptance ?? []).map(
    (a): Acceptance => ({
      id: a.id,
      check: a.check,
      level: isLevel(a.level) ? a.level : "mechanical",
      ...(a.command === undefined ? {} : { command: a.command }),
    }),
  );
  return {
    title: raw?.title ?? "当前任务",
    spec: raw?.spec ?? "",
    acceptance,
    needDecompose: raw?.needDecompose ?? true,
  };
}

export async function apply(ctx: unknown, config?: Config): Promise<void> {
  const warn = (msg: string): void => {
    process.stderr.write(`[task-engine] warn: ${msg}\n`);
  };
  const toolsSvc: ToolsRegistrar | undefined = (
    ctx as { tools?: ToolsRegistrar }
  ).tools;
  if (toolsSvc === undefined || typeof toolsSvc.register !== "function") {
    warn("ctx.tools 不可用，跳过工具注册");
  }
  // 定时器统一面（可选服务）：装配期解析一次；缺失时回落进程内定时器并只告警一次。
  // 超时排期同时覆盖 executor 的 subagent run 与 audit / entail 裁决 run：
  // 到点按超时中止，插件卸载时立即按超时收尾（不在途悬挂）。
  const timers = resolveClock(ctx, warn);
  const deadline = createDeadline(timers.scoped, ctx);

  // 审批服务（可选）：human 级验收经 ctx.approval.request，fail-closed
  const approval: ApprovalLike | undefined = (
    ctx as { get?: (name: string) => unknown }
  ).get?.("approval") as ApprovalLike | undefined;
  const approveVia = (
    exec: unknown,
  ): ((req: { frame: string; reason: string }) => Promise<boolean>) => {
    const agent = (exec as { agent?: unknown } | undefined)?.agent;
    return async (req: { frame: string; reason: string }): Promise<boolean> => {
      if (approval === undefined || typeof approval.request !== "function")
        return false;
      try {
        // 工具执行在 open turn 内 → approval.request turn-enclosed 约束满足
        const outcome = await approval.request({
          agent,
          toolName: "task_stop",
          reason: req.reason,
        });
        return outcome === "allowed-once";
      } catch (err) {
        warn(`approval.request 失败，fail-closed：${String(err)}`);
        return false;
      }
    };
  };
  // 叶子执行后端（① 发起 / ② 模型与计量）：宿主面**惰性**解析（执行期按名重试）+ 缺面 fail-closed
  const runShell = makeRunCommand(config?.commandTimeoutMs ?? 30_000);
  // 命令复查器（执行期检查点）：executor 命令后端与 mechanical 验收共用同一实例
  // （惰性 ctx.get("guard")；未挂载 / 抛错 → 放行 + 各告警一次，见 makeCommandGuard）
  const checkCommand = makeCommandGuard(ctx, warn);
  // 隔离器（叶子声明 isolate:"worktree"）：建 / 复用在 executor 适配器里，回收走引擎终态钩子
  // （stop / join / 重试耗尽 → done / failed），与命令复查共用同一 checkCommand 实例
  const worktrees = makeWorktreeIsolator({ checkCommand, warn });
  /**
   * 验收命令（mechanical 级）：执行前复查（D1②）——命中即**不执行**，回执原文随
   * `blocked` 标志交给裁决层当失败原因（不按退出码措辞，避免误导）；
   * 复查被**跳过**（guard 不可用 / 抛错 → fail-open 放行）时照常执行，但随 `guardSkipped` 留痕（D1）。
   */
  const runCommand = async (
    cmd: string,
    frame?: FrameId,
  ): Promise<{
    code: number;
    output?: string;
    blocked?: boolean;
    guardSkipped?: true;
  }> => {
    const check = checkCommand(cmd, `task-engine{acceptance} ${frame ?? "?"}`);
    if (check.receipt !== null) {
      return { code: 1, output: check.receipt, blocked: true };
    }
    const out = await runShell(cmd);
    return check.skipped ? { ...out, guardSkipped: true } : out;
  };
  // 语义面（audit / entail）：**按次构造**——hook 闭包捕获本次工具执行的 exec（父 agent 与
  // 执行期服务解析都从它取）。宿主 `SubagentStartRequest.parent` 是必填（宿主无条件解引用
  // `parent.session`），故 requireParent=true：拿不到 agent 时 fail-closed 而不是省略 parent。
  const semantic = config?.semantic ?? {};
  /** 本引擎注册的工具名（`createTools` 产物，注册时回填）：裁决 run 按此收窄工具面 */
  let ownToolNames: string[] = [];
  /** `toolFilter` 能力位缺失的降级告警是否已打（实例级 once，避免每次裁决 run 刷屏） */
  let toolFilterDegradeWarned = false;
  /** `toolFilter` 能力位缺失的降级告警（实例级 once：裁决 / 执行 run 共用，避免逐次刷屏） */
  const warnFilterDegradedOnce = (who: string): void => {
    if (toolFilterDegradeWarned) return;
    toolFilterDegradeWarned = true;
    warn(
      `provider ${SUBAGENT_PROVIDER} 未声明 toolFilter 能力位：${who}的工具面未收窄` +
        "（仍可见 task_* 族，仅靠 prompt 约束；本条告警每个插件实例只打一次）",
    );
  };
  /** 执行期服务解析：工具执行 ctx 优先 → 回退插件 ctx（apply 期服务 fiber 常未激活） */
  const serviceResolver =
    (exec: unknown) =>
    <T>(name: string): T | undefined =>
      readService<T>(exec, name) ?? readService<T>(ctx, name);
  const semanticHooksFor = (
    exec: unknown,
  ): {
    audit?: (req: AuditRequest) => Promise<AuditVerdict>;
    entail?: EntailHook;
  } => {
    const resolve = <T>(name: string): T | undefined =>
      readService<T>(exec, name) ?? readService<T>(ctx, name);
    const parent = (exec as { agent?: unknown } | undefined)?.agent;
    const timeoutMs = semantic.timeoutMs ?? 120_000;
    // 裁决子代理的工具面收窄（剥掉 `task_*`）：裁决方只该读证据、不该反向操作引擎与树
    const toolFilter = judgeToolFilter(ownToolNames);
    // 两侧语义门都关掉时不会跑任何裁决 run → 不告警（否则是误报）
    const semanticEnabled =
      semantic.audit !== false || semantic.entail !== false;
    if (toolFilter !== undefined && semanticEnabled) {
      // 能力位缺失 → 本次不收窄（`runChildOnce` 侧判定），实例内留一条告警（与执行 run 共用 once）
      const caps =
        resolve<SubagentsLike>("subagents")?.getProvider?.(
          SUBAGENT_PROVIDER,
        )?.capabilities;
      if (caps?.toolFilter !== true)
        warnFilterDegradedOnce("裁决 / 执行子代理");
    }
    const audit: (req: AuditRequest) => Promise<AuditVerdict> = async (req) => {
      const out = await runChildOnce(
        { resolve, agent: parent, warn, deadline },
        {
          label: `task:audit:${req.frame}`,
          prompt: auditPrompt(req),
          requireParent: true,
          timeoutMs,
          ...(toolFilter === undefined ? {} : { toolFilter }),
          ...(req.outputSchema === undefined
            ? {}
            : { outputSchema: verdictEnvelope("pass", req.outputSchema) }),
        },
      );
      if (!out.ok) {
        return { pass: false, feedback: `audit run 不可用：${out.feedback}` };
      }
      const verdict = readVerdictValue(out);
      if (verdict === undefined) {
        return {
          pass: false,
          feedback: `audit run 输出不可解析（需 {"pass": boolean, "feedback": string}）：${truncateEvidence(out.text).slice(0, 300)}`,
        };
      }
      return {
        pass: verdict["pass"] === true,
        ...(typeof verdict["feedback"] === "string"
          ? { feedback: String(verdict["feedback"]).slice(0, 500) }
          : {}),
        ...(verdict["structured"] === undefined
          ? {}
          : { structured: verdict["structured"] }),
      };
    };
    const entail: EntailHook = async (parentFrame, children) => {
      const out = await runChildOnce(
        { resolve, agent: parent, warn, deadline },
        {
          label: `task:entail:${parentFrame.id}`,
          prompt: entailPrompt(
            {
              id: parentFrame.id,
              title: parentFrame.title,
              spec: parentFrame.spec,
              acceptance: parentFrame.acceptance,
            },
            children,
          ),
          requireParent: true,
          timeoutMs,
          ...(toolFilter === undefined ? {} : { toolFilter }),
          outputSchema: verdictEnvelope("ok"),
        },
      );
      if (!out.ok) {
        // 裁决 run 跑不起来 ≠ 模型判出不成立：跳过该门（不烧重试预算），并在告警里留痕
        warn(`entail run 不可用，已跳过语义蕴含门：${out.feedback}`);
        return {
          ok: true,
          skipped: true,
          feedback: `entail run 不可用，已跳过语义蕴含门：${out.feedback}`,
        };
      }
      const verdict = readVerdictValue(out);
      if (verdict === undefined) {
        warn("entail run 输出不可解析，已跳过语义蕴含门");
        return {
          ok: true,
          skipped: true,
          feedback: `entail run 输出不可解析，已跳过语义蕴含门：${truncateEvidence(out.text).slice(0, 300)}`,
        };
      }
      return {
        ok: verdict["ok"] === true,
        feedback:
          typeof verdict["feedback"] === "string"
            ? String(verdict["feedback"]).slice(0, 500)
            : verdict["ok"] === true
              ? "语义蕴含成立"
              : "子项验收不能推出父验收",
      };
    };
    return {
      ...(semantic.audit === false ? {} : { audit }),
      ...(semantic.entail === false ? {} : { entail }),
    };
  };
  const toolCtx: ToolExecuteCtx = {
    makeSemanticHooks: (exec: unknown) => semanticHooksFor(exec),
    makeApprove: approveVia,
    makeExecutor: (exec) => {
      const agent = (exec as { agent?: unknown } | undefined)?.agent;
      return makeExecutor({
        resolve: serviceResolver(exec),
        runShell,
        checkCommand,
        isolator: worktrees,
        ...(agent === undefined ? {} : { agent }),
        ownToolNames: () => ownToolNames,
        onFilterDegraded: warnFilterDegradedOnce,
        deadline,
        warn,
      });
    },
  };

  let engine: TaskEngine;
  try {
    engine = new TaskEngine({
      root: normalizeRoot(config?.root),
      runCommand,
      gate: {
        ...(config?.maxConcurrent === undefined
          ? {}
          : { maxConcurrent: config.maxConcurrent }),
        ...(config?.maxRetries === undefined
          ? {}
          : { maxRetries: config.maxRetries }),
      },
      snapshotPath: config?.snapshotPath,
      // 终态钩子（隔离回收）：帧 done（stop / join 续体）或 failed（重试耗尽）时触发；
      // 注记（含回收失败保留现场的路径）进事件流与 stop 返回，并在此另行告警（不静默）
      onFrameTerminal: async (frameId, status) => {
        const notice = await worktrees.reclaim(frameId);
        if (notice !== undefined)
          warn(`${notice}（帧 ${frameId} 已 ${status}）`);
        return notice;
      },
      // 语义 hook 走**按次注入**（tools 层用本次 exec 构造）；实例级不注入，避免跨会话串线
    });
  } catch (err) {
    warn(`引擎初始化失败：${String(err)}`);
    return;
  }

  const tools = createTools(engine, toolCtx);
  // 裁决 run 的 toolFilter 按**实际注册成功**的工具名构造（宿主 `restrict()` 对未知全局工具名
  // 抛错 → 名字写错 / 没注册成功会让裁决 run 直接发起失败；注册是 best-effort、`ctx.tools`
  // 缺失时整段跳过，故一个都没注册成功就交空名单 = 不收窄）
  const registeredNames: string[] = [];
  if (toolsSvc !== undefined && typeof toolsSvc.register === "function") {
    for (const t of tools) {
      try {
        toolsSvc.register(toDshTool(t));
        registeredNames.push(t.name);
      } catch (err) {
        warn(`工具 ${t.name} 注册失败：${String(err)}`);
      }
    }
  }
  ownToolNames = registeredNames;

  // 只读查询面挂到 ctx（防御降级，与 metric-loop/C5 同款）：供 TUI /task 接线
  const provideSvc = (
    ctx as { provide?: (name: string, value: unknown) => unknown }
  ).provide;
  if (typeof provideSvc === "function") {
    provideSvc("taskEngine", {
      query: () => engine.query(),
      frameStack: () => engine.frameStack(),
    });
  }

  // cordis 生命周期：unload 时写最终快照 + best-effort 回收在册隔离工作区
  // （未 stop / 未失败的在途帧不会走终态钩子，这里是兜底；不带 --force，脏树天然被拒 → 保留现场）
  const ctxAny = ctx as { effect?: (fn: () => unknown) => unknown };
  ctxAny.effect?.(() => async () => {
    await engine.writeSnapshot();
    const notices = await worktrees.reclaimAll();
    for (const notice of notices) warn(`${notice}（插件卸载收尾）`);
  });
}
