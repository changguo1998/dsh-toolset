// src/frontmatter.ts — 模板文件解析：YAML 子集 front-matter + 正文。
//
// 只支持手写模板需要的子集（零依赖）：标量、嵌套映射（缩进）、块序列（`- `）、
// 块标量（`|` 字面 / `>` 折叠）、单双引号字符串、整行注释。
// 显式不支持流式集合（`{}` / `[]`）与锚点，遇到即报错——避免半吊子支持带来的静默错读。
// 正文（`---` 之后的剩余部分）在没有 `steps` 时视为单个 prompt 步骤。

import type { JudgeSpec, ModelRef, StepSpec, TemplateSpec } from "./types.ts";

/** 解析错误（消息面向模板作者，指出行号）。 */
export class TemplateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateParseError";
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 解析一个模板文件（front-matter + 正文）→ TemplateSpec。 */
export function parseTemplate(text: string, source: string): TemplateSpec {
  const { header, body } = splitFrontmatter(text, source);
  const root = parseBlock(header, 0, header.length, 0);
  const map = asMap(root, "front-matter 顶层");
  const rawName = str(map["name"]);
  if (rawName === undefined || !NAME_RE.test(rawName)) {
    throw new TemplateParseError(
      `${source}: name 缺失或非法（须小写 [a-z0-9-]{1,32}）`,
    );
  }
  const description = str(map["description"]);
  if (description === undefined || description.trim() === "") {
    throw new TemplateParseError(`${source}: description 不能为空`);
  }
  const spec: TemplateSpec = {
    name: rawName,
    description: description.trim(),
    steps: [],
    source,
  };
  const inputHint = str(map["input"]);
  if (inputHint !== undefined) spec.inputHint = inputHint;
  const model = parseModel(map["model"], `${source}: model`);
  if (model !== undefined) spec.model = model;

  const steps = parseSteps(map["steps"], body, source, model);
  spec.steps = steps;
  return spec;
}

/** 拆出 front-matter 与正文（缺 front-matter → 报错：模板必须声明 name/description）。 */
export function splitFrontmatter(
  text: string,
  source: string,
): { header: string[]; body: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new TemplateParseError(
      `${source}: 缺少 front-matter（首行须为 ---）`,
    );
  }
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (end < 0)
    throw new TemplateParseError(`${source}: front-matter 未闭合（缺 ---）`);
  return {
    header: lines.slice(1, end),
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

/** 步骤：front-matter `steps` 优先；缺省把正文当作单个 prompt 步骤。 */
function parseSteps(
  raw: unknown,
  body: string,
  source: string,
  templateModel: ModelRef | undefined,
): StepSpec[] {
  if (raw === undefined) {
    if (body === "") {
      throw new TemplateParseError(`${source}: 既无 steps 也无正文`);
    }
    return [{ id: "step1", type: "prompt", prompt: body }];
  }
  const list = asList(raw, `${source}: steps`);
  const steps: StepSpec[] = [];
  const seen = new Set<string>();
  for (const [index, item] of list.entries()) {
    const map = asMap(item, `${source}: steps[${index}]`);
    const id = str(map["id"]) ?? `step${index + 1}`;
    if (!NAME_RE.test(id)) {
      throw new TemplateParseError(`${source}: 步骤 id 非法（${id}）`);
    }
    if (seen.has(id))
      throw new TemplateParseError(`${source}: 步骤 id 重复（${id}）`);
    seen.add(id);
    const type = str(map["type"]) ?? "agent";
    if (type !== "prompt" && type !== "agent") {
      throw new TemplateParseError(
        `${source}: 步骤 ${id} 的 type 非法（${type}）`,
      );
    }
    const prompt = str(map["prompt"]);
    if (prompt === undefined || prompt.trim() === "") {
      throw new TemplateParseError(`${source}: 步骤 ${id} 缺 prompt`);
    }
    const step: StepSpec = { id, type, prompt };
    const model = parseModel(map["model"], `${source}: 步骤 ${id} model`);
    if (model !== undefined) step.model = model;
    else if (type === "agent" && templateModel !== undefined)
      step.model = templateModel;
    const bestOf = num(map["bestOf"]);
    if (bestOf !== undefined) {
      if (!Number.isInteger(bestOf) || bestOf < 1) {
        throw new TemplateParseError(
          `${source}: 步骤 ${id} 的 bestOf 须为正整数`,
        );
      }
      step.bestOf = bestOf;
    }
    const judge = parseJudge(map["judge"], `${source}: 步骤 ${id} judge`);
    if (judge !== undefined) step.judge = judge;
    steps.push(step);
  }
  if (steps.length === 0) throw new TemplateParseError(`${source}: steps 为空`);
  return steps;
}

function parseJudge(raw: unknown, where: string): JudgeSpec | undefined {
  if (raw === undefined) return undefined;
  const map = asMap(raw, where);
  const prompt = str(map["prompt"]);
  if (prompt === undefined || prompt.trim() === "") {
    throw new TemplateParseError(`${where}: judge 缺 prompt`);
  }
  const judge: JudgeSpec = { prompt };
  const model = parseModel(map["model"], `${where} model`);
  if (model !== undefined) judge.model = model;
  return judge;
}

function parseModel(raw: unknown, where: string): ModelRef | undefined {
  if (raw === undefined) return undefined;
  // 允许简写：model: deepseek-v4-pro（只有 model 名）或嵌套 provider/model
  const scalar = str(raw);
  if (scalar !== undefined) return { model: scalar };
  const map = asMap(raw, where);
  const ref: ModelRef = {};
  const provider = str(map["provider"]);
  const model = str(map["model"]);
  if (provider !== undefined) ref.provider = provider;
  if (model !== undefined) ref.model = model;
  if (ref.provider === undefined && ref.model === undefined) {
    throw new TemplateParseError(`${where}: 需 provider 或 model`);
  }
  return ref;
}

// ---------- YAML 子集解析（缩进块） ----------

type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };

/** 解析块级 YAML 子集：以 `indent` 为基准的连续行。 */
function parseBlock(
  lines: string[],
  start: number,
  end: number,
  indent: number,
): YamlValue {
  const out: { [key: string]: YamlValue } = {};
  let i = start;
  while (i < end) {
    const raw = lines[i] ?? "";
    const line = stripComment(raw);
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      throw new TemplateParseError(
        `第 ${i + 1} 行：缩进意外（期望 ${indent} 空格）`,
      );
    }
    const text = line.slice(indent);
    if (text.startsWith("- ")) break; // 序列由 collectSequence 处理
    const colon = text.indexOf(":");
    if (colon <= 0) {
      throw new TemplateParseError(`第 ${i + 1} 行：不是 key: value`);
    }
    const key = text.slice(0, colon).trim();
    const rest = text.slice(colon + 1).trim();
    if (rest === "|" || rest === ">") {
      const [value, next] = collectBlockScalar(
        lines,
        i + 1,
        end,
        indent,
        rest === ">",
      );
      out[key] = value;
      i = next;
      continue;
    }
    if (rest !== "") {
      out[key] = parseScalar(rest, i + 1);
      i += 1;
      continue;
    }
    // 空值：可能是嵌套映射或序列（下一行缩进更深）
    const nextLine = nextContentLine(lines, i + 1, end);
    if (nextLine === -1) {
      out[key] = "";
      i += 1;
      continue;
    }
    const nextIndent = indentOf(stripComment(lines[nextLine] ?? ""));
    if (nextIndent <= indent) {
      out[key] = "";
      i += 1;
      continue;
    }
    if (
      stripComment(lines[nextLine] ?? "")
        .trimStart()
        .startsWith("- ")
    ) {
      const [value, next] = collectSequence(lines, nextLine, end, nextIndent);
      out[key] = value;
      i = next;
      continue;
    }
    const [value, next] = collectMap(lines, nextLine, end, nextIndent);
    out[key] = value;
    i = next;
  }
  return out;
}

function collectMap(
  lines: string[],
  start: number,
  end: number,
  indent: number,
): [YamlValue, number] {
  const out: { [key: string]: YamlValue } = {};
  let i = start;
  while (i < end) {
    const line = stripComment(lines[i] ?? "");
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (indentOf(line) < indent) break;
    if (indentOf(line) > indent) {
      throw new TemplateParseError(
        `第 ${i + 1} 行：缩进意外（期望 ${indent} 空格）`,
      );
    }
    const text = line.slice(indent);
    if (text.startsWith("- ")) break;
    const colon = text.indexOf(":");
    if (colon <= 0)
      throw new TemplateParseError(`第 ${i + 1} 行：不是 key: value`);
    const key = text.slice(0, colon).trim();
    const rest = text.slice(colon + 1).trim();
    if (rest === "|" || rest === ">") {
      const [value, next] = collectBlockScalar(
        lines,
        i + 1,
        end,
        indent,
        rest === ">",
      );
      out[key] = value;
      i = next;
      continue;
    }
    if (rest !== "") {
      out[key] = parseScalar(rest, i + 1);
      i += 1;
      continue;
    }
    const nextLine = nextContentLine(lines, i + 1, end);
    if (
      nextLine === -1 ||
      indentOf(stripComment(lines[nextLine] ?? "")) <= indent
    ) {
      out[key] = "";
      i += 1;
      continue;
    }
    const childIndent = indentOf(stripComment(lines[nextLine] ?? ""));
    if (
      stripComment(lines[nextLine] ?? "")
        .trimStart()
        .startsWith("- ")
    ) {
      const [value, next] = collectSequence(lines, nextLine, end, childIndent);
      out[key] = value;
      i = next;
      continue;
    }
    const [value, next] = collectMap(lines, nextLine, end, childIndent);
    out[key] = value;
    i = next;
  }
  return [out, i];
}

function collectSequence(
  lines: string[],
  start: number,
  end: number,
  indent: number,
): [YamlValue[], number] {
  const out: YamlValue[] = [];
  let i = start;
  while (i < end) {
    const line = stripComment(lines[i] ?? "");
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (indentOf(line) < indent) break;
    const text = line.slice(indent);
    if (!text.startsWith("- ")) {
      if (indentOf(line) > indent) {
        throw new TemplateParseError(`第 ${i + 1} 行：序列项缩进意外`);
      }
      break;
    }
    const rest = text.slice(2).trim();
    if (rest === "") {
      // 序列项是嵌套块（少见但支持）：下一行缩进更深
      const nextLine = nextContentLine(lines, i + 1, end);
      if (nextLine === -1) {
        out.push("");
        i += 1;
        continue;
      }
      const childIndent = indentOf(stripComment(lines[nextLine] ?? ""));
      if (
        stripComment(lines[nextLine] ?? "")
          .trimStart()
          .startsWith("- ")
      ) {
        const [value, next] = collectSequence(
          lines,
          nextLine,
          end,
          childIndent,
        );
        out.push(value);
        i = next;
        continue;
      }
      const [value, next] = collectMap(lines, nextLine, end, childIndent);
      out.push(value);
      i = next;
      continue;
    }
    if (rest.includes(": ")) {
      // `- key: value`：首行作为映射起点，后续同缩进的键继续
      const itemIndent = indent + 2;
      const virtual = [" ".repeat(itemIndent) + rest, ...lines.slice(i + 1)];
      const [value, nextVirtual] = collectMap(
        virtual,
        0,
        virtual.length,
        itemIndent,
      );
      out.push(value);
      i += nextVirtual; // 消费的行数（virtual 偏移 1 行 = 原始 i+1 起）
      continue;
    }
    out.push(parseScalar(rest, i + 1));
    i += 1;
  }
  return [out, i];
}

function collectBlockScalar(
  lines: string[],
  start: number,
  end: number,
  indent: number,
  folded: boolean,
): [string, number] {
  const collected: string[] = [];
  let i = start;
  let blockIndent = -1;
  while (i < end) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "") {
      collected.push("");
      i += 1;
      continue;
    }
    const lineIndent = indentOf(raw);
    if (lineIndent <= indent) break;
    if (blockIndent < 0) blockIndent = lineIndent;
    collected.push(raw.slice(blockIndent));
    i += 1;
  }
  while (collected.length > 0 && collected[collected.length - 1] === "")
    collected.pop();
  const text = folded
    ? collected
        .map((line) => line.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    : collected.join("\n");
  return [text, i];
}

function parseScalar(raw: string, lineNo: number): YamlValue {
  const text = raw.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    throw new TemplateParseError(
      `第 ${lineNo} 行：不支持流式集合（请用缩进块写法）`,
    );
  }
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  const prefix = match?.[0] ?? "";
  if (prefix.includes("\t")) {
    throw new TemplateParseError("缩进不支持 Tab（请用空格）");
  }
  return prefix.length;
}

function stripComment(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) return "";
  return line.replace(/[ \t]+$/, "");
}

function nextContentLine(lines: string[], start: number, end: number): number {
  for (let i = start; i < end; i += 1) {
    if (stripComment(lines[i] ?? "").trim() !== "") return i;
  }
  return -1;
}

function asMap(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TemplateParseError(`${where}: 期望映射`);
  }
  return value as Record<string, unknown>;
}

function asList(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new TemplateParseError(`${where}: 期望序列`);
  return value;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
