// src/tools.ts — md-logic 的模型侧工具面（唯一工具 `md_logic`，action 分派）。
//
// 契约同 ast-tools：def = { name, description, parameters, execute(args, exec), output{schema, render(_args, value)} }；
// render 形参顺序是「args 第一、value 第二」；render 全函数（畸形值不抛）。
// 读面只读、不改宿主状态；`replace` 是本包唯一的写面（按节整节替换 / 删除，安全语义见 edit.ts）。
// 路径相对**调用方会话 cwd**（与 fs_digest / 宿主 tool-fs 同口径）。

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  listLinks,
  queryBlocks,
  findSections,
  type FlatSection,
} from "./query.ts";
import { parseMarkdownDocument } from "./parse.ts";
import { replaceSectionsFile, sectionHash, type SectionEdit } from "./edit.ts";
import {
  renderBlocks,
  renderLinks,
  renderReplace,
  renderStructure,
} from "./render.ts";
import type { MdBlockKind, MdLinkKind, MarkdownDocument } from "./types.ts";

/** 默认文件尺寸上限（1MB；超限报错而不截断，避免给出错误行号）。 */
export const DEFAULT_MAX_BYTES = 1_048_576;

/** 二进制探测窗口（前 8KB 内出现 NUL 判定为二进制）。 */
const BINARY_PROBE_BYTES = 8192;

/** 工具执行上下文（宿主 `exec`，只读鸭子类型）。 */
interface ToolExecCtx {
  agent?: { session?: { header?: { cwd?: string } } };
}

/** 本次调用的相对路径基准：会话 cwd 优先，缺省进程 cwd。 */
export function resolveExecCwd(exec: unknown): string {
  const cwd = (exec as ToolExecCtx | undefined)?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

/** 读取文本文件（存在性 / 常规文件 / 尺寸 / 二进制守卫）。 */
async function readMarkdown(
  absPath: string,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let info;
  try {
    info = await stat(absPath);
  } catch {
    return { ok: false, error: `文件不存在：${absPath}` };
  }
  if (!info.isFile()) return { ok: false, error: `非常规文件：${absPath}` };
  if (info.size > maxBytes) {
    return {
      ok: false,
      error: `文件大小 ${info.size}B 超过上限 ${maxBytes}B`,
    };
  }
  const buffer = await readFile(absPath);
  const probe = buffer.subarray(0, BINARY_PROBE_BYTES);
  if (probe.includes(0)) return { ok: false, error: `二进制文件：${absPath}` };
  return { ok: true, text: buffer.toString("utf8") };
}

/** 字符串参数读取（空串视为缺省）。 */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 字符串数组参数读取。 */
function strArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** 数字参数读取（非法值返回 undefined）。 */
function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** replace 用 edits 入参 → `SectionEdit[]`（纯校验；非法返回错误文案）。 */
function parseEdits(
  raw: unknown,
): { ok: true; edits: SectionEdit[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "需非空数组" };
  }
  const out: SectionEdit[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return {
        ok: false,
        error: "每项需是对象 {heading, start_line, end_line, content}",
      };
    }
    const o = item as Record<string, unknown>;
    const heading = o["heading"];
    const start = o["start_line"];
    const end = o["end_line"];
    // content 直取（不走 str()）：空串是「删除该节」的合法取值，勿改走缺省合并逻辑
    const content = o["content"];
    if (typeof heading !== "string" || heading === "") {
      return { ok: false, error: "每项的 heading 需是非空字符串（标题文本）" };
    }
    if (typeof start !== "number" || !Number.isInteger(start) || start < 1) {
      return {
        ok: false,
        error: "每项的 start_line 需是 >=1 的整数（来自 structure）",
      };
    }
    if (typeof end !== "number" || !Number.isInteger(end) || end < start) {
      return {
        ok: false,
        error: "每项的 end_line 需是 >=start_line 的整数（来自 structure）",
      };
    }
    if (typeof content !== "string") {
      return {
        ok: false,
        error: "每项的 content 需是字符串（空串 = 删除该节）",
      };
    }
    // section_hash 可选：轻量格式校验（8 位 hex，容忍抄渲染行时带的引号 / 反引号），
    // 否则抄错位数会被误报成 section_stale，白跑一轮 structure
    let sectionHash: string | undefined;
    const rawHash = o["section_hash"];
    if (rawHash !== undefined && rawHash !== "") {
      if (typeof rawHash !== "string") {
        return {
          ok: false,
          error:
            "每项的 section_hash 需是字符串（structure 输出的 ·#xxxxxxxx）",
        };
      }
      const normalized = rawHash
        .trim()
        .replace(/^[`"']+|[`"']+$/g, "")
        .toLowerCase();
      if (!/^[0-9a-f]{8}$/.test(normalized)) {
        return {
          ok: false,
          error: `section_hash「${rawHash}」不是 8 位 hex（应抄 structure 输出的 ·#xxxxxxxx）`,
        };
      }
      sectionHash = normalized;
    }
    out.push({
      heading,
      startLine: start,
      endLine: end,
      content,
      ...(sectionHash === undefined ? {} : { sectionHash }),
    });
  }
  return { ok: true, edits: out };
}

const BLOCK_KINDS: MdBlockKind[] = [
  "frontmatter",
  "code",
  "table",
  "list",
  "quote",
  "html",
  "hr",
];
const LINK_KINDS: MdLinkKind[] = ["link", "image", "definition"];

/** `md_logic` 工具定义。 */
export function mdLogicTool(maxBytes: number = DEFAULT_MAX_BYTES): unknown {
  return {
    name: "md_logic",
    description:
      "Markdown 逻辑结构（单文件，读 + 按节改写）：action=structure 出节树（标题层级 + 每节 `L{起}-{止}` 行范围 + 内容 hash `·#xxxxxxxx`），" +
      "action=blocks 按类型 / 节 / 行范围列块（list / table / code / quote / frontmatter / html / hr，" +
      "带列表条目数与嵌套层数、表格行列数、代码围栏语言），action=links 列链接、图片与引用式定义（[tag]: url）。" +
      "选择成本：只要标题 + 块快览用 fs_digest（轻量、与三模式统一）；要节行范围配 read 按节读、" +
      "要链接清单 / 块细节 / 嵌套信息用本工具；action=replace 按节**整节替换 / 删除**（edits 带 heading + start_line / end_line，均来自 structure；可选 section_hash = structure 的内容 hash，不符 → section_stale（同标题同范围但节体 / 层级已被外部改动的漂移盲区）；替换前重新解析校验「同标题 + 同范围」仍成立，漂移即拒；content 非空时必须以标题行开头（ATX / setext）且**层级与目标节一致**（标题文本可不同；首行之外只允许更深层级，否则 content_invalid——改层级会改动节树归属，顶层节请改用 hash_edit / 官方 edit）；整批原子写、失败不落盘；读→写之间文件被外部改动 → file_changed）。改写分工：本工具 replace = 按节（标题 + 行范围 + 内容 hash 漂移检测）；hash_edit = 行级 LINE:HASH 锚点；官方 edit = 文件级字符串替换 + 版本守卫。" +
      "行号 1 基；path 相对会话 cwd。",
    parameters: {
      type: "object",
      required: ["action", "path"],
      additionalProperties: true,
      properties: {
        action: {
          type: "string",
          enum: ["structure", "blocks", "links", "replace"],
          description:
            "structure=节树；blocks=块清单；links=链接与定义清单；replace=按节整节替换 / 删除（写盘）",
        },
        path: {
          type: "string",
          description: "Markdown 文件路径（相对会话 cwd 或绝对路径）",
        },
        depth: {
          type: "integer",
          minimum: 1,
          description: "structure 用：展示到第几层标题（缺省 3）",
        },
        kind: {
          type: "array",
          items: { type: "string", enum: BLOCK_KINDS },
          description: "blocks 用：只看这些块类型",
        },
        section: {
          type: "integer",
          minimum: 1,
          description:
            "blocks 用：只看归属该标题行（`L{n}`，来自 structure）的节内块",
        },
        from: {
          type: "integer",
          minimum: 1,
          description: "blocks 用：只看与 `[from, to]` 有交集的块",
        },
        to: { type: "integer", minimum: 1, description: "blocks 用：见 from" },
        line: {
          type: "integer",
          minimum: 1,
          description: "blocks 用：只看覆盖该行的块",
        },
        linkKind: {
          type: "array",
          items: { type: "string", enum: LINK_KINDS },
          description: "links 用：只看这些链接类型",
        },
        pattern: {
          type: "string",
          description:
            "links 用：按 href / 文本 / title 子串过滤（大小写不敏感）",
        },
        edits: {
          type: "array",
          description:
            "replace 用：改写指令数组——heading 为目标节标题文本（与 structure 输出一致，不含 #）、start_line / end_line 为该节行范围（来自 structure）、content 为整节新文本（非空时必须以标题行开头：ATX / setext，且首行标题层级须与目标节一致、首行之外只允许更深层级；空串 = 删除该节）、可选 section_hash 为目标节内容 hash（structure 的 ·#xxxxxxxx）",
          items: {
            type: "object",
            required: ["heading", "start_line", "end_line", "content"],
            properties: {
              heading: { type: "string", description: "目标节标题文本" },
              start_line: {
                type: "integer",
                minimum: 1,
                description: "节起始行（来自 structure）",
              },
              end_line: {
                type: "integer",
                minimum: 1,
                description: "节结束行（来自 structure）",
              },
              content: {
                type: "string",
                description:
                  "整节新文本（非空时必须以标题行开头：ATX / setext，且首行标题层级须与目标节一致、首行之外只允许更深层级；空串 = 删除该节）",
              },
              section_hash: {
                type: "string",
                description:
                  "可选：目标节内容 hash（structure 输出的 ·#xxxxxxxx）——与当前内容不符时拒改（section_stale），补「同标题 + 同范围但节体 / 层级已被外部改动」的漂移盲区；注意改造子节会使祖先节的 hash 也失效（需重取）",
              },
            },
          },
        },
      },
    },
    async execute(
      args: Record<string, unknown>,
      exec?: unknown,
    ): Promise<unknown> {
      if (args === null || typeof args !== "object") {
        return { error: "入参必须是对象（含 action 与 path）" };
      }
      const action = str(args, "action") ?? "";
      const rawPath = str(args, "path");
      const cwd = resolveExecCwd(exec);
      if (
        action === "structure" ||
        action === "blocks" ||
        action === "links" ||
        action === "replace"
      ) {
        if (rawPath === undefined) {
          return { error: `${action} 需要 path 参数` };
        }
      } else {
        return {
          error: `未知 action：${action}（可选 structure / blocks / links / replace）`,
        };
      }
      // 先校验参数（不触达磁盘），再做读取与解析
      const depth = num(args, "depth") ?? 3;
      if (action === "structure" && (!Number.isInteger(depth) || depth < 1)) {
        return { error: `depth 须为 >=1 的整数，收到：${String(args.depth)}` };
      }
      const blockKinds = strArray(args, "kind") as MdBlockKind[];
      if (action === "blocks") {
        const invalid = blockKinds.filter(
          (kind) => !BLOCK_KINDS.includes(kind),
        );
        if (invalid.length > 0) {
          return { error: `未知块类型：${invalid.join(", ")}` };
        }
      }
      const linkKinds = strArray(args, "linkKind") as MdLinkKind[];
      if (action === "links") {
        const invalid = linkKinds.filter((kind) => !LINK_KINDS.includes(kind));
        if (invalid.length > 0) {
          return { error: `未知链接类型：${invalid.join(", ")}` };
        }
      }

      const absPath = isAbsolute(rawPath ?? "")
        ? (rawPath ?? "")
        : resolve(cwd, rawPath ?? "");
      if (action === "replace") {
        const parsed = parseEdits(args["edits"]);
        if (!parsed.ok) {
          return {
            action,
            path: rawPath ?? "",
            error: `edits 非法：${parsed.error}（edits 每项 {heading, start_line, end_line, content}，可选 section_hash）`,
            code: "edits_invalid",
          };
        }
        const result = await replaceSectionsFile(
          rawPath ?? "",
          parsed.edits,
          cwd,
          maxBytes,
        );
        return {
          action,
          path: result.path ?? rawPath ?? "",
          ok: result.ok,
          ...(result.ok
            ? { applied: result.applied }
            : {
                code: result.code,
                error: result.error,
                ...(result.details === undefined
                  ? {}
                  : { details: result.details }),
              }),
        };
      }

      const read = await readMarkdown(absPath, maxBytes);
      if (!read.ok) return { error: read.error };
      const doc = parseMarkdownDocument(read.text);

      if (action === "structure") {
        // 节内容 hash 进 value（渲染只由 value 决定）：replace 的 section_hash 漂移锚点
        const sections = findSections(doc).map((row) => ({
          ...row,
          hash: sectionHash(read.text, row.line, row.endLine),
        }));
        return {
          action,
          path: absPath,
          depth,
          lines: doc.lines,
          sections,
          doc,
        };
      }

      if (action === "blocks") {
        const blocks = queryBlocks(doc, {
          ...(blockKinds.length === 0 ? {} : { kind: blockKinds }),
          ...(num(args, "section") === undefined
            ? {}
            : { section: num(args, "section") }),
          ...(num(args, "from") === undefined
            ? {}
            : { from: num(args, "from") }),
          ...(num(args, "to") === undefined ? {} : { to: num(args, "to") }),
          ...(num(args, "line") === undefined
            ? {}
            : { line: num(args, "line") }),
        });
        return {
          action,
          path: absPath,
          blocks,
          totalBlocks: doc.blocks.length,
          doc,
        };
      }

      const links = listLinks(doc, {
        ...(linkKinds.length === 0 ? {} : { kind: linkKinds }),
        ...(str(args, "pattern") === undefined
          ? {}
          : { pattern: str(args, "pattern") }),
      });
      return {
        action,
        path: absPath,
        links,
        totalLinks: doc.links.length,
        doc,
      };
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => {
        const result =
          value !== null && typeof value === "object"
            ? (value as {
                error?: string;
                action?: string;
                depth?: number;
                ok?: boolean;
                path?: string;
                applied?: number;
                code?: string;
                details?: unknown;
                doc?: MarkdownDocument;
                sections?: FlatSection[];
                blocks?: MarkdownDocument["blocks"];
                links?: MarkdownDocument["links"];
              })
            : {};
        if (result.action === "replace") {
          return [
            {
              type: "text",
              text: renderReplace({
                ok: result.ok === true,
                path: result.path ?? "",
                ...(typeof result.applied === "number"
                  ? { applied: result.applied }
                  : {}),
                ...(typeof result.code === "string"
                  ? { code: result.code }
                  : {}),
                ...(typeof result.error === "string"
                  ? { error: result.error }
                  : {}),
                ...(result.details === undefined
                  ? {}
                  : { details: result.details }),
              }),
            },
          ];
        }
        if (typeof result.error === "string") {
          return [{ type: "text", text: `md_logic 失败：${result.error}` }];
        }
        if (result.action === "structure" && result.doc !== undefined) {
          return [
            {
              type: "text",
              text: renderStructure(
                result.doc,
                result.depth ?? 3,
                result.sections,
              ),
            },
          ];
        }
        if (result.action === "blocks") {
          const blocks = result.blocks ?? [];
          return [
            {
              type: "text",
              text: blocks.length === 0 ? "(无块)" : renderBlocks(blocks),
            },
          ];
        }
        if (result.action === "links") {
          const links = result.links ?? [];
          return [
            {
              type: "text",
              text: links.length === 0 ? "(无链接)" : renderLinks(links),
            },
          ];
        }
        return [{ type: "text", text: "(空结果)" }];
      },
    },
  };
}
