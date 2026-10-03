/**
 * main — cordis 插件入口（DSH bundle 接入面，零 DSH 运行时依赖，结构式访问）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / inject / Config / apply，Config 以类型声明给出（interface Config；无运行时 schema，
 * 宿主不校验，配置原样透传给 apply；缺省/非法值沿用本包既有语义，不新增校验）。无 default export。
 * 与 task-engine/src/main.ts 同模式：惰性防御，ctx.tools 缺失时告警降级不抛错，保证 dsh 加载本 bundle 不崩。
 *
 * 注册两个模型侧工具：
 * - hash_read: 读取文件行并返回 LINE:HASH 锚点（锚定编辑的锚点来源）
 * - hash_edit: 批量应用锚定编辑（set_line/replace_lines/insert_after/delete_line）；
 *   校验失败（malformed/out_of_range/stale_anchors/overlapping_edits）返回结构化错误
 *   （stale 含全部失效锚点 + expected/actual），不抛异常，供模型重新取锚点重试。
 *
 * 复用说明：文件读写底座在 DSH 宿主内即 tool-fs（本包 fs.ts 为标准库薄封装，
 * 供独立测试/demo）；行级锚定与 fs-observation-policy 的版本号守护互补。
 */

export * from "./hashline.ts";
export * from "./edit.ts";
export * from "./fs.ts";

// 本地引用（export * 只产生 re-export，不产生本模块绑定）
import { AnchoredEditError, type EditOp } from "./edit.ts";
import { FileEditError, applyAnchoredEditsFile, readHashlines } from "./fs.ts";

/** 插件名（dsh 宿主挂载标识，对应 cordis.patch.yml 的 id）。 */
export const name = "hash-edit";

/** 本插件声明的依赖宿主服务（dsh 启动时注入 ctx.tools）。 */
export const inject = ["tools"];

/** 插件配置（bundle 契约 Config）。 */
export interface Config {
  /** 相对路径解析基准目录（显式配置优先；缺省按调用会话 cwd，无会话上下文回退进程 cwd）。 */
  root?: string;
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

/** 工具执行上下文（宿主 `exec` 第二实参，只读鸭子类型）。 */
interface ToolExecCtx {
  agent?: { session?: { header?: { cwd?: string } } };
}

/**
 * 本次工具调用的会话 cwd（相对路径解析基准）。口径对齐宿主 tool-fs 与本仓
 * fs-digest / md-logic：`exec.agent.session.header.cwd`；宿主未传 exec / 无会话 cwd
 * → 回退 `process.cwd()`（裸进程语义）。勿改读 `ctx.cwd`——cordis 代理上未 inject
 * 的属性读取会直接抛错（fs-digest 的 D1 教训）。
 */
function resolveExecCwd(exec: unknown): string {
  const cwd = (exec as ToolExecCtx | undefined)?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

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

/** 校验 edits 数组形状（供模型侧错误定位；核心校验仍在 edit.ts 纯函数内）。 */
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

/** 构造两个工具定义（root = 显式 config.root；未配置 / 空串按调用会话 cwd 解析相对路径，缺省进程 cwd）。 */
function createTools(root: string | undefined): ToolDef[] {
  /** 本次调用的相对路径基准：显式配置优先；空串按未配置（仓库惯例，对照 fs-digest / md-logic），回落会话 cwd。 */
  const baseRoot = (exec: unknown): string =>
    root !== undefined && root !== "" ? root : resolveExecCwd(exec);
  const hashRead: ToolDef = {
    name: "hash_read",
    description:
      "读取文件的行内容并返回 LINE:HASH 锚点（每行: 1 基行号:sha256 前 8 位 hex）。编辑前先读取获取锚点。",
    parameters: HASH_READ_PARAMS,
    async execute(args, exec) {
      const path = asString(args.path);
      if (path === undefined) return { ok: false, error: "path is required" };
      const base = baseRoot(exec);
      const offset = asInt(args.offset) ?? 1;
      const limit = asInt(args.limit) ?? 200;
      if (offset < 1 || limit < 1) {
        return {
          ok: false,
          error: "offset and limit must be positive integers",
        };
      }
      try {
        const result = await readHashlines(path, base, offset, limit);
        return { ...result };
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
      "对文件应用 LINE:HASH 锚定编辑（set_line / replace_lines / insert_after / delete_line）。" +
      "所有锚点针对同一次 hash_read 的原始内容校验；任一锚点失效（stale）则整批拒绝、文件不变，" +
      "返回全部失效锚点供重新读取。",
    parameters: HASH_EDIT_PARAMS,
    async execute(args, exec) {
      const path = asString(args.path);
      if (path === undefined) return { ok: false, error: "path is required" };
      const base = baseRoot(exec);
      const { ops, error } = coerceEdits(args.edits);
      if (error !== undefined) return { ok: false, code: "malformed", error };
      try {
        const result = await applyAnchoredEditsFile(path, ops, base);
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
 * ctx 为结构式访问：仅依赖 ctx.tools.register，缺失时降级告警。
 */
export async function apply(ctx: unknown, config: Config = {}): Promise<void> {
  const warn = (msg: string): void => {
    process.stderr.write(`[hash-edit] warn: ${msg}\n`);
  };
  const root = config.root;
  const toolsSvc = (ctx as { tools?: ToolRegistrar }).tools;
  if (toolsSvc === undefined || typeof toolsSvc.register !== "function") {
    warn("ctx.tools unavailable, skipping tool registration");
    return;
  }
  for (const def of createTools(root)) {
    try {
      toolsSvc.register(toDshTool(def));
    } catch (err) {
      warn(`tool ${def.name} registration failed: ${String(err)}`);
    }
  }
}
