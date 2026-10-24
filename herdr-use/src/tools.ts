/**
 * src/tools.ts — 十个模型侧工具的定义与回执渲染
 *
 * 形态（2026-10-23 终端面重构）：**工具即动作**——`herdr_list` / `herdr_read` / `herdr_info` /
 * `herdr_wait` / `herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` /
 * `herdr_run`，无 `action` 参数；每个工具独立 schema（`additionalProperties: false`），
 * 模型只看到与该动作相关的参数。
 *
 * 终端抽象：工具面只有 `terminal_id`，没有 pane / tab / workspace 概念；一个终端是一个 tab
 * 加它自带的 root pane，`herdr_create` 建立、`herdr_close` 关闭。
 *
 * 渲染分层：`renderHerdrUse` 把动作结果渲染为文本块（可直接测），
 * `createHerdrTools` 只做薄壳与结果回传，是 `main.ts` 注册给宿主的那十项。
 */

import type { DispatchDeps } from "./actions.ts";
import { dispatchAction } from "./actions.ts";
import {
  ALL_ACTIONS,
  DEFAULT_READ_LINES,
  DEFAULT_READ_SOURCE,
  DEFAULT_SETTLE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  READ_SOURCES,
  TOOL_NAMES,
  resolveConfig,
} from "./types.ts";
import type { ActionResult, HerdrUseAction, RenderLimit } from "./types.ts";

/**
 * 按 `renderLimit` 截断文本（先按字符上限，再按行数上限；两者共用一条收窄提示）。
 * 只截显示，不改库面数据。
 */
export function capText(
  text: string,
  limit: RenderLimit,
  action: HerdrUseAction,
): { text: string; truncated: boolean } {
  const hints: string[] = [];
  let capped = text;
  if (capped.length > limit.chars) {
    capped = capped.slice(0, limit.chars);
    hints.push(`正文超过 ${limit.chars} 字符`);
  }
  const lines = capped.split("\n");
  if (lines.length > limit.lines) {
    capped = lines.slice(0, limit.lines).join("\n");
    hints.push(`行数超过 ${limit.lines} 行`);
  }
  if (hints.length === 0) return { text, truncated: false };
  const narrow = action === "read" || action === "wait";
  const advice = narrow
    ? "用 lines 收窄行数、用 source 收窄范围（visible 只看视口）"
    : "减少一次取回的内容";
  return {
    text: `${capped}\n…（已截断：${hints.join("，")}；${advice}）`,
    truncated: true,
  };
}

/** 从 `unknown` 取「对象数组」（渲染是全函数：畸形值一律当空）。 */
function asObjectList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const list: unknown[] = value;
  return list.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object",
  );
}

/** 单行化（回执摘要用）。 */
function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** `herdr_list` 的一行摘要。 */
function formatTerminalRow(terminal: Record<string, unknown>): string {
  const mark = terminal.registered === true ? "[本插件] " : "";
  const lane = terminal.foreground === true ? "前台" : "后台";
  const label =
    typeof terminal.label === "string" && terminal.label !== ""
      ? ` label=${terminal.label}`
      : "";
  const focus = terminal.focused === true ? " [焦点]" : "";
  const panes =
    typeof terminal.pane_count === "number"
      ? ` panes=${terminal.pane_count}`
      : "";
  return `${mark}${String(terminal.terminal_id)}（${lane}）${label}${panes}${focus}`;
}

/** 把动作结果渲染成文本（全函数：任何值都能渲染，不抛）。 */
export function renderHerdrUse(
  value: unknown,
  limit: RenderLimit = resolveConfig().renderLimit,
): string {
  const result =
    value !== null && typeof value === "object"
      ? (value as Partial<ActionResult>)
      : {};
  const action = (result.action ?? "list") as HerdrUseAction;
  const tool = TOOL_NAMES[action] ?? "herdr_list";
  if (result.ok !== true) {
    const error = (
      result as {
        error?: { code?: string; message?: string; hint?: string };
      }
    ).error;
    const lines = [
      `${tool} 失败[${error?.code ?? "unknown"}]：${error?.message ?? "（无错误信息）"}`,
    ];
    if (error?.hint !== undefined && error.hint !== "") {
      lines.push(`放行 / 下一步：${error.hint}`);
    }
    const notes = (result as { notes?: string[] }).notes ?? [];
    for (const note of notes) lines.push(`注：${note}`);
    return lines.join("\n");
  }
  const payload =
    (result as { payload?: Record<string, unknown> }).payload ?? {};
  const lines: string[] = [];
  if (action === "list") {
    const terminals = asObjectList(payload.terminals);
    lines.push(`${tool}：本会话有 ${terminals.length} 个终端`);
    for (const terminal of terminals) {
      lines.push(`  ${formatTerminalRow(terminal)}`);
    }
    if (terminals.length === 0) {
      lines.push("  （还没有终端：用 herdr_create 建一个）");
    }
  } else if (action === "create") {
    lines.push(
      `${tool}：已建终端 ${String(payload.terminal_id)}（${payload.foreground === false ? "后台 dshbg" : "前台"}，label=${String(payload.label)}，cwd=${String(payload.cwd)}）`,
    );
  } else if (action === "read") {
    const text = typeof payload.text === "string" ? payload.text : "";
    const capped = capText(text, limit, action);
    lines.push(
      `${tool}：terminal=${String(payload.terminal_id)} source=${String(payload.source)} revision=${String(payload.revision ?? "-")} truncated=${String(payload.truncated ?? false)}`,
    );
    lines.push(capped.text === "" ? "(屏内容为空)" : capped.text);
  } else if (action === "wait") {
    const text = typeof payload.text === "string" ? payload.text : "";
    const capped = capText(text, limit, action);
    if (payload.stable === true) {
      lines.push(
        `${tool}：terminal=${String(payload.terminal_id)} 已判稳（basis=${String(payload.basis)}，变化 ${String(payload.changes)} 次，用时 ${String(payload.elapsed_ms)}ms）`,
      );
    } else {
      lines.push(
        `${tool}：terminal=${String(payload.terminal_id)} 已命中：${oneLine(String(payload.matched_line ?? ""))}`,
      );
    }
    if (capped.text !== "") lines.push(capped.text);
  } else if (action === "text") {
    lines.push(
      `${tool}：已向终端 ${String(payload.terminal_id)} 注入 ${String(payload.chars)} 个字符（未回车）`,
    );
  } else if (action === "key") {
    const keys = Array.isArray(payload.keys) ? payload.keys : [];
    lines.push(
      `${tool}：已向终端 ${String(payload.terminal_id)} 发送按键 ${keys.map(String).join(" ")}`,
    );
  } else if (action === "run") {
    lines.push(
      `${tool}：已在终端 ${String(payload.terminal_id)} 提交命令并回车：${oneLine(String(payload.command ?? ""))}`,
    );
  } else if (action === "label") {
    lines.push(
      `${tool}：已把终端 ${String(payload.terminal_id)} 的标题与归属标记改为 ${String(payload.label)}`,
    );
  } else if (action === "info") {
    const processes = asObjectList(payload.foreground_processes);
    lines.push(
      `${tool}：terminal=${String(payload.terminal_id)} running=${String(payload.running)} shell_pid=${String(payload.shell_pid ?? "-")}`,
    );
    for (const process of processes) {
      lines.push(
        `  pid=${String(process.pid ?? "-")} ${String(process.name ?? "")}  ${oneLine(String(process.cmdline ?? ""))}`,
      );
    }
    if (processes.length === 0) {
      lines.push("  （无前台进程：终端停在 shell 提示符）");
    }
  } else if (action === "close") {
    lines.push(
      `${tool}：已关闭终端 ${String(payload.terminal_id)}（登记项已注销）`,
    );
  } else {
    lines.push(`${tool}：完成`);
  }
  const notes = (result as { notes?: string[] }).notes ?? [];
  for (const note of notes) lines.push(`注：${note}`);
  return lines.join("\n");
}

/** 工具定义的最小结构面（与 `ctx.tools.register` 接受的形态一致）。 */
export interface HerdrUseToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    required?: string[];
    additionalProperties?: boolean;
    properties: Record<string, unknown>;
  };
  execute(args: Record<string, unknown>, exec?: unknown): Promise<ActionResult>;
  output: {
    schema: Record<string, unknown>;
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: "text"; text: string }>;
  };
}

/** 终端 id 参数（八个动作共用）。 */
const TERMINAL_ID_SCHEMA = {
  type: "string",
  description:
    "终端 id（herdr_create 回执的 terminal_id；也可从 herdr_list 取）。勿自行推断。",
};

/** 工具公共外壳（execute / output 一致，只有名称、描述、参数面不同）。 */
function makeTool(
  deps: DispatchDeps,
  action: HerdrUseAction,
  description: string,
  parameters: HerdrUseToolDef["parameters"],
): HerdrUseToolDef {
  return {
    name: TOOL_NAMES[action],
    description,
    parameters,
    execute(args: Record<string, unknown>, exec?: unknown) {
      return dispatchAction(action, args, deps, exec);
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        {
          type: "text",
          text: renderHerdrUse(value, deps.config.renderLimit),
        },
      ],
    },
  };
}

const NO_PARAMS: HerdrUseToolDef["parameters"] = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

/**
 * 构造十个工具定义（顺序与 `ALL_ACTIONS` 一致）。
 *
 * 描述里写明四件模型最容易踩的事：① 何时用本工具族（需要屏幕状态与按键时序）与何时不该
 * （一条命令能跑完的用 bash）；② 只作用于自己创建的终端；③ `herdr_create` 的
 * `foreground` 语义（前台继承父会话 / 后台落 dshbg）；④ 命令跑在 dsh 沙箱之外，要过
 * security-guard 复查与沙箱闸。P0 已把 ① 写进 `herdr_run` / `herdr_read` / `herdr_text` /
 * `herdr_key` 的工具级描述（D6），其余 6 个待 P1 批次。
 */
export function createHerdrTools(deps: DispatchDeps): HerdrUseToolDef[] {
  return [
    makeTool(
      deps,
      "list",
      "列本会话创建的终端（前台 + 后台 dshbg 两处），逐条标 foreground / registered / focused / pane_count。" +
        "先看有哪些终端再决定读或写哪一个；terminal_id 取自 herdr_create 回执。" +
        "registered: false 的是残留终端，需人工在 herdr 里关闭。",
      NO_PARAMS,
    ),
    makeTool(
      deps,
      "read",
      "取终端当前屏幕内容，即读屏 / 看屏（走 socket，回执带 revision / truncated）。" +
        "读文件用 read；要等程序输出、判稳再取用 herdr_wait。" +
        `缺省 source=${DEFAULT_READ_SOURCE}、lines=${DEFAULT_READ_LINES}、剥 ANSI；TUI 类程序用 visible。` +
        "只接受本插件登记的 terminal_id。",
      {
        type: "object",
        additionalProperties: false,
        required: ["terminal_id"],
        properties: {
          terminal_id: TERMINAL_ID_SCHEMA,
          source: {
            type: "string",
            enum: READ_SOURCES,
            description: `取屏来源（缺省 ${DEFAULT_READ_SOURCE}；TUI 类程序用 visible）`,
          },
          lines: {
            type: "number",
            description: `取屏行数（缺省 ${DEFAULT_READ_LINES}）`,
          },
          format: {
            type: "string",
            enum: ["text", "ansi"],
            description: "text 剥 ANSI（缺省），ansi 保留颜色证据",
          },
        },
      },
    ),
    makeTool(
      deps,
      "info",
      "终端进程探活：返回 running / shell_pid / foreground_processes，判断命令是否还在跑。" +
        "只判存活与前台进程，不取屏；要屏内容用 herdr_read。只接受本插件登记的 terminal_id。",
      {
        type: "object",
        additionalProperties: false,
        required: ["terminal_id"],
        properties: { terminal_id: TERMINAL_ID_SCHEMA },
      },
    ),
    makeTool(
      deps,
      "wait",
      "等终端输出：match 字面量 / regex 正则 / stable 静默判稳，三选一互斥；要立即取当前屏用 herdr_read。" +
        "match / regex 走 CLI wait-output，stable 走 socket 判稳；到点返回结构化超时结果而不抛错。" +
        "只接受本插件登记的 terminal_id。",
      {
        type: "object",
        additionalProperties: false,
        required: ["terminal_id"],
        properties: {
          terminal_id: TERMINAL_ID_SCHEMA,
          match: {
            type: "string",
            description: "等字面量子串出现（与 regex / stable 三选一）",
          },
          regex: {
            type: "string",
            description: "等正则匹配（与 match / stable 三选一）",
          },
          stable: {
            type: "boolean",
            description:
              "静默判稳（屏内容不再变化即返回；与 match / regex 互斥）",
          },
          settle_ms: {
            type: "number",
            description: `stable 用：两次读取的最小间隔（缺省 ${DEFAULT_SETTLE_MS}）`,
          },
          timeout_ms: {
            type: "number",
            description: `总超时（缺省 ${DEFAULT_WAIT_TIMEOUT_MS}）；到点返回结构化超时结果`,
          },
          source: {
            type: "string",
            enum: READ_SOURCES,
            description: `取屏来源（缺省 ${DEFAULT_READ_SOURCE}）`,
          },
          lines: {
            type: "number",
            description: `取屏行数（缺省 ${DEFAULT_READ_LINES}）`,
          },
        },
      },
    ),
    makeTool(
      deps,
      "create",
      "建一个终端（新 tab，自带 root pane；不抢焦点，自动打 label），后续命令用 herdr_run 提交。" +
        "foreground 缺省 true：落在父会话所在 herdr session；设 false 则落在名为 dshbg 的后台 session，" +
        "该终端之后的所有命令自动带 --session dshbg。新终端的工作目录缺省取会话工作目录。",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          foreground: {
            type: "boolean",
            description:
              "缺省 true（前台，继承父会话）；false = 后台 dshbg session",
          },
          cwd: {
            type: "string",
            description: "新终端的工作目录（缺省会话工作目录）",
          },
          label: {
            type: "string",
            description: "归属标记（缺省配置 label；写入新 tab 标题）",
          },
        },
      },
    ),
    makeTool(
      deps,
      "close",
      "关闭整个终端（关掉它的 tab，并注销登记）；先 herdr_list 确认 terminal_id 再关。" +
        "继承 lane 下调用者自己所在的 tab 会被拒。只接受本插件登记的 terminal_id。",
      {
        type: "object",
        additionalProperties: false,
        required: ["terminal_id"],
        properties: { terminal_id: TERMINAL_ID_SCHEMA },
      },
    ),
    makeTool(
      deps,
      "label",
      "同时改终端标题（tab 标题）与归属标记（root pane label），label 必须非空；用于标记终端用途、便于 herdr_list 辨认。" +
        "只接受本插件登记的 terminal_id。",
      {
        type: "object",
        additionalProperties: false,
        required: ["terminal_id", "label"],
        properties: {
          terminal_id: TERMINAL_ID_SCHEMA,
          label: { type: "string", description: "新的非空 label" },
        },
      },
    ),
    makeTool(
      deps,
      "text",
      "向终端注入字面量文本（不追加回车），用于回复提示或粘贴片段；要提交命令用 herdr_run。" +
        "只接受本插件登记的 terminal_id。",
      {
        type: "object",
        additionalProperties: false,
        required: ["terminal_id", "text"],
        properties: {
          terminal_id: TERMINAL_ID_SCHEMA,
          text: { type: "string", description: "要注入的文本（不回车）" },
        },
      },
    ),
    makeTool(
      deps,
      "key",
      '发送按键序列（如 ["ctrl+c"] / ["esc"] / ["up"] / ["enter"]），用于中断程序、翻页、确认提示框。' +
        "组合键与单键都走这里；注入字面量文本（输入文本）用 herdr_text。只接受本插件登记的 terminal_id。",
      {
        type: "object",
        additionalProperties: false,
        required: ["terminal_id", "keys"],
        properties: {
          terminal_id: TERMINAL_ID_SCHEMA,
          keys: {
            type: "array",
            items: { type: "string" },
            description: "按键序列（非空字符串数组）",
          },
        },
      },
    ),
    makeTool(
      deps,
      "run",
      "向已创建的 herdr 终端提交命令（文本 + 回车一次完成），复用该终端的会话状态。" +
        "一次性命令用 bash；要在交互式程序里连跑命令、依赖终端当前目录 / shell 变量、或看屏幕时序时用本工具。" +
        "只输入不回车用 herdr_text。这是终端命令的提交口，跑在 dsh 进程之外（不经文件沙箱），过 security-guard 复查。" +
        "只接受本插件登记的 terminal_id。",
      {
        type: "object",
        additionalProperties: false,
        required: ["terminal_id", "command"],
        properties: {
          terminal_id: TERMINAL_ID_SCHEMA,
          command: {
            type: "string",
            description: "要提交的命令文本（自动回车）",
          },
        },
      },
    ),
  ];
}

/** 动作名列表（`main.ts` 注册顺序与测试断言共用）。 */
export const TOOL_ACTIONS: readonly HerdrUseAction[] = ALL_ACTIONS;
