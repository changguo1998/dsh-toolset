// src/tools.ts — 模型侧工具 `md_map`（action 分派，形状对标 code_map）。
//
// 契约：def = { name, description, parameters, execute(args, exec), output{schema, render(_args, value)} }；
// render 形参顺序为「args 第一、value 第二」，且必须是全函数（畸形值不抛）。

import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  renderCallers,
  renderImpact,
  renderIndex,
  renderOrphans,
  renderReport,
  renderSummary,
} from "./render.ts";
import type { MdEdgeKind } from "./types.ts";
import type { MdMapService } from "./service.ts";

/** callers / impact 可过滤的边种类：`external` / `broken` 无 `to`、`file` 的 `to` 是索引外的真实路径，三者都不会成为入边。 */
const CALLER_EDGE_KINDS = ["internal", "wiki", "file", "ref"] as const;

/** 工具执行上下文（宿主 `exec`，只读鸭子类型）。 */
interface ToolExecCtx {
  agent?: { session?: { header?: { cwd?: string } } };
}

/** 本次调用的相对路径基准：会话 cwd 优先，缺省进程 cwd。 */
export function resolveExecCwd(exec: unknown): string {
  const cwd = (exec as ToolExecCtx | undefined)?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

/** 字符串参数（空串视为缺省）。 */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 整数参数（非法返回 undefined）。 */
function int(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

const ACTIONS = [
  "index",
  "refresh",
  "callers",
  "impact",
  "orphans",
  "report",
  "summary",
] as const;

/** `md_map` 工具定义。 */
export function mdMapTool(service: MdMapService): unknown {
  return {
    name: "md_map",
    description:
      "Markdown 项目级结构与引用分析（对象是文档，对标 code_map）：action=index / refresh 建立索引" +
      "（默认扫当前工作目录下的 `**/*.md`，跳过 node_modules / dist / tmp 等；也可用 root 指定），" +
      'action=callers 查谁引用了某文档或某锚点（path + 可选 anchor + 可选 kind 过滤边种类，如 ["internal","wiki"] 排除 ref 噪声；默认口径含 ref），action=impact 查改这份文档会波及' +
      "哪些文档（反向引用闭包，depth 缺省 2，kind 逐层过滤），（边含**行内代码路径引用** kind:ref：如 docs/BACKLOG.md，按候选序解析；未命中不计断链、仅计入 report 的未解析 token 计数）action=orphans 查零入边文档，action=report 出总览" +
      "（文档 / 锚点 / 内部边 / 未解析 token 计数 / 断链 / 孤儿 / 被引最多），action=summary 查索引状态（含 ref 计数）。" +
      "分工：**代码结构 → code_map；单文件 Markdown 结构（节树 / 块 / 链接清单）→ md_logic；" +
      "项目级文档关系 / 影响面 / 断链 → 本工具**。行号 1 基；path 相对 root。",
    parameters: {
      type: "object",
      required: ["action"],
      additionalProperties: true,
      properties: {
        action: {
          type: "string",
          enum: [...ACTIONS],
        },
        path: {
          type: "string",
          description:
            "callers / impact 用：目标文档（相对 root 的路径，也支持唯一后缀或文件名）",
        },
        anchor: {
          type: "string",
          description:
            'callers 用：只看指向该锚点的引用（ref 边不带锚点，kind=["ref"] 时恒空）',
        },
        kind: {
          type: "array",
          items: { type: "string", enum: [...CALLER_EDGE_KINDS] },
          description:
            'callers / impact 用：只看这些边种类（缺省全部；如 ["internal","wiki"] 可排除 ref 噪声）',
        },
        depth: {
          type: "integer",
          minimum: 1,
          description: "impact 用：反向引用层数（缺省 2）",
        },
        root: {
          type: "string",
          description: "index / refresh 用：仓库根（缺省当前会话工作目录）",
        },
      },
    },
    async execute(
      args: Record<string, unknown>,
      exec?: unknown,
    ): Promise<unknown> {
      if (args === null || typeof args !== "object") {
        return { error: "入参必须是对象（含 action）" };
      }
      const action = str(args, "action") ?? "";
      if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
        return {
          error: `未知 action：${action}（可选 ${ACTIONS.join(" / ")}）`,
        };
      }

      // 参数校验先于任何 IO
      const needsPath = action === "callers" || action === "impact";
      const pathArg = str(args, "path");
      if (needsPath && pathArg === undefined) {
        return { error: `${action} 需要 path 参数` };
      }
      const depthArg = int(args, "depth");
      if (action === "impact" && depthArg !== undefined && depthArg < 1) {
        return { error: `depth 须为 >=1 的整数，收到：${String(args.depth)}` };
      }
      const depth = depthArg ?? 2;
      // kind 只对 callers / impact 有意义；手写校验（parameters 是 additionalProperties:true，
      // 裸串会被 str() 静默忽略 → 变成「不过滤」，属最坏失败模式）
      const kindArg = args["kind"];
      let kinds: MdEdgeKind[] | undefined;
      if (kindArg !== undefined) {
        if (!Array.isArray(kindArg) || kindArg.length === 0) {
          return {
            error: `kind 须为非空数组（边种类：${CALLER_EDGE_KINDS.join(" / ")}）`,
          };
        }
        const invalid = kindArg.filter(
          (k) =>
            typeof k !== "string" ||
            !CALLER_EDGE_KINDS.includes(
              k as (typeof CALLER_EDGE_KINDS)[number],
            ),
        );
        if (invalid.length > 0) {
          return {
            error: `未知边种类：${invalid.map((k) => String(k)).join(" / ")}（可选 ${CALLER_EDGE_KINDS.join(" / ")}）`,
          };
        }
        kinds = kindArg as MdEdgeKind[];
      }

      if (action === "index" || action === "refresh") {
        const rootArg = str(args, "root");
        const base = resolveExecCwd(exec);
        const root =
          rootArg === undefined
            ? base
            : isAbsolute(rootArg)
              ? rootArg
              : resolve(base, rootArg);
        let info;
        try {
          info = await stat(root);
        } catch {
          info = null;
        }
        if (info === null || !info.isDirectory()) {
          return { error: `root 不存在或不是目录：${root}` };
        }
        const index = await service.index({ root });
        return { action, index };
      }

      if (service.summary().ready !== true) {
        return { error: "未索引（先调用 action=index）" };
      }

      if (action === "callers") {
        if (!service.hasDoc(pathArg ?? "")) {
          return {
            error: `索引内没有该文档：${String(pathArg)}（先用 action=index）`,
          };
        }
        const anchor = str(args, "anchor");
        const rows = service.callers(pathArg ?? "", {
          ...(anchor === undefined ? {} : { anchor }),
          ...(kinds === undefined ? {} : { kind: kinds }),
        });
        return {
          action,
          path: pathArg,
          ...(anchor === undefined ? {} : { anchor }),
          ...(kinds === undefined ? {} : { kind: kinds }),
          callers: rows,
        };
      }
      if (action === "impact") {
        if (!service.hasDoc(pathArg ?? "")) {
          return {
            error: `索引内没有该文档：${String(pathArg)}（先用 action=index）`,
          };
        }
        const layers = service.impact(pathArg ?? "", {
          depth,
          ...(kinds === undefined ? {} : { kind: kinds }),
        });
        return {
          action,
          path: pathArg,
          depth,
          ...(kinds === undefined ? {} : { kind: kinds }),
          layers,
        };
      }
      if (action === "orphans") {
        return { action, orphans: service.orphans() };
      }
      if (action === "report") {
        return { action, report: service.report() };
      }
      return { action, summary: service.summary() };
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => {
        const result =
          value !== null && typeof value === "object"
            ? (value as {
                error?: string;
                action?: string;
                path?: string;
                anchor?: string;
                kind?: unknown;
                index?: unknown;
                callers?: unknown;
                layers?: unknown;
                orphans?: unknown;
                report?: unknown;
                summary?: unknown;
              })
            : {};
        if (typeof result.error === "string") {
          return [{ type: "text", text: `md_map 失败：${result.error}` }];
        }
        switch (result.action) {
          case "index":
          case "refresh":
            return [
              {
                type: "text",
                text: renderIndex(
                  result.index as Parameters<typeof renderIndex>[0],
                  result.action,
                ),
              },
            ];
          case "callers":
            return [
              {
                type: "text",
                text: renderCallers(
                  result.path ?? "",
                  (result.callers ?? []) as Parameters<typeof renderCallers>[1],
                  result.anchor,
                  result.kind as string[] | undefined,
                ),
              },
            ];
          case "impact":
            return [
              {
                type: "text",
                text: renderImpact(
                  result.path ?? "",
                  (result.layers ?? []) as Parameters<typeof renderImpact>[1],
                  result.kind as string[] | undefined,
                ),
              },
            ];
          case "orphans":
            return [
              {
                type: "text",
                text: renderOrphans((result.orphans ?? []) as string[]),
              },
            ];
          case "report":
            return [
              {
                type: "text",
                text:
                  result.report === undefined
                    ? "(未索引)"
                    : renderReport(
                        result.report as Parameters<typeof renderReport>[0],
                      ),
              },
            ];
          case "summary":
            return [
              {
                type: "text",
                text: renderSummary(
                  (result.summary ?? { ready: false }) as Parameters<
                    typeof renderSummary
                  >[0],
                ),
              },
            ];
          default:
            return [{ type: "text", text: "(空结果)" }];
        }
      },
    },
  };
}
