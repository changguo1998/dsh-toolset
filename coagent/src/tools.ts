/**
 * src/tools.ts — 模型侧工具 `coagent` 的定义（单工具 + `action` 分派三个动作）。
 *
 * Schema 与动作层同源：`additionalProperties: false`，每个参数都写清用途与缺省；
 * `target` / `task` / `text` 等已删除或从未支持的键不在 schema 里（模型看不到），动作层仍会
 * 二次拒绝（防手写参数绕过宿主校验）。
 */

import type { CoagentActions } from "./actions.ts";
import { failure } from "./types.ts";
import type { CallerSession } from "./types.ts";

/** 工具定义（宿主 `ctx.tools.register` 的最小形态，与 agent-group 一致）。 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  output: {
    schema: Record<string, unknown>;
    render: (
      args: unknown,
      value: unknown,
    ) => Array<{ type: string; text: string }>;
  };
}

/** 从宿主 `exec` 取调用方会话（`exec.agent.session`；兼容 `exec.session`）。 */
export function callerSessionOf(exec: unknown): CallerSession | undefined {
  const agent = (exec as { agent?: { session?: unknown } } | undefined)?.agent;
  const direct = (exec as { session?: unknown } | undefined)?.session;
  const session = (agent?.session ?? direct) as
    { id?: unknown; cwd?: unknown } | undefined;
  if (typeof session?.id !== "string" || session.id === "") return undefined;
  return {
    id: session.id,
    cwd: typeof session.cwd === "string" ? session.cwd : "",
  };
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text === "string") return text;
  } catch {
    /* 循环引用：落到 String 兜底 */
  }
  try {
    return String(value);
  } catch {
    return "（无法序列化的值）";
  }
}

/** 工具描述（与 README「能力」一节逐条对应）。 */
const DESCRIPTION =
  "用途: 拉起/收尾独立进程的长驻 dsh 会话(上下文零继承), 只管起停不派任务。\n" +
  "用法: spawn 在 herdr 终端里前台发 fffdsh、轮询 peers 认领新会话(回执 terminal_id / session_id); list 列本会话记录并按需探测终端与会话是否还在; close 发 /quit 等进程退出后关终端, 失败可 force。\n" +
  "效果: 新会话经 peers 认领并回执 terminal_id / session_id; close 会退出进程并关终端。\n" +
  "边界: 只接受 cwd / label / claimTimeoutSec / provider / model / effort, 不接受 task / text / target。\n" +
  "相关: channel_delegate、agent_group、herdr_read、herdr_text、herdr_key。";

/** 工具定义（注入动作实现；测试可直接 execute）。 */
export function toToolDef(actions: CoagentActions): ToolDef {
  return {
    name: "coagent",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["spawn", "list", "close"],
          description:
            "spawn 拉起新会话；list 列记录 / 探测；close 优雅退出并关闭终端",
        },
        cwd: {
          type: "string",
          description:
            "spawn 用：终端的启动目录（绝对路径；缺省调用方会话 cwd）",
        },
        label: {
          type: "string",
          description:
            "spawn 用：记录里的展示名（缺省 coagent-<id>）；终端 label 固定 coagent/<id>",
        },
        claimTimeoutSec: {
          type: "number",
          description:
            "spawn 用：认领新会话的上限秒数（缺省 180；fffdsh 首次可能触发构建）",
        },
        provider: {
          type: "string",
          description:
            "spawn 用：转发为 fffdsh --provider <name>（只允许字母 / 数字与 . _ : / -，≤64 字符）",
        },
        model: {
          type: "string",
          description:
            "spawn 用：转发为 fffdsh --model <spec>，spec 为 <model> 或 <provider>/<model>，可带 :effort 后缀（字符集限制同上）",
        },
        effort: {
          type: "string",
          description:
            "spawn 用：转发为 fffdsh --effort <level>（字符集限制同上；未命中由子会话回退最低等级）",
        },
        coagent_id: {
          type: "string",
          description: "list 单查 / close 必填：spawn 回执里的 coagent_id",
        },
        state: {
          type: "string",
          enum: ["starting", "ready", "closing", "closed", "failed", "lost"],
          description: "list 用：按状态过滤",
        },
        probe: {
          type: "string",
          enum: ["live", "none"],
          description:
            "list 用：live（缺省）对非终态记录做一次终端 / 会话核对；none 只读记录",
        },
        limit: {
          type: "number",
          description: "list 用：返回条数上限（缺省 20，最多 200）",
        },
        force: {
          type: "boolean",
          description: "close 用：跳过 /quit 等待，直接关终端（进程卡住时用）",
        },
        keep: {
          type: "boolean",
          description:
            "close 用：保留记录目录（缺省 false：删目录、索引留墓碑）",
        },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>, exec?: unknown) {
      const caller = callerSessionOf(exec);
      if (caller === undefined) {
        return failure(
          "session_unavailable",
          "无法确定调用方会话（exec.agent.session.id 缺失）",
          "由 agent 会话调用本工具；服务面 / 无 exec 的调用方没有「父会话」可落盘",
        );
      }
      const action = typeof args.action === "string" ? args.action : "";
      return actions.run(action, args, caller);
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}
