/**
 * 创建期目标会话校验（只读探测）。
 *
 * 背景（追踪文档决策 D5）：任务分档 `S → memory-base session 层`，该层库路径经
 * `sessionPaths.sessionDirFor(sessionId)` 解析；会话不在宿主 `sessions` 里时解析抛错，
 * 写透必然失败——创建期弹一条 error 告警，并留下「内存里有、盘上没有」的半截任务
 * （memory 底座下 JSON 快照已停写，重启即失）。
 *
 * 这里只做**读探测**：解析成功返回 `null`，失败返回原因文案；不写任何东西。
 * `sessionPaths` 属**可选**依赖（与 `memory` / `guard` 同姿态，不进 `inject`）：
 * 服务缺失时返回 `undefined` = 不校验，保持既有行为（决策 D6）。
 */

import { readService } from "./services.ts";
import type { TaskTier } from "./types.ts";

/** `sessionPaths` 服务面的结构子集（不 import 该包）。 */
interface SessionPathsLike {
  sessionDirFor(sessionId: string): string;
}

/**
 * 目标校验器：返回 `null` = 可解析；返回字符串 = 不可解析的原因。
 * 只有 S 档（session 层）依赖会话目录，P / U 档一律放行。
 */
export type TargetValidator = (
  sessionId: string,
  tier: TaskTier,
) => string | null;

/** 不可解析会话的错误码（工具返回 `error` 字段用）。 */
export const TARGET_UNRESOLVABLE = "session_unresolvable";

/**
 * 由宿主 ctx 造一个目标校验器；`sessionPaths` 读不到时返回 `undefined`。
 *
 * 读取走 `readService`（受保护读取）：真机 cordis 严格面下未 inject 的属性读取会抛，
 * 与本包 `memory` / `guard` 的读法一致。
 */
export function createTargetValidator(
  ctx: unknown,
): TargetValidator | undefined {
  const service = readService<SessionPathsLike>(ctx, "sessionPaths");
  if (service === undefined || typeof service.sessionDirFor !== "function") {
    return undefined;
  }
  return (sessionId: string, tier: TaskTier): string | null => {
    if (tier !== "S") return null;
    try {
      service.sessionDirFor(sessionId);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
}
