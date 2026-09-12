// src/index.ts — goal-contract 插件入口（DSH bundle 接入面）
//
// 契约对齐 DSH-CTX-API.md §0（bundle 约定 export { name, inject, apply }）
// 与 task-engine src/main.ts 的结构化面模式：宿主 ctx 用结构化最小型
// （@deepseek-ai/cordis 是 dsh workspace 包，非 npm 依赖，不 import）；
// 服务经 ctx.get(...) 面获取、直连属性回落，缺失时警告降级不抛错。
//
// 注册 model 侧 goal_contract_draft 工具：
//   访谈式起草（userQuestions 面，对齐 tool-ask-user）
//   + Done-when 条款校验（schema 对齐 task-engine Acceptance）
//   → ctx.goals.create 落 dsh-goal 事件源（官方 goal/change 会话事件）
//   → 回读当前 goal 视图并解析条款，返回往返比对。

import process from "node:process";
import { createGoalContractTool } from "./tool.ts";
import type { GoalsLike, UserQuestionsLike } from "./types.ts";

/** bundle 名（与 cordis.patch.yml 插件 id 一致）。 */
export const name = "goal-contract";

/** 声明的服务依赖（宿主据此保证可用；运行时仍惰性校验）。 */
export const inject = ["tools", "userQuestions", "goals"];

/** 宿主 ctx 结构化最小型（不 import cordis）。 */
interface BundleHost {
  tools?: { register(tool: unknown): void };
  /** 宿主通用服务获取面（ctx.get）。 */
  get?: (serviceName: string) => unknown;
  /** 直连属性面（get 缺位时回落）。 */
  userQuestions?: UserQuestionsLike;
  goals?: GoalsLike;
}

export function apply(ctx: unknown): void {
  // 观测：stderr 警告（宿主 logger 面形状不固定，不依赖）
  const warn = (message: string): void => {
    process.stderr.write(`[dsh-goal-contract] warn: ${message}\n`);
  };
  const host = ctx as BundleHost;
  // tools 服务必备：无工具注册表则插件无事可做
  if (host.tools === undefined || typeof host.tools.register !== "function") {
    warn("ctx.tools 不可用，跳过工具注册");
    return;
  }
  // 服务优先经 ctx.get 面获取，直连属性回落（宿主面形状不固定）
  const userQuestions = (host.get?.("userQuestions") ?? host.userQuestions) as
    UserQuestionsLike | undefined;
  const goals = (host.get?.("goals") ?? host.goals) as GoalsLike | undefined;
  if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
    warn(
      "userQuestions 服务不可用（tool-ask-user 未挂载），访谈将不可用（预填路径不受影响）",
    );
  }
  if (goals === undefined || typeof goals.create !== "function") {
    warn("goals 服务不可用（dsh-goal 未挂载），无法落 goal");
  }
  const tool = createGoalContractTool({
    ...(userQuestions === undefined ? {} : { userQuestions }),
    ...(goals === undefined ? {} : { goals }),
    warn,
  });
  try {
    host.tools.register(tool);
  } catch (err) {
    warn(`goal_contract_draft 注册失败：${String(err)}`);
  }
}
