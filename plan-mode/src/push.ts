/**
 * plan-mode/src/push.ts — 当前段注入文案（决策项 6b）。
 *
 * 纯函数：按段出文案，探索 / 计划段说明只读原因与下一步，实施段说明已放行，
 * 未知段不输出。装配端把结果返回给 `pinNotes.hold("plan-mode", ...)` 的 provider。
 */

import type { Stage } from "./stage.ts";

/** 当前段的注入文案；未知段返回 undefined（不输出）。 */
export function stageMessage(stage: Stage): string | undefined {
  switch (stage) {
    case "explore":
      return (
        "当前段: 探索（只读）, 摸清现状与约束并列出候选方案; " +
        "下一步: 先交探索结论, 再进入计划段。"
      );
    case "plan":
      return (
        "当前段: 计划（只读）, 给出改动清单与验收口径; " +
        "下一步: 计划经人工确认后再改。"
      );
    case "implement":
      return "当前段: 实施, 写权限已放行; " + "按已确认的计划改动并跑验证。";
    default:
      return undefined;
  }
}
