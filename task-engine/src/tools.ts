// src/tools.ts — 模型侧工具族：task_decompose / task_implement / task_stop /
// task_status + 嵌套任务列表（parent_id + order）
//
// 零 DSH 依赖的纯数据 + 处理器：工具定义供 cordis 适配层结构注册（main.ts），
// 也供 demo/tests 直接调用。JSON 参数在此做最小校验，拒绝时返回带反馈结果。
// 第二迭代（BACKLOG #5/#13）：decompose 解析 deps/output_schema；
// stop 输出 step 级 accepted/next 裁决（打回 next 指向本帧，终态 null）。

import type { TaskEngine } from "./engine.ts";
import type {
  Acceptance,
  AcceptanceLevel,
  ChildSpec,
  FrameId,
} from "./types.ts";

export interface ToolExecuteCtx {
  /** 真实链路：审批请求构造器（demo 直接用 approve） */
  makeApprove?: (
    exec: unknown,
  ) => (req: { frame: FrameId; reason: string }) => Promise<boolean>;
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
    out.push({
      id,
      title,
      spec,
      acceptance,
      needDecompose,
      coverage,
      ...(deps === undefined ? {} : { deps }),
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
    async execute(args) {
      switch (name) {
        case "decompose": {
          const parentId = asString(args.parent_id);
          const children = parseChildren(args.children);
          if (parentId === undefined || children === undefined) {
            return fail(
              "task_decompose 参数非法：需 parent_id 与合法 children（含 id/title/spec/acceptance）。",
            );
          }
          const r = await engine.decompose(parentId, children);
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
          const r = await engine.stop(taskId, {
            approve: approveFor(undefined),
          });
          // step 级裁决（#5）：accepted/next 透出；打回 next 指向本帧（重做）
          return r.ok
            ? ok({ accepted: r.accepted, next: r.next })
            : {
                ok: false,
                accepted: r.accepted,
                next: r.next,
                feedback: r.feedback ?? "",
              };
        }
        default:
          return { ok: true, tree: engine.nested() };
      }
    },
  });

  return [
    decompose(
      "decompose",
      "把一个待细化任务拆成子任务（每次只细化一层；机械+语义蕴含双门禁通过才挂树）",
    ),
    decompose("implement", "完成一个叶子任务并写入产出"),
    decompose(
      "stop",
      "对任务执行 RET 验收（mechanical/human/semantic），通过则完成并向上 join，返回 accepted/next",
    ),
    decompose("status", "查看当前嵌套任务树（parent_id + order，先序）"),
  ];
}
