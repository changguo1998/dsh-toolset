/**
 * degrade.ts — 失败分类与降级判定（纯函数，无宿主依赖）。
 *
 * 宿主错误是普通 Error（文案稳定，故按文案分类）；这里把「出什么错 → 怎么办」
 * 收敛成一张可测试的矩阵，接线层只负责执行动作与告警，不自己判断。
 * 原则：任何降级都不能让会话报错；最差退化为「不遮罩」，咨询工具仍可用。
 */

/** 遮罩相关失败类型。 */
export type RestrictFailure =
  "no-scope" | "unknown-name" | "empty-intersection" | "other";

/** 降级动作。 */
export type DegradeAction = "retry-filtered" | "unmasked" | "disable-plugin";

/** 一次降级判定。 */
export interface DegradeDecision {
  action: DegradeAction;
  /** 是否按「每代理一次」告警（接线层负责去重）。 */
  warn: boolean;
  /** 告警 / 结果文案（模型可见时用同一句）。 */
  message: string;
}

/**
 * 按宿主报错文案分类 `tools.restrict()` 失败。
 * @param error `restrict` 抛出的任意值。
 * @returns 失败类型。
 */
export function classifyRestrictError(error: unknown): RestrictFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("requires a scoped context")) return "no-scope";
  if (message.includes("unknown global tool")) return "unknown-name";
  return "other";
}

/** 把失败类型映射为降级动作。 */
export function decideDegradation(failure: RestrictFailure): DegradeDecision {
  switch (failure) {
    case "unknown-name":
      // 名单里混入了已注销 / 未注册的名字：现算可限制名后重试一次。
      return {
        action: "retry-filtered",
        warn: false,
        message: "遮罩名单含未知工具，已按当前可限制名过滤后重试。",
      };
    case "no-scope":
      return {
        action: "unmasked",
        warn: true,
        message:
          "宿主未提供 agent 作用域，本会话不遮罩；咨询工具退化为目录检索。",
      };
    case "empty-intersection":
      return {
        action: "unmasked",
        warn: true,
        message:
          "可遮罩工具与初始集无交集，已回退为不遮罩（避免藏光全部工具）。",
      };
    case "other":
    default:
      return {
        action: "unmasked",
        warn: true,
        message: "遮罩安装失败，已回退为不遮罩；咨询结果仍可返回。",
      };
  }
}

/** 服务缺失时的判定（插件整体不启用）。 */
export function decideMissingService(): DegradeDecision {
  return {
    action: "disable-plugin",
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
