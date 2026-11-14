/**
 * degrade.ts — 失败分类与告警文案（纯函数，无宿主依赖）。
 *
 * 新机制只有一种降级动作：**本代理或本插件整体不接管**，工具面回退宿主默认。
 * 分类只决定告警文案，不提供「只遮罩一半」的中间态：
 *
 * - catalog 自检失败：整个插件不接管（不注册咨询工具、不 shadow、不 deny）；
 * - 静态 deny 失败或核对后仍有残留：当前代理不接管（撤掉已做的 deny）；
 * - 工具服务缺失：插件不启用。
 */

/** 失败类型。 */
export type FailureKind =
  "catalog-self-check" | "deny-restrict" | "deny-residual" | "missing-service";

/** 一次失败判定。 */
export interface DegradeDecision {
  kind: FailureKind;
  /** 固定为「不接管」；保留字段便于接线层按语义分支。 */
  action: "abort";
  /** 是否告警（当前全部为 true，接线层负责去重）。 */
  warn: boolean;
  message: string;
}

/** catalog 自检失败。 */
export function decideCatalogSelfCheck(detail: string): DegradeDecision {
  return {
    kind: "catalog-self-check",
    action: "abort",
    warn: true,
    message: `工具说明 catalog 自检失败（${detail}）；本插件不接管，工具面回退宿主默认。`,
  };
}

/** 静态 deny 注册失败。 */
export function decideDenyFailure(error: unknown): DegradeDecision {
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: "deny-restrict",
    action: "abort",
    warn: true,
    message: `条件工具隐藏失败（${message}）；当前代理不接管，工具面回退宿主默认。`,
  };
}

/** deny 生效后核对仍有残留。 */
export function decideDenyResidual(names: readonly string[]): DegradeDecision {
  const leaked = names.length === 0 ? "无" : names.join(", ");
  return {
    kind: "deny-residual",
    action: "abort",
    warn: true,
    message: `条件工具隐藏后仍在工具面：${leaked}；当前代理不接管，工具面回退宿主默认。`,
  };
}

/** 服务缺失时的判定（插件整体不启用）。 */
export function decideMissingService(): DegradeDecision {
  return {
    kind: "missing-service",
    action: "abort",
    warn: true,
    message: "宿主缺少 tools / agents 服务，tool-consult 不启用。",
  };
}

/**
 * 咨询工具注册失败分类：自身层同名注册会抛 duplicate 文案。
 * @param error register 抛出的任意值。
 * @returns `duplicate` 或 `other`。
 */
export function classifyToolRegisterError(
  error: unknown,
): "duplicate" | "other" {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already registered") ? "duplicate" : "other";
}
