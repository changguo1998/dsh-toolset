/**
 * 超阈值输出触发判定：spill 通知解析 + 文本字节阈值。
 *
 * 对齐宿主 spill-policy（dsh 0.1.5-rc.2，packages/spill/spill-policy）的持久化文案：
 * 工具结果超过 maxInlineBytes 时，事件内文本被替换为
 *   <preview>\n\n(Omitted <N> bytes. Full formatted result stored at: <locator>. <retrievalHint>)
 * 完整原始字节落盘在 <locator>（spill-local 后端为文件路径）。本模块解析该通知，
 * 得到 locator 供后续读取完整输出；通知缺失时按配置阈值兜底判定。
 */

/** 解析出的 spill 通知。 */
export interface SpillNotice {
  /** 被省略的字节数（unknown 形态为 0，仅表「有省略」）。 */
  omittedBytes: number;
  /** 完整结果落盘位置（spill-local 为文件路径；不解析其内部结构，原样透传）。 */
  locator: string;
  /** 宿主给的取回指引（可能为空串，宽松匹配时缺省）。 */
  retrievalHint: string;
}

/**
 * 严格通知正则：锚定 spill-policy 的 retrievalHint 字面量
 * （'Use read with offset/limit, or grep this path to search within it.'），
 * 保证 locator 含 '. ' 时仍能唯一切分。
 */
const STRICT_NOTICE_RE =
  /(?:^|\n\n)\((?:Omitted (\d+) bytes|More bytes were omitted)\. Full formatted result stored at: (.+?)\. Use read with offset\/limit, or grep this path to search within it\.\)\s*$/;

/** 宽松通知正则：宿主文案演进（hint 变化）时兜底，locator 取到右括号前。 */
const LOOSE_NOTICE_RE =
  /(?:^|\n\n)\((?:Omitted (\d+) bytes|More bytes were omitted)\. Full formatted result stored at: (.+)\)\s*$/;

/**
 * 解析文本尾部的 spill 通知；不存在时返回 null。
 * 通知只认「文末」位置（spill-policy 把通知追加在替换文本末尾）。
 */
export function parseSpillNotice(text: string): SpillNotice | null {
  const strict = STRICT_NOTICE_RE.exec(text);
  if (strict !== null) {
    return {
      omittedBytes: strict[1] !== undefined ? Number(strict[1]) : 0,
      locator: String(strict[2] ?? ""),
      retrievalHint:
        "Use read with offset/limit, or grep this path to search within it.",
    };
  }
  const loose = LOOSE_NOTICE_RE.exec(text);
  if (loose !== null) {
    // 宽松捕获为贪婪切分，可能把 retrievalHint 整句吞进 locator；剥掉已知 hint 后缀。
    const rawLocator = String(loose[2] ?? "").replace(
      /\s*\.?\s*Use read with offset\/limit, or grep this path to search within it\.?\s*$/,
      "",
    );
    if (rawLocator.trim().length === 0) return null;
    return {
      omittedBytes: loose[1] !== undefined ? Number(loose[1]) : 0,
      locator: rawLocator,
      retrievalHint: "",
    };
  }
  return null;
}

/** 触发判定结果。 */
export type TriggerReason = "spill-notice" | "threshold" | "none";

export interface TriggerOptions {
  /** 无通知时触发压缩的最小文本字节数（UTF-8 编码后的字节数，与 TASK 契约的 minBytes 一致）。 */
  minBytes: number;
}

/**
 * 触发判定：spill 通知优先（宿主已裁定超阈值且给出落盘位置），
 * 否则按文本 UTF-8 字节数阈值兜底（宿主未 spill 但本插件认为值得摘要的大输出）。
 * 字节口径与宿主 spill 阈值同尺度：多字节文本不会因「字符数少」而被漏判。
 */
export function shouldCompress(
  text: string,
  opts: TriggerOptions,
): { reason: TriggerReason; notice: SpillNotice | null } {
  const notice = parseSpillNotice(text);
  if (notice !== null && notice.locator.trim().length > 0) {
    return { reason: "spill-notice", notice };
  }
  if (Buffer.byteLength(text, "utf8") >= opts.minBytes)
    return { reason: "threshold", notice: null };
  return { reason: "none", notice: null };
}
