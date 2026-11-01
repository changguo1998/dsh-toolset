// src/guard.ts — 命令复查（security-guard 服务面）：执行前检查点与跳过留痕
//
// 执行期惰性读 ctx.get("guard")；服务缺失 / 形状不符 / 抛错一律 fail-open 放行，
// 但每种失效模式只告警一次，并以 skipped 标记让调用方在事件流与反馈里留痕。

import { readService } from "./host.ts";

/**
 * 一次命令复查的结论（D1 口径，与 metric-loop 同形）：
 * - `receipt` 非空 = 拦截回执（多行，首行来源标注）；null = 放行；
 * - `skipped` = 本次复查**被跳过**（服务不可用 / 形状不符 / 抛错 → fail-open 放行）——必须可见，
 *   调用方据此在事件流（`plan/frame-executed.guardSkipped`）与反馈里留痕。
 */
export interface CommandCheckResult {
  /** 非空 = 拦截回执（多行，首行来源标注）；null = 放行。 */
  receipt: string | null;
  /** true = 本次复查被跳过（fail-open 放行；命令未复查即执行）。 */
  skipped: boolean;
}

/**
 * 命令复查器（security-guard 服务面）。真实实现由 security-guard 插件经 `ctx.get('guard')`
 * 提供；未挂载即不复查（fail-open 放行 + 留痕）。
 */
export type CommandChecker = (
  command: string,
  source: string,
) => CommandCheckResult;

/** security-guard 服务面（结构子集；不 import 对方代码、不进 inject，避免跨包硬依赖）。 */
interface GuardServiceLike {
  /** 命令复查 API（见 security-guard 的 GuardService.inspectCommand） */
  inspectCommand?: (command: string, source?: string) => string | null;
}

/**
 * 构造命令复查器（executor 命令后端与 mechanical 验收共用的执行期检查点）：
 * 按名**惰性**解析 security-guard 的复查 API（apply 期服务 fiber 常未激活，执行期才可读）。
 *
 * fail-open 粒度（D1/D2）：服务缺失 / 形状不符 / 复查自身抛错一律**放行**（不得让既有流程失败），
 * 且每种失效模式**只告警一次**（不刷屏）；同时返回 `skipped: true` 让调用方**留痕**（不可见 → 可见）。
 * 返回非字符串 / 空串一律按放行（复查确实跑过 → `skipped: false`），只有明确的非空回执才算拦截。
 */
export function makeCommandGuard(
  ctx: unknown,
  warn: (message: string) => void,
): CommandChecker {
  let warnedMissing = false;
  let warnedThrow = false;
  return (command, source) => {
    const svc = readService<GuardServiceLike>(ctx, "guard");
    const inspect = svc?.inspectCommand;
    if (typeof inspect !== "function") {
      if (!warnedMissing) {
        warnedMissing = true;
        warn(
          "security-guard 服务不可用（ctx.get('guard') 无 inspectCommand）：" +
            "执行期命令复查已跳过（fail-open；事件流标 guardSkipped，已知残余边界）",
        );
      }
      return { receipt: null, skipped: true };
    }
    try {
      const receipt = inspect.call(svc, command, source);
      return {
        receipt:
          typeof receipt === "string" && receipt.length > 0 ? receipt : null,
        skipped: false,
      };
    } catch (err) {
      if (!warnedThrow) {
        warnedThrow = true;
        warn(
          `security-guard 复查异常（按放行处理，同类异常不再重复告警；` +
            `事件流标 guardSkipped）：${String(err)}`,
        );
      }
      return { receipt: null, skipped: true };
    }
  };
}
