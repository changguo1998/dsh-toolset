/**
 * src/tools.ts — `herdr_pane` 的模型侧工具定义与回执渲染
 *
 * 形态（设计文档决策项 4）：**单个工具 + `action` 分派**——十个动作共享同一套参数与归属规则，
 * 一条描述即可讲清选择成本与安全边界，工具面上下文占用最小；写类动作的闸门按 `action` 值判定，
 * 不依赖工具名。
 *
 * 渲染分层（本包约定）：
 *   `renderHerdrPane` 把动作结果渲染为文本块（可直接测），`createHerdrPaneTool` 只做参数校验与
 *   结果回传，是 `main.ts` 注册给宿主的那一项。
 */

import type { DispatchDeps } from "./actions.ts";
import { dispatchAction, inspectedText, paneTargetFor } from "./actions.ts";
import {
  DEFAULT_LABEL,
  DEFAULT_READ_LINES,
  DEFAULT_READ_SOURCE,
  DEFAULT_SETTLE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  READ_SOURCES,
  failure,
  resolveConfig,
} from "./types.ts";
import type { ActionResult, HerdrPaneAction, RenderLimit } from "./types.ts";

/**
 * 按 `renderLimit` 截断文本（先按字符上限，再按行数上限；两者共用一条收窄提示）。
 * 只截显示，不改库面数据。
 */
export function capText(
  text: string,
  limit: RenderLimit,
  action: HerdrPaneAction,
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

/** `pane list` 的一行摘要。 */
function formatPaneRow(pane: Record<string, unknown>): string {
  const mark = pane.registered === true ? "[本插件] " : "";
  const label =
    typeof pane.label === "string" && pane.label !== ""
      ? ` label=${pane.label}`
      : "";
  const agent =
    typeof pane.agent === "string" && pane.agent !== ""
      ? ` agent=${pane.agent}(${String(pane.agent_status ?? "unknown")})`
      : "";
  const focus = pane.focused === true ? " [焦点]" : "";
  const cwd = typeof pane.cwd === "string" ? `  ${pane.cwd}` : "";
  return `${mark}${String(pane.pane_id)}${label}${agent}${focus}${cwd}`;
}

/** 把动作结果渲染成文本（全函数：任何值都能渲染，不抛）。 */
export function renderHerdrPane(
  value: unknown,
  limit: RenderLimit = resolveConfig().renderLimit,
): string {
  const result =
    value !== null && typeof value === "object"
      ? (value as Partial<ActionResult>)
      : {};
  const action = (result.action ?? "list") as HerdrPaneAction;
  if (result.ok !== true) {
    const error = (
      result as {
        error?: { code?: string; message?: string; hint?: string };
      }
    ).error;
    const lines = [
      `herdr_pane ${action} 失败[${error?.code ?? "unknown"}]：${error?.message ?? "（无错误信息）"}`,
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
    const panes = asObjectList(payload.panes);
    lines.push(`herdr_pane list：${panes.length} 个 pane`);
    for (const pane of panes) lines.push(`  ${formatPaneRow(pane)}`);
    const registered = Array.isArray(payload.registered)
      ? payload.registered.filter((id): id is string => typeof id === "string")
      : [];
    lines.push(
      registered.length === 0
        ? "本插件当前没有登记的 pane"
        : `本插件登记：${registered.join(", ")}`,
    );
  } else if (action === "create") {
    lines.push(
      `herdr_pane create：已建 pane ${String(payload.pane_id)}（direction=${String(payload.direction)}，label=${String(payload.label)}）`,
    );
  } else if (action === "read") {
    const text = typeof payload.text === "string" ? payload.text : "";
    const capped = capText(text, limit, action);
    lines.push(
      `herdr_pane read：pane=${String(payload.pane_id)} source=${String(payload.source)} revision=${String(payload.revision ?? "-")} truncated=${String(payload.truncated ?? false)}`,
    );
    lines.push(capped.text === "" ? "(屏内容为空)" : capped.text);
  } else if (action === "wait") {
    const text = typeof payload.text === "string" ? payload.text : "";
    const capped = capText(text, limit, action);
    if (payload.stable === true) {
      lines.push(
        `herdr_pane wait：pane=${String(payload.pane_id)} 已判稳（basis=${String(payload.basis)}，变化 ${String(payload.changes)} 次，用时 ${String(payload.elapsed_ms)}ms）`,
      );
    } else {
      lines.push(
        `herdr_pane wait：pane=${String(payload.pane_id)} 已命中：${oneLine(String(payload.matched_line ?? ""))}`,
      );
    }
    if (capped.text !== "") lines.push(capped.text);
  } else if (action === "send_text") {
    lines.push(
      `herdr_pane send_text：已向 pane ${String(payload.pane_id)} 注入 ${String(payload.chars)} 个字符（未回车）`,
    );
  } else if (action === "send_keys") {
    const keys = Array.isArray(payload.keys) ? payload.keys : [];
    lines.push(
      `herdr_pane send_keys：已向 pane ${String(payload.pane_id)} 发送按键 ${keys.map(String).join(" ")}`,
    );
  } else if (action === "run") {
    lines.push(
      `herdr_pane run：已在 pane ${String(payload.pane_id)} 提交命令并回车：${oneLine(String(payload.command ?? ""))}`,
    );
  } else if (action === "label") {
    lines.push(
      payload.cleared === true
        ? `herdr_pane label：已清除 pane ${String(payload.pane_id)} 的归属标记`
        : `herdr_pane label：已把 pane ${String(payload.pane_id)} 标记为 ${String(payload.label)}`,
    );
  } else if (action === "info") {
    const processes = asObjectList(payload.foreground_processes);
    lines.push(
      `herdr_pane info：pane=${String(payload.pane_id)} running=${String(payload.running)} shell_pid=${String(payload.shell_pid ?? "-")}`,
    );
    for (const process of processes) {
      lines.push(
        `  pid=${String(process.pid ?? "-")} ${String(process.name ?? "")}  ${oneLine(String(process.cmdline ?? ""))}`,
      );
    }
    if (processes.length === 0)
      lines.push("  （无前台进程：pane 停在 shell 提示符）");
  } else if (action === "close") {
    lines.push(
      `herdr_pane close：已关闭 pane ${String(payload.pane_id)}${payload.was_registered === true ? "（本插件登记项已注销）" : ""}`,
    );
  } else {
    lines.push(`herdr_pane ${action}：完成`);
  }
  const notes = (result as { notes?: string[] }).notes ?? [];
  for (const note of notes) lines.push(`注：${note}`);
  return lines.join("\n");
}

/** 工具定义的最小结构面（与 `ctx.tools.register` 接受的形态一致）。 */
export interface HerdrPaneToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    required?: string[];
    additionalProperties?: boolean;
    properties: Record<string, unknown>;
  };
  execute(args: Record<string, unknown>): Promise<ActionResult>;
  output: {
    schema: Record<string, unknown>;
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: "text"; text: string }>;
  };
}

/** 工具名（bundle 内的模型侧工具名；与包名区分）。 */
export const TOOL_NAME = "herdr_pane";

/**
 * 构造 `herdr_pane` 工具定义。
 *
 * 描述里写明三件模型最容易踩的事：① 何时该用本工具（需要屏幕状态 + 按键时序）与何时不该
 * （一条命令能跑完的用 bash / 宿主命令工具）；② 写类动作只作用于自己创建的 pane；
 * ③ 命令跑在 dsh 沙箱之外（要过 guard 与审批）。
 */
export function createHerdrPaneTool(deps: DispatchDeps): HerdrPaneToolDef {
  return {
    name: TOOL_NAME,
    description:
      "把 herdr 的 pane 当作可控伪终端层：建 pane、注入文本 / 按键、取屏、等输出、进程探活、关闭。" +
      "适用**需要屏幕状态与按键时序**的交互式命令（TUI 程序、REPL、安装器、要应答的命令）；" +
      "一条命令能跑完的（收退出码 / stdout）用宿主 bash 工具即可，不用本工具。" +
      "通道：read 与 wait 的 stable 模式走 herdr socket（能拿到 revision / truncated），其余走 herdr CLI。" +
      "动作：create 建兄弟 pane（缺省按调用者 pane 宽高选 right / down，--no-focus 不抢焦点）；" +
      "list 列 pane 与本插件登记标记；read 取屏（缺省 source=recent-unwrapped、lines=120、剥 ANSI；" +
      "TUI 类程序用 visible）；wait 等输出（match 字面量 / regex 正则 / stable 静默判稳，三选一）；" +
      "send_text 注入文本（不回车）；send_keys 发按键（如 ['ctrl+c']）；run 文本 + 回车一次提交；" +
      "label 打 / 清归属标记；info 看前台进程（判断命令是否还在跑）；close 关闭 pane。" +
      "安全边界：**写类动作（send_text / send_keys / run / label / close 与 stable 模式的 wait）" +
      "缺省只作用于本插件创建的 pane**（配置 allowForeignPanes: true 可放宽，close 另需 force）；" +
      "读类（read / info）可读任意 pane；永不使用「当前聚焦 pane」；" +
      "命令跑在 dsh 进程之外、**不受 dsh 文件沙箱约束**，故过 security-guard 复查与归属审批；" +
      "对非本插件 pane 动输入 / 关闭会弹审批（requireApproval 缺省 foreign）；" +
      "不要读调用者自己所在的 pane（那是 dsh 自己的界面，会读到本次调用自身的回显）。",
    parameters: {
      type: "object",
      required: ["action"],
      additionalProperties: true,
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "list",
            "read",
            "wait",
            "send_text",
            "send_keys",
            "run",
            "label",
            "info",
            "close",
          ],
          description:
            "create 建 pane；list 列 pane；read 取屏；wait 等输出；send_text 注文本；" +
            "send_keys 发按键；run 文本 + 回车；label 打归属标记；info 进程探活；close 关闭",
        },
        pane_id: {
          type: "string",
          description:
            "目标 pane id（除 create / list 外的动作必填；从 create 回执或 list 里取，勿自行推断）",
        },
        direction: {
          type: "string",
          enum: ["right", "down"],
          description: "create 用：切分方向（缺省按调用者 pane 宽高自动选）",
        },
        cwd: {
          type: "string",
          description: "create 用：新 pane 的工作目录（缺省继承 dsh 进程 cwd）",
        },
        label: {
          type: "string",
          description: `create / label 用：归属标记（create 缺省 ${DEFAULT_LABEL}；label 显式给空串表示清除）`,
        },
        workspace: {
          type: "string",
          description: "list 用：只看某个 workspace 的 pane",
        },
        source: {
          type: "string",
          enum: READ_SOURCES,
          description: `read / wait 用：取屏来源（缺省 ${DEFAULT_READ_SOURCE}；TUI 类程序用 visible）`,
        },
        lines: {
          type: "number",
          description: `read / wait 用：取屏行数（缺省 ${DEFAULT_READ_LINES}）`,
        },
        format: {
          type: "string",
          enum: ["text", "ansi"],
          description: "read 用：text 剥 ANSI（缺省），ansi 保留颜色证据",
        },
        match: {
          type: "string",
          description: "wait 用：等字面量子串出现（与 regex / stable 三选一）",
        },
        regex: {
          type: "string",
          description: "wait 用：等正则匹配（与 match / stable 三选一）",
        },
        stable: {
          type: "boolean",
          description:
            "wait 用：静默判稳（屏内容不再变化即返回；与 match / regex 互斥）",
        },
        settle_ms: {
          type: "number",
          description: `wait stable 用：两次读取的最小间隔（缺省 ${DEFAULT_SETTLE_MS}）`,
        },
        timeout_ms: {
          type: "number",
          description: `wait 用：总超时（缺省 ${DEFAULT_WAIT_TIMEOUT_MS}）；到点返回结构化超时结果而非抛错`,
        },
        text: {
          type: "string",
          description: "send_text 用：要注入的字面量文本（不追加回车）",
        },
        keys: {
          type: "array",
          items: { type: "string" },
          description:
            "send_keys 用：按键序列，如 ['ctrl+c'] / ['esc'] / ['up']",
        },
        command: {
          type: "string",
          description: "run 用：要提交的命令文本（自动追加回车）",
        },
        force: {
          type: "boolean",
          description:
            "close 用：关闭非本插件创建的 pane（需配置 allowForeignPanes: true，且仍过审批）",
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ActionResult> {
      const action = typeof args.action === "string" ? args.action : "";
      if (action === "") {
        return failure(
          "list",
          "unknown-action",
          "缺少 action 参数（可选 create / list / read / wait / send_text / send_keys / run / label / info / close）",
        );
      }
      return dispatchAction(action, args, deps);
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: renderHerdrPane(value, deps.config.renderLimit) },
      ],
    },
  };
}

/** 供 `main.ts` 与真机脚本复用：解析参数里的动作名（非字符串按空串）。 */
export function actionOf(args: Record<string, unknown>): string {
  return typeof args.action === "string" ? args.action : "";
}

/** 供审批门复用：动作 + 待检文本（导出成对，避免两处各拼一套）。 */
export function actionText(
  action: HerdrPaneAction,
  args: Record<string, unknown>,
): string | undefined {
  return inspectedText(action, args);
}

/** 供审批门复用：目标 pane。 */
export function actionPane(
  action: HerdrPaneAction,
  args: Record<string, unknown>,
): string | undefined {
  return paneTargetFor(action, args);
}
