/**
 * 拦截回执：deny 决策的 reason 文本统一措辞。
 *
 * 回执必须包含两要素（TASK 完成门槛）：
 * 1) 拦截原因（哪条规则、为什么）；
 * 2) 放行方式（用户层配置 allowPatterns / allowedPaths）。
 * 宿主会把 reason 物化为工具结果的错误文本（前缀 "Error: "）回传给模型。
 */
import type { CommandHit } from "./blacklist.ts";
import type { SensitiveHit } from "./sensitive.ts";

/** 命令/路径预览截断长度（回执要回传给模型，不能塞整段长文本）。 */
const MAX_PREVIEW = 160;

/** 压成单行并截断。 */
function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_PREVIEW
    ? `${oneLine.slice(0, MAX_PREVIEW)}…`
    : oneLine;
}

/** 命令黑名单层的放行方式说明。 */
const COMMAND_ALLOW_HINT =
  "在该 profile 的 cordis.patch.yml 的 security-guard 条目 config 下，" +
  "向 commandBlacklist.allowPatterns 追加一条能匹配该命令的正则，重载/重启会话后生效；" +
  "或改写为等价的安全命令。";

/** 敏感文件层的放行方式说明。 */
const PATH_ALLOW_HINT =
  "在该 profile 的 cordis.patch.yml 的 security-guard 条目 config 下，" +
  "向 sensitiveFiles.allowedPaths 追加该路径（或其父目录前缀），重载/重启会话后生效。";

/** 命令黑名单命中回执。 */
export function formatCommandReceipt(hit: CommandHit): string {
  return [
    `[security-guard] 已拦截：命令命中黑名单规则「${hit.rule.id}」。`,
    `命令：${truncate(hit.command)}`,
    `原因：${hit.rule.reason}。`,
    `放行方式：${COMMAND_ALLOW_HINT}`,
  ].join("\n");
}

/** 敏感文件命中回执。operation 区分读/写/读写（shell 命令两面都可能）。 */
export function formatSensitiveReceipt(
  hit: SensitiveHit,
  toolName: string,
  operation: "read" | "write" | "read-write",
): string {
  const opLabel =
    operation === "read" ? "读取" : operation === "write" ? "写入" : "读写";
  return [
    `[security-guard] 已拦截：${opLabel}敏感文件「${truncate(hit.path)}」命中规则「${hit.rule.id}」。`,
    `工具：${toolName}`,
    `原因：${hit.rule.reason}。`,
    `放行方式：${PATH_ALLOW_HINT}`,
  ].join("\n");
}
