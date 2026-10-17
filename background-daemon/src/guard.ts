/**
 * 命令类任务的**引擎侧安全复查**（`guardScope: "engine-side"`）。
 *
 * 分工（对齐 `metric-loop/README.md` 边界节）：命令来自**工具入参**时由 security-guard 的
 * `tools/pre-execute` 覆盖；命令来自**状态文件 / 任务表**时，宿主看不到, 必须由引擎在执行前
 * 复查。复查不可用（服务缺失 / 形状不符 / 复查自身抛错）→ **fail-open 放行**, 但每种失效
 * 模式只告警一次并返回 `skipped: true`, 让调用方在结果里标 `guardSkipped`（可见, 不静默）。
 *
 * 本包不硬依赖 security-guard：只按名惰性解析它的服务面。
 */

import { readService } from "./services.ts";

export interface CommandCheckResult {
  /** 非空 = 拦截回执（多行）；null = 放行。 */
  receipt: string | null;
  /** true = 本次复查被跳过（fail-open；命令未复查即执行）。 */
  skipped: boolean;
}

export type CommandChecker = (command: string) => CommandCheckResult;

/** security-guard 服务面的结构子集（不 import 对方代码）。 */
interface GuardServiceLike {
  inspectCommand?: (command: string, source?: string) => string | null;
}

/**
 * 构造命令复查器（惰性解析 `ctx.get("guard")`）。
 *
 * @param warn 告警输出（缺省 stderr）
 * @param source 传给 security-guard 的来源标签（用于它的审计与去重）
 */
export function makeCommandGuard(
  ctx: unknown,
  warn: (message: string) => void = (message) =>
    process.stderr.write(`[background-daemon] warn: ${message}\n`),
  source = "background-daemon",
): CommandChecker {
  let warnedMissing = false;
  let warnedThrow = false;
  return (command: string): CommandCheckResult => {
    const service = readService<GuardServiceLike>(ctx, "guard");
    const inspect = service?.inspectCommand;
    if (typeof inspect !== "function") {
      if (!warnedMissing) {
        warnedMissing = true;
        warn(
          "security-guard 服务不可用（ctx.get('guard') 无 inspectCommand）：" +
            "命令类任务不做执行前复查（fail-open；结果标 guardSkipped）",
        );
      }
      return { receipt: null, skipped: true };
    }
    try {
      const receipt = inspect.call(service, command, source);
      if (typeof receipt === "string" && receipt.trim() !== "") {
        return { receipt, skipped: false };
      }
      return { receipt: null, skipped: false };
    } catch (err) {
      if (!warnedThrow) {
        warnedThrow = true;
        warn(
          `security-guard 复查异常（按放行处理，同类异常不再重复告警；` +
            `结果标 guardSkipped）：${String(err)}`,
        );
      }
      return { receipt: null, skipped: true };
    }
  };
}
