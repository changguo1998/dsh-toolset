/**
 * index — cordis 插件入口（DSH bundle 接入面，零 DSH 运行时依赖，结构式访问）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / inject / Config / apply，Config 以类型声明给出（interface Config；无运行时 schema，
 * 宿主不校验，配置原样透传给 apply；缺省/非法值沿用本包既有语义，不新增校验）。无 default export。
 * 与 task-engine/src/index.ts 同模式：惰性防御，ctx.tools 缺失时告警降级不抛错，保证 dsh 加载本 bundle 不崩。
 *
 * 注册两个模型侧工具：
 * - hash_read: 读取文件行并返回 LINE:HASH 锚点（锚定编辑的锚点来源）
 * - hash_edit: 批量应用锚定编辑（set_line/replace_lines/insert_after/delete_line）；
 *   校验失败（malformed/out_of_range/stale_anchors/overlapping_edits）返回结构化错误
 *   （stale 含全部失效锚点 + expected/actual），不抛异常，供模型重新取锚点重试。
 *
 * 复用说明：文件读写只经 `HashFileIo`（`hash-edit/src/io.ts`）：插件侧由 `apply` 注入 `ctx.fs`
 * 实现（`hash-edit/src/ctx-fs-io.ts`），库面 / demo / 单测缺省用 node 标准库实现；
 * 行级锚定与后端文件级版本守卫互补。
 */

export * from "./hashline.ts";
export * from "./edit.ts";
export * from "./io.ts";
export * from "./ctx-fs-io.ts";
export * from "./fs.ts";

// 本地引用（export * 只产生 re-export，不产生本模块绑定）
import { AnchoredEditError, type EditOp } from "./edit.ts";
import {
  ctxHashFileIo,
  resolveExecCwd,
  type HashExecLike,
  type HashFsHostLike,
} from "./ctx-fs-io.ts";
import type { HashFileIo } from "./io.ts";
import { nodeHashFileIo } from "./io.ts";
import { FileEditError, applyAnchoredEditsFile, readHashlines } from "./fs.ts";

/** 插件名（dsh 宿主挂载标识，对应 cordis.patch.yml 的 id）。 */
export const name = "hash-edit";

/** 注入面：tools 注册工具; fs 是 hash_read / hash_edit 的文件读写面（缺它时调用返回可行动错误）。 */
export const inject = ["tools", "fs"];

/** 插件配置（bundle 契约 Config）。 */
export interface Config {
  /** 相对路径解析基准目录（显式配置优先；缺省按调用会话 cwd, 无宿主面时交给 io 自己的基准）。 */
  root?: string;
}

/** 工具装配选项：宿主面（决定 `ctx.fs` / 会话 cwd）与按调用构造 io 的工厂。 */
export interface ToolOptions {
  /** 宿主面：`fs` 走官方围栏, `workingDirectory` 给相对路径基准。 */
  host?: HashFsHostLike;
  /** 按调用上下文构造 io; 缺省用 `nodeHashFileIo()`（库面 / 单测口径）。 */
  ioFor?: (exec?: HashExecLike) => HashFileIo;
}

/** dsh 工具注册器（结构式访问，避免 import dsh 包）。 */
interface ToolRegistrar {
  register(def: unknown): void;
}

/** dsh 内容块（结构式类型，render 返回值的最小约定）。 */
interface ContentBlock {
  type: "text";
  text: string;
}

/** 工具执行入参（dsh 侧为已解析的 JSON 参数对象）。 */
type ToolArgs = Record<string, unknown>;

interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
  execute(args: ToolArgs, exec?: unknown): Promise<ToolArgs>;
}

/** 提交给 dsh 宿主的工具对象形态（宿主侧结构式消费，无 dsh 包类型依赖）。 */
interface DshTool {
  name: string;
  description: string;
  parameters: unknown;
  /** 宿主按 `execute(exec.arguments, exec)` 双参调用（会话上下文经第二参传入）。 */
  execute: (args: ToolArgs, exec?: unknown) => Promise<ToolArgs>;
  output: {
    schema: {
      type: "object";
      additionalProperties: boolean;
      properties: Record<string, never>;
    };
    render: (args: unknown, value: unknown) => ContentBlock[];
  };
}

/** 把内部 ToolDef 适配为 dsh 工具形态（render 输出 JSON 文本，对照 task-engine）。 */
function toDshTool(def: ToolDef): DshTool {
  return {
    name: def.name,
    description: def.description,
    parameters: compileParameters(def.parameters),
    execute: (args: ToolArgs, exec?: unknown) => def.execute(args, exec),
    output: {
      // dsh ToolOutputDefinition 强制 output.schema（对照 task-engine/metric-loop 对齐形态）
      schema: { type: "object", additionalProperties: true, properties: {} },
      // 宿主契约：`output.render(exec.arguments, value)`（args 第一、value 第二；
      // 单形参会让模型只拿到入参回显——本包曾因此让 LINE:HASH 锚点到不了模型）
      render: (_args: unknown, value: unknown): ContentBlock[] => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/** JSON 文本；`JSON.stringify` 对 `undefined` / 函数等返回 `undefined`，退化为 `String`（render 必须全函数）。 */
function jsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return typeof text === "string" ? text : String(value);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) ? v : undefined;
}

/**
 * 将作者友好的参数 property-map 编译成网关接受的 JSON Schema。
 * dsh 官方工具经 defineTool→parameterSchemaSpecToJsonSchema 产出
 * {type:"object", properties, required}；本 bundle 独立注册需自补这一层，
 * 否则 Ark/OpenAI 兼容网关收到顶层无 type 的裸 map，报
 * "schema must be a JSON Schema of 'type: \"object\"', got 'type: null'"。
 * 对本身已是 JSON Schema（顶层带 type:"object"）的输入保持幂等原样返回。
 */
/** 编译后的工具参数 JSON Schema（网关/宿主接收的顶层 object schema）。 */
interface ToolParametersSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

function compileParameters(spec: unknown): ToolParametersSchema {
  if (
    typeof spec === "object" &&
    spec !== null &&
    "type" in (spec as Record<string, unknown>)
  ) {
    return spec as ToolParametersSchema;
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(
    spec as Record<string, { required?: boolean; [k: string]: unknown }>,
  )) {
    const { required: isRequired, ...rest } = value;
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
const HASH_READ_PARAMS = {
  path: {
    type: "string",
    required: true,
    description: "目标文件路径（绝对路径，或相对 config.root / 会话 cwd）",
  },
  offset: {
    type: "number",
    description: "起始行号（1 基，缺省 1）",
  },
  limit: {
    type: "number",
    description: "返回行数上限（缺省 200）",
  },
} as const;

const EDIT_ITEM_PARAMS = {
  type: "object",
  properties: {
    set_line: {
      type: "object",
      description: "替换单行（anchor + new_text）",
      properties: {
        anchor: {
          type: "string",
          description: "LINE:HASH 锚点（1 基行号:8 位 hex）",
        },
        new_text: {
          type: "string",
          description: "替换后的行内容（可含换行展开多行；空串 = 该行变空行）",
        },
      },
      required: ["anchor", "new_text"],
      additionalProperties: false,
    },
    replace_lines: {
      type: "object",
      description: "替换连续区间（start_anchor + end_anchor + new_text）",
      properties: {
        start_anchor: { type: "string", description: "区间起始行锚点" },
        end_anchor: {
          type: "string",
          description: "区间结束行锚点（>= 起始行）",
        },
        new_text: {
          type: "string",
          description: "替换后的内容（可含换行；空串 = 纯删除该区间）",
        },
      },
      required: ["start_anchor", "end_anchor", "new_text"],
      additionalProperties: false,
    },
    insert_after: {
      type: "object",
      description: "在锚点行之后插入（anchor + new_text）",
      properties: {
        anchor: {
          type: "string",
          description: "在其后插入的行锚点（锚末行 = 追加到文件尾）",
        },
        new_text: {
          type: "string",
          description: "插入的内容（可含换行展开多行；空串 = 无操作）",
        },
      },
      required: ["anchor", "new_text"],
      additionalProperties: false,
    },
    delete_line: {
      type: "object",
      description: "删除单行（anchor）",
      properties: {
        anchor: { type: "string", description: "要删除的行锚点" },
      },
      required: ["anchor"],
      additionalProperties: false,
    },
  },
} as const;

// 编辑指令数组的 items 为对象 value schema（subset 支持 items + object properties）。
const HASH_EDIT_PARAMS = {
  path: {
    type: "string",
    required: true,
    description: "目标文件路径（绝对路径，或相对 config.root / 会话 cwd）",
  },
  edits: {
    type: "array",
    required: true,
    description:
      "编辑指令列表（每条恰好一个变体键；行号均锚定 hash_read 读取时的原始内容，可一次提交多条）",
    items: EDIT_ITEM_PARAMS,
  },
} as const;

/** 校验 edits 数组形状（供模型侧错误定位；核心校验仍在 `hash-edit/src/edit.ts` 纯函数内）。 */
function coerceEdits(raw: unknown): { ops: EditOp[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ops: [], error: "edits must be a non-empty array" };
  }
  const ops: EditOp[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "object" || item === null) {
      return { ops: [], error: `edits[${i}] must be an object` };
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    const variants = [
      "set_line",
      "replace_lines",
      "insert_after",
      "delete_line",
    ];
    if (keys.length !== 1 || !variants.includes(keys[0] ?? "")) {
      return {
        ops: [],
        error: `edits[${i}] must contain exactly one of: ${variants.join(", ")}`,
      };
    }
    const body = record[keys[0] as string];
    if (typeof body !== "object" || body === null) {
      return { ops: [], error: `edits[${i}].${keys[0]} must be an object` };
    }
    ops.push({ [keys[0] as string]: body } as EditOp);
  }
  return { ops };
}

/**
 * 构造工具定义。
 * @param root 显式 config.root（相对路径基准）; 未配置 / 空串按调用会话 cwd 解析。
 * @param options 宿主面与 io 工厂; 都不给时走 `nodeHashFileIo()`（库面 / 单测口径）。
 */
function createTools(
  root: string | undefined,
  options: ToolOptions = {},
): ToolDef[] {
  /** 显式配置的基准（空串按未配置, 仓库惯例对照 fs-digest / md-logic）。 */
  const configuredRoot = root !== undefined && root !== "" ? root : undefined;
  /**
   * 本次调用的读写面与基准：库面 node 实现需要在这里先取会话目录;
   * `ctx.fs` 实现的 resolve 自己按会话解析, 只在显式配置时把 root 传下去。
   */
  const ioFor = async (
    exec: HashExecLike | undefined,
  ): Promise<{ io: HashFileIo; cwd: string | undefined }> => {
    if (options.ioFor !== undefined) {
      return { io: options.ioFor(exec), cwd: configuredRoot };
    }
    const base =
      configuredRoot ?? (await resolveExecCwd(options.host ?? {}, exec));
    return {
      io: nodeHashFileIo(base === undefined ? {} : { cwd: base }),
      cwd: base,
    };
  };
  const hashRead: ToolDef = {
    name: "hash_read",
    description:
      "用途: 读取文件的行内容并返回 LINE:HASH 锚点(每行: 1 基行号:sha256 前 8 位 hex), 是 hash_edit 的输入。\n" +
      "用法: 缺省从第 1 行起读 200 行, 更长文件用 offset / limit 分段读取。\n" +
      "效果: 返回 { ok, path, file_hash, line_count, hashlines }; hashlines 每项 { line, hash, text }, file_hash 是全文件 sha256, 供 hash_edit 判 stale。\n" +
      "边界: 只读; 文件超过 limit 时只回前 limit 行的锚点。\n" +
      "相关: hash_edit、read。",
    parameters: HASH_READ_PARAMS,
    async execute(args, exec) {
      const path = asString(args.path);
      if (path === undefined) return { ok: false, error: "path is required" };
      const offset = asInt(args.offset) ?? 1;
      const limit = asInt(args.limit) ?? 200;
      if (offset < 1 || limit < 1) {
        return {
          ok: false,
          error: "offset and limit must be positive integers",
        };
      }
      try {
        const { io, cwd } = await ioFor(exec as HashExecLike | undefined);
        const result = await readHashlines(path, {
          io,
          ...(cwd === undefined ? {} : { cwd }),
          offset,
          limit,
        });
        // 工具面不返回内部版本令牌（模型用 LINE:HASH 与 file_hash 定位）
        return {
          ok: true,
          path: result.path,
          file_hash: result.file_hash,
          line_count: result.line_count,
          hashlines: result.hashlines,
        };
      } catch (err) {
        if (err instanceof FileEditError) {
          return { ok: false, code: err.code, error: err.message };
        }
        throw err;
      }
    },
  };

  const hashEdit: ToolDef = {
    name: "hash_edit",
    description:
      "用途: 按 LINE:HASH 锚点精确改行(set_line / replace_lines / insert_after / delete_line)。\n" +
      "用法: edits 每条恰好一个变体键; 行号锚定 hash_read 读取时的原始内容, 可一次提交多条。\n" +
      "效果: 锚点都用同一次 hash_read 的内容校验, 任一失效(stale)则整批拒绝、文件保持原样, 返回失效锚点供重新读取。\n" +
      "边界: 文件级字面量替换用 edit(带读后改前版本守卫); 按节改 Markdown 用 md_logic。\n" +
      "相关: hash_read、edit、md_logic。",
    parameters: HASH_EDIT_PARAMS,
    async execute(args, exec) {
      const path = asString(args.path);
      if (path === undefined) return { ok: false, error: "path is required" };
      const { ops, error } = coerceEdits(args.edits);
      if (error !== undefined) return { ok: false, code: "malformed", error };
      try {
        const { io, cwd } = await ioFor(exec as HashExecLike | undefined);
        const result = await applyAnchoredEditsFile(path, ops, {
          io,
          ...(cwd === undefined ? {} : { cwd }),
        });
        return { ...result };
      } catch (err) {
        if (err instanceof AnchoredEditError) {
          return {
            ok: false,
            code: err.code,
            error: err.message,
            details: err.details,
          };
        }
        if (err instanceof FileEditError) {
          return { ok: false, code: err.code, error: err.message };
        }
        throw err;
      }
    },
  };

  return [hashRead, hashEdit];
}

/**
 * bundle 装配入口（dsh 宿主按 cordis.patch.yml 的 insert 加载）。
 * ctx 为结构式访问：依赖 ctx.tools.register 与 ctx.fs（缺失时降级告警 / 调用返回可行动错误）。
 */
export async function apply(ctx: unknown, config: Config = {}): Promise<void> {
  const warn = (msg: string): void => {
    process.stderr.write(`[hash-edit] warn: ${msg}\n`);
  };
  if (ctx === null || typeof ctx !== "object") {
    warn("ctx unavailable, skipping tool registration");
    return;
  }
  const host = ctx as HashFsHostLike;
  const toolsSvc = (ctx as { tools?: ToolRegistrar }).tools;
  if (toolsSvc === undefined || typeof toolsSvc.register !== "function") {
    warn("ctx.tools unavailable, skipping tool registration");
    return;
  }
  const tools = createTools(config.root, {
    host,
    ioFor: (exec) => ctxHashFileIo(host, exec),
  });
  for (const def of tools) {
    try {
      toolsSvc.register(toDshTool(def));
    } catch (err) {
      warn(`tool ${def.name} registration failed: ${String(err)}`);
    }
  }
}
