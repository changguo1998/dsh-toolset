// task-engine/src/index.ts — 包入口（唯一对外入口）：插件契约 + 分层的公开导出
//
// 分层（按职责）：plugin（装配 / 生命周期）、engine（状态机与就绪池）、
// executor / subagent / command / worktree（执行面）、guard（执行前复查）、
// verdict（语义裁决）、evidence（证据文本）、dsh-tools（工具面适配）、host（宿主结构面）。
// 拆出的模块只在本入口 re-export，模块之间不互相当入口用。

export { apply, inject, name, provide } from "./plugin.ts";
export type { Config } from "./plugin.ts";

export { MAX_EVIDENCE_CHARS, truncateEvidence } from "./evidence.ts";

export {
  judgeToolFilter,
  measureChildTokens,
  readUsageOutputTokens,
  runChildOnce,
} from "./subagent.ts";
export type { ChildRunOutcome, ChildTokenFields } from "./subagent.ts";

export {
  auditPrompt,
  entailPrompt,
  parseVerdictJson,
  readVerdictValue,
  verdictEnvelope,
} from "./verdict.ts";

export { makeCommandGuard } from "./guard.ts";
export type { CommandCheckResult, CommandChecker } from "./guard.ts";

export { worktreeSegment } from "./worktree.ts";

// 只读查询面 re-export（BACKLOG C1）：供 TUI /task 等接线方从包入口消费引擎只读子集
export { TaskEngine } from "./engine.ts";
export type { TaskEngineSnapshot } from "./engine.ts";
