/**
 * 配置层: 插件配置 → 运行期参数（缺省值与白名单集中在此, 动作层只读 `ResolvedConfig`）。
 */

import type { AgentGroupConfig, ResolvedConfig } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 50;
const STATE_FILE_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** 疑似卡死阈值（毫秒；BACKLOG #1 决策③）。 */
export const DEFAULT_STUCK_AFTER_MS = 5 * 60 * 1000;
/** 状态巡查间隔（毫秒；BACKLOG #1 决策②，组长侧廉价读，无推理）。 */
const DEFAULT_STATUS_POLL_MS = 20 * 1000;

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** 归一配置（缺省值见 `src/types.ts` 的 `AgentGroupConfig`）。 */
export function resolveConfig(config: AgentGroupConfig = {}): ResolvedConfig {
  const requested = config.stateFileName;
  const fileName =
    typeof requested === "string" &&
    STATE_FILE_RE.test(requested) &&
    !requested.includes("..") &&
    requested !== "."
      ? requested
      : "agent-group.json";
  return {
    enabled: config.enabled !== false,
    defaultTimeoutMs: positiveNumber(
      config.defaultTimeoutMs,
      DEFAULT_TIMEOUT_MS,
    ),
    maxInstructionRecords: positiveNumber(
      config.maxInstructionRecords,
      DEFAULT_MAX_RECORDS,
    ),
    mirror: config.mirror !== false,
    stateFileName: fileName,
    stuckAfterMs: positiveNumber(config.stuckAfterMs, DEFAULT_STUCK_AFTER_MS),
    // statusPollMs 允许 0 = 不轮询（positiveNumber 对 0 会落缺省，故单独处理）
    statusPollMs:
      typeof config.statusPollMs === "number" &&
      Number.isFinite(config.statusPollMs) &&
      config.statusPollMs >= 0
        ? Math.floor(config.statusPollMs)
        : DEFAULT_STATUS_POLL_MS,
  };
}
