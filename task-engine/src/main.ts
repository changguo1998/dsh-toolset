// src/main.ts — cordis 插件入口（零 DSH 运行时依赖，结构面访问）
//
// 与 TUI/src/main.ts 同模式：导出 `{ name, inject, apply }`，不导 Config
//（不引入 schemastery）。惰性、防御：可选服务（approval/tools）缺失时降级
// 告警而非抛错；工具注册按结构面构造，失败只告警——保证 dsh 加载本 bundle 时不崩。
//
// 已知边界（README 注明）：v1 单执行器、单会话实例；验收命令由本插件以
// /bin/sh -c 执行（信任契约内命令）；human 级审批在工具 execute 内调用
// ctx.approval.request（工具执行发生在 open turn 内，满足 turn-enclosed）。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TaskEngine, type RootSpec } from "./engine.ts";
import { createTools, type TaskToolDef, type ToolExecuteCtx } from "./tools.ts";
import type { Acceptance, AcceptanceLevel } from "./types.ts";

export const name = "@dsh-toolset/dsh-task-engine";
export const inject = ["tools"];

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
  /** mechanical 验收命令超时（ms，默认 30s） */
  commandTimeoutMs?: number;
  /** fan-out 并发上限（BACKLOG #13，默认 4）：active 帧数达上限时不再弹栈 */
  maxConcurrent?: number;
}

const LEVELS: readonly AcceptanceLevel[] = ["mechanical", "semantic", "human"];

function isLevel(v: string): v is AcceptanceLevel {
  return (LEVELS as readonly string[]).includes(v);
}

const execFileAsync = promisify(execFile);

/** 真实链路 mechanical 验收：/bin/sh -c 执行，退出码 0 = 通过 */
function makeRunCommand(timeoutMs: number) {
  return async (cmd: string): Promise<{ code: number; output?: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", cmd], {
        timeout: timeoutMs,
      });
      return { code: 0, output: String(stdout) + String(stderr) };
    } catch (err) {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      const code = typeof e.code === "number" ? e.code : 1;
      return { code, output: String(e.stdout ?? "") + String(e.stderr ?? "") };
    }
  };
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

/** 结构面适配：把纯工具定义转成 dsh tools.register 接受的形态 */
function toDshTool(def: TaskToolDef) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    async execute(args: Record<string, unknown>, exec: unknown) {
      return def.execute(args, exec);
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      // dsh 0.1.5 ToolOutputDefinition 强制要求 render（args/value → ContentBlock[]）；
      // 结构面最小实现：把规范化 JSON 值序列化为文本块。（SAFETY: value 为
      // JsonValue，JSON.stringify 不会抛循环引用；超大值由宿主 materialize 截断。）
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: JSON.stringify(value) },
      ],
    },
  };
}

interface ToolsRegistrar {
  register(def: unknown): void;
}

interface ApprovalLike {
  request(req: {
    agent?: unknown;
    toolName: string;
    callId?: string;
    reason?: string;
    signal?: unknown;
  }): Promise<unknown>;
}

export async function apply(ctx: unknown, config?: Config): Promise<void> {
  const warn = (msg: string): void => {
    process.stderr.write(`[dsh-task-engine] warn: ${msg}\n`);
  };
  const toolsSvc: ToolsRegistrar | undefined = (
    ctx as { tools?: ToolsRegistrar }
  ).tools;
  if (toolsSvc === undefined || typeof toolsSvc.register !== "function") {
    warn("ctx.tools 不可用，跳过工具注册");
  }

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
  const toolCtx: ToolExecuteCtx = { makeApprove: approveVia };

  let engine: TaskEngine;
  try {
    engine = new TaskEngine({
      root: normalizeRoot(config?.root),
      runCommand: makeRunCommand(config?.commandTimeoutMs ?? 30_000),
      gate: {
        ...(config?.maxConcurrent === undefined
          ? {}
          : { maxConcurrent: config.maxConcurrent }),
      },
      snapshotPath: config?.snapshotPath,
    });
  } catch (err) {
    warn(`引擎初始化失败：${String(err)}`);
    return;
  }

  const tools = createTools(engine, toolCtx);
  if (toolsSvc !== undefined && typeof toolsSvc.register === "function") {
    for (const t of tools) {
      try {
        toolsSvc.register(toDshTool(t));
      } catch (err) {
        warn(`工具 ${t.name} 注册失败：${String(err)}`);
      }
    }
  }

  // cordis 生命周期：unload 时写最终快照
  const ctxAny = ctx as { effect?: (fn: () => unknown) => unknown };
  ctxAny.effect?.(() => () => {
    void engine.writeSnapshot();
  });
}
