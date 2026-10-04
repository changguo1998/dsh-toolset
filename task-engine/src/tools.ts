// src/tools.ts — 模型侧工具族：task_decompose / task_implement / task_execute /
// task_stop / task_status（+ 嵌套任务列表：parent_id + order）
//
// 零 DSH 依赖的纯数据 + 处理器：工具定义供 cordis 适配层结构注册（main.ts），
// 也供 demo/tests 直接调用。JSON 参数在此做最小校验，拒绝时返回带反馈结果。
// 第二迭代（BACKLOG #5/#13）：decompose 解析 deps/output_schema；
// stop 输出 step 级 accepted/next 裁决（打回 next 指向本帧，终态 null）。

import type { AuditRequest, AuditVerdict } from "./acceptance.ts";
import type { EntailHook, ExecutorRunner, TaskEngine } from "./engine.ts";
import { validateExecutor } from "./gate.ts";
import type {
  Acceptance,
  AcceptanceLevel,
  ChildSpec,
  ExecutorSpec,
  FrameId,
  NestedTaskItem,
} from "./types.ts";

export interface ToolExecuteCtx {
  /** 真实链路：审批请求构造器（demo 直接用 approve） */
  makeApprove?: (
    exec: unknown,
  ) => (req: { frame: FrameId; reason: string }) => Promise<boolean>;
  /** 真实链路：executor 适配器构造器（按当前工具调用的 agent 构造；缺省 = engine 内建适配器） */
  makeExecutor?: (exec: unknown) => ExecutorRunner | undefined;
  /** 真实链路：按当前工具执行构造语义面 hook（audit / entail；见 main.ts 的按次构造） */
  makeSemanticHooks?: (exec: unknown) => {
    audit?: (req: AuditRequest) => Promise<AuditVerdict>;
    entail?: EntailHook;
  };
}

export interface TaskToolDef {
  name: string;
  description: string;
  /** 简化参数 schema（属性式，与 dsh defineTool 同构） */
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
}

const LEVELS: readonly AcceptanceLevel[] = ["mechanical", "semantic", "human"];

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseAcceptance(raw: unknown): Acceptance[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Acceptance[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return undefined;
    const o = item as Record<string, unknown>;
    const id = asString(o.id);
    const check = asString(o.check);
    const level = o.level;
    if (
      id === undefined ||
      check === undefined ||
      !LEVELS.includes(level as AcceptanceLevel)
    ) {
      return undefined;
    }
    const command = asString(o.command);
    const outputSchema = o.output_schema;
    out.push({
      id,
      check,
      level: level as AcceptanceLevel,
      ...(command === undefined ? {} : { command }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
    });
  }
  return out;
}

/** 子任务列表里第一个非法 executor 的可读原因（用于精确打回反馈）；全合法返回 null */
function executorRejection(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (o["executor"] === undefined) continue;
    const id = asString(o.id) ?? "?";
    const bad = validateExecutor(o["executor"]);
    if (bad !== null) return `子任务「${id}」的 executor 非法：${bad}`;
  }
  return null;
}

/** 把工具入参转成 ChildSpec[]；格式非法返回 undefined（打回带格式反馈） */
function parseChildren(raw: unknown): ChildSpec[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ChildSpec[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return undefined;
    const o = item as Record<string, unknown>;
    const id = asString(o.id);
    const title = asString(o.title);
    const spec = asString(o.spec);
    if (id === undefined || title === undefined || spec === undefined)
      return undefined;
    const acceptance = parseAcceptance(o.acceptance);
    if (acceptance === undefined) return undefined;
    const needDecompose =
      typeof o.need_decompose === "boolean" ? o.need_decompose : false;
    const coverageRaw = o.coverage;
    const coverage: Record<string, FrameId[]> = {};
    if (coverageRaw !== undefined) {
      if (typeof coverageRaw !== "object" || coverageRaw === null)
        return undefined;
      for (const [k, v] of Object.entries(
        coverageRaw as Record<string, unknown>,
      )) {
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
          return undefined;
        coverage[k] = v as FrameId[];
      }
    }
    // 前置传递 deps（§17.2）：字符串数组，合法性由门禁裁决（只允许前序兄弟）
    const depsRaw = o.deps;
    let deps: FrameId[] | undefined;
    if (depsRaw !== undefined) {
      if (!Array.isArray(depsRaw) || depsRaw.some((x) => typeof x !== "string"))
        return undefined;
      deps = depsRaw as FrameId[];
    }
    // executor 声明（①）：结构校验在此（值域校验由门禁统一裁决）
    const executorRaw = o.executor;
    let executor: ExecutorSpec | undefined;
    if (executorRaw !== undefined) {
      if (validateExecutor(executorRaw) !== null) return undefined;
      executor = executorRaw as ExecutorSpec;
    }
    out.push({
      id,
      title,
      spec,
      acceptance,
      needDecompose,
      coverage,
      ...(deps === undefined ? {} : { deps }),
      ...(executor === undefined ? {} : { executor }),
    });
  }
  return out;
}

function ok(v: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, ...v };
}
function fail(feedback: string): Record<string, unknown> {
  return { ok: false, feedback };
}

/** 折叠轮的根视图：`truncated` / `descendantCount` 只在旧轮根上出现 */
type StatusRoundView = NestedTaskItem & {
  truncated?: true;
  descendantCount?: number;
};

/** 后代帧数（不含自身） */
function countDescendants(node: NestedTaskItem): number {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

/** task_status 默认视图：只展开当前轮（末项），旧轮折叠为根摘要（防多轮后森林全量膨胀） */
function statusView(forest: NestedTaskItem[]): StatusRoundView[] {
  const last = forest.length - 1;
  return forest.map((node, i): StatusRoundView => {
    if (i === last) return node;
    return {
      ...node,
      children: [],
      truncated: true,
      descendantCount: countDescendants(node),
    };
  });
}

/** 构造工具族（绑定一个引擎实例） */
export function createTools(
  engine: TaskEngine,
  ctx: ToolExecuteCtx = {},
): TaskToolDef[] {
  const approveFor = (
    exec: unknown,
  ): ((req: { frame: FrameId; reason: string }) => Promise<boolean>) =>
    ctx.makeApprove ? ctx.makeApprove(exec) : async () => false;

  const decompose = (name: string, description: string): TaskToolDef => ({
    name: `task_${name}`,
    description,
    parameters: {
      ...(name === "status"
        ? {}
        : name === "decompose"
          ? {
              parent_id: {
                type: "string",
                required: true,
                description: "要拆分的父任务 id",
              },
              children: {
                type: "array",
                required: true,
                description:
                  "子任务列表：{id, title, spec, acceptance, need_decompose, coverage, deps}",
              },
            }
          : name === "implement"
            ? {
                task_id: {
                  type: "string",
                  required: true,
                  description: "叶子任务 id",
                },
                result: {
                  type: "string",
                  required: true,
                  description: "实现产出（写回父帧）",
                },
              }
            : {
                task_id: {
                  type: "string",
                  required: true,
                  description: "要验收停止的任务 id",
                },
              }),
    },
    async execute(args, exec) {
      switch (name) {
        case "decompose": {
          const parentId = asString(args.parent_id);
          const children = parseChildren(args.children);
          if (parentId === undefined || children === undefined) {
            const detail = executorRejection(args.children);
            return fail(
              "task_decompose 参数非法：需 parent_id 与合法 children（含 id/title/spec/acceptance）" +
                (detail === null ? "。" : `；${detail}。`),
            );
          }
          const semantic = ctx.makeSemanticHooks?.(exec);
          const r = await engine.decompose(
            parentId,
            children,
            semantic?.entail,
          );
          // step 级裁决（#5）：accepted/next 原样透出给模型（打回时 next 指向重做目标）
          return r.ok
            ? ok({ accepted: r.accepted, next: r.next })
            : {
                ok: false,
                accepted: r.accepted,
                next: r.next,
                feedback: r.feedback ?? "",
              };
        }
        case "implement": {
          const taskId = asString(args.task_id);
          const result = asString(args.result);
          if (taskId === undefined || result === undefined) {
            return fail("task_implement 参数非法：需 task_id 与 result。");
          }
          return engine.implement(taskId, result);
        }
        case "stop": {
          const taskId = asString(args.task_id);
          if (taskId === undefined)
            return fail("task_stop 参数非法：需 task_id。");
          const semantic = ctx.makeSemanticHooks?.(exec);
          const r = await engine.stop(taskId, {
            approve: approveFor(exec),
            ...(semantic?.audit === undefined ? {} : { audit: semantic.audit }),
          });
          // step 级裁决（#5）：accepted/next 透出；打回 next 指向本帧（重做）。
          // 成功路径也可能带 feedback 注记（如「复查不可用，验收命令未复查即执行」的留痕）→ 不吞掉。
          return r.ok
            ? ok({
                accepted: r.accepted,
                next: r.next,
                ...(r.feedback === undefined ? {} : { feedback: r.feedback }),
              })
            : {
                ok: false,
                accepted: r.accepted,
                next: r.next,
                feedback: r.feedback ?? "",
              };
        }
        default: {
          const forest = engine.nested();
          return { ok: true, rounds: forest.length, tree: statusView(forest) };
        }
      }
    },
  });

  /** ① 发起 executor 后端（引擎只做发起 / 证据回填；验收仍走 task_stop） */
  const execute: TaskToolDef = {
    name: "task_execute",
    description:
      "发起叶子任务声明的 executor 后端（subagent / workflow / command）并把执行证据回填到该帧；" +
      "model 后端 = 本会话执行，请改用 task_implement。回填后仍需 task_stop 做 RET 验收。",
    parameters: {
      task_id: {
        type: "string",
        required: true,
        description: "叶子任务 id（须声明非 model 的 executor）",
      },
    },
    async execute(args, exec) {
      const taskId = asString(args.task_id);
      if (taskId === undefined)
        return fail("task_execute 参数非法：需 task_id。");
      const r = await engine.execute(taskId, ctx.makeExecutor?.(exec));
      return r.ok
        ? ok({
            accepted: r.accepted,
            next: r.next,
            ...(r.evidence === undefined ? {} : { evidence: r.evidence }),
            ...(r.usage === undefined ? {} : { usage: r.usage }),
          })
        : {
            ok: false,
            accepted: r.accepted,
            next: r.next,
            feedback: r.feedback ?? "",
          };
    },
  };

  return [
    decompose(
      "decompose",
      "把一个待细化任务拆成子任务（每次只细化一层；机械+语义蕴含双门禁通过才挂树）。" +
        '多轮：对**已完成的当前轮根**再分解会**自动开新一轮**（新根 `root-2` / `root-3…`，沿用同一根契约，旧轮只读保留；跨轮子帧 id 必须唯一）；`parent_id: "root"` 始终指当前轮根',
    ),
    decompose("implement", "完成一个叶子任务并写入产出"),
    execute,
    decompose(
      "stop",
      "对任务执行 RET 验收（mechanical/human/semantic），通过则完成并向上 join，返回 accepted/next",
    ),
    decompose(
      "status",
      "查看嵌套任务树（parent_id + order，先序；含 executorKind）。多轮会话返回**森林**：" +
        "`rounds` = 已开启轮数（= 当前轮号），`tree` 每轮一棵、树根带 `round`（id 里跳号不代表轮次）。" +
        "为省 token，**只展开当前轮（末项）**：更早的轮折叠为根摘要——`children: []` + " +
        "`descendantCount`（被折叠的后代帧数）+ `truncated: true`；`truncated` 表示该轮子树未展开" +
        "（帧不缺），**本工具不提供取回**，旧轮只读、历史细节在事件流 / 追踪文档里；" +
        "当前轮**不带** `truncated`（缺省，非 false）",
    ),
  ];
}
