/**
 * 回合审查：整回合正文 → 符号报告 → 逐符号冷却过滤 → 人类 notice 文案 + 模型反馈文案。
 *
 * 冷却语义与迁移前的 TUI 实现一致（默认 10 分钟 / 3 run，双维度任一未过期即冷却；
 * 配置 0 可关闭对应维度），但按**会话**隔离记账；每次审查推进一次 run 计数。
 * 纯逻辑、无宿主依赖，便于单测。
 */

import {
  maskCodeSpans,
  normalizeSymbols,
  type ResolvedSymbolRules,
} from "./symbols.ts";
import type { ReviewResult } from "./types.ts";

/** 单个符号的冷却记录。 */
interface CooldownRecord {
  /** 冷却截止时刻（ms epoch；cooldownMs 维度）。 */
  dueAtMs: number;
  /** 剩余 run 次数（cooldownRuns 维度）。 */
  remainingRuns: number;
}

/** 审查器构造参数。 */
export interface ReviewerOptions {
  rules: ResolvedSymbolRules;
  /** 时钟（测试缝），缺省 Date.now。 */
  now?: () => number;
}

/** 符号回合审查器（按会话记账）。 */
export class SymbolReviewer {
  readonly #rules: ResolvedSymbolRules;
  readonly #now: () => number;
  readonly #bySession = new Map<string, Map<string, CooldownRecord>>();

  constructor(options: ReviewerOptions) {
    this.#rules = options.rules;
    this.#now = options.now ?? Date.now;
  }

  /**
   * 审查一段正文：应用冷却过滤后返回 notice 与反馈文案；
   * 无新内容（全部处于冷却 / 无违规）时返回 null。
   */
  review(sessionId: string, text: string): ReviewResult | null {
    const state = this.#state(sessionId);
    this.#tick(state);
    // 掩码代码段/内联代码：其中的符号是「引用示例」，不参与违规判定（见 README「豁免代码段」）
    const report = normalizeSymbols(maskCodeSpans(text), this.#rules);
    // emoji 起源替换：罗列「X→Y」，要求更换
    const emojiSeen = new Set<string>();
    const emojiInstrs: string[] = [];
    for (const { from, to } of report.emojiRemaps) {
      if (emojiSeen.has(from)) continue;
      emojiSeen.add(from);
      if (this.#isCooling(state, from)) continue;
      emojiInstrs.push(
        to === "" ? `请删除「${from}」` : `请将「${from}」改为「${to}」`,
      );
      this.#enter(state, from);
    }
    // 普通变体替换：只报计数
    const emojiFroms = new Set(report.emojiRemaps.map((item) => item.from));
    let variantCount = 0;
    const variantSeen = new Set<string>();
    for (const { from } of report.remaps) {
      if (emojiFroms.has(from) || variantSeen.has(from)) continue;
      variantSeen.add(from);
      if (this.#isCooling(state, from)) continue;
      variantCount++;
      this.#enter(state, from);
    }
    // 无推荐替代：列入警示
    const warnList: string[] = [];
    for (const ch of report.unrecommended) {
      if (this.#isCooling(state, ch)) continue;
      warnList.push(ch);
      this.#enter(state, ch);
    }
    const hasEmoji = emojiInstrs.length > 0;
    const hasVariant = variantCount > 0;
    const hasWarn = warnList.length > 0;
    if (!hasEmoji && !hasVariant && !hasWarn) return null;
    // 人类 notice：替换只报计数；警示列未推荐符号
    let notice = "";
    if (hasEmoji || hasVariant) {
      notice += `符号已替换 ${emojiInstrs.length + variantCount} 处为推荐符号`;
    }
    if (hasWarn) {
      notice +=
        (notice !== "" ? "；" : "") + `未推荐符号：${warnList.join("")}`;
    }
    notice += "（建议用推荐符号或文字）";
    // 模型反馈：合并一条（emoji 罗列 / 变体计数 / 警示复述规则）
    let feedback: string | null = null;
    if (this.#rules.warnModel) {
      const parts: string[] = [];
      if (hasEmoji) {
        parts.push(
          `你使用了 emoji 符号，展示层已替换为推荐符号——请更换为推荐符号或文字：${emojiInstrs.join("；")}。`,
        );
      }
      if (hasVariant) {
        parts.push(
          `另有 ${variantCount} 处变体符号已按推荐替换（不逐一列示，请直接用推荐符号）。`,
        );
      }
      if (hasWarn) {
        parts.push(
          `你使用的符号「${warnList.join("」 「")}」无推荐替代，请按符号选择规则重新选择：` +
            `1）状态/方向/几何类符号用推荐符号（✓ ✗ △ → ← ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙ ▶ ◀ ▲ ▼ ▷ ◁ ▽ ⟸ ⟹ ⟺ • ◦ ○ ● ◯ ■ □ ◇ ◆ ⓘ 〜 …）或文字；` +
            `2）有推荐对应关系的变体符号必须使用推荐对应符；` +
            `3）避免 emoji、带颜色/填色符号及终端宽度不确定的字符。`,
        );
      }
      feedback = `[符号规范] ${parts.join(" ")}`;
    }
    return { notice, feedback };
  }

  /** 清空某会话的冷却记账（会话结束 / 测试用）。 */
  clearSession(sessionId: string): void {
    this.#bySession.delete(sessionId);
  }

  /** 当前有冷却记账的会话数（status 用）。 */
  sessionCount(): number {
    return this.#bySession.size;
  }

  /** 取/建会话冷却表。 */
  #state(sessionId: string): Map<string, CooldownRecord> {
    const existing = this.#bySession.get(sessionId);
    if (existing !== undefined) return existing;
    const state = new Map<string, CooldownRecord>();
    this.#bySession.set(sessionId, state);
    return state;
  }

  /** 是否处于冷却（双维度任一未过期即冷却）。 */
  #isCooling(state: Map<string, CooldownRecord>, ch: string): boolean {
    const rec = state.get(ch);
    if (rec === undefined) return false;
    const inTime = this.#rules.cooldownMs > 0 && this.#now() < rec.dueAtMs;
    const inRuns = this.#rules.cooldownRuns > 0 && rec.remainingRuns > 0;
    return inTime || inRuns;
  }

  /** 对已列入本次提醒的符号登记或重置冷却。 */
  #enter(state: Map<string, CooldownRecord>, ch: string): void {
    if (this.#rules.cooldownMs <= 0 && this.#rules.cooldownRuns <= 0) return;
    const rec = state.get(ch) ?? { dueAtMs: 0, remainingRuns: 0 };
    rec.dueAtMs = this.#now() + Math.max(this.#rules.cooldownMs, 0);
    rec.remainingRuns = Math.max(this.#rules.cooldownRuns, 0);
    state.set(ch, rec);
  }

  /** 每次审查推进 run 计数；两个维度都过期后清出记录（解冻）。 */
  #tick(state: Map<string, CooldownRecord>): void {
    if (this.#rules.cooldownRuns > 0) {
      for (const rec of state.values()) {
        if (rec.remainingRuns > 0) rec.remainingRuns -= 1;
      }
    }
    for (const [ch, rec] of state) {
      const inTime = this.#rules.cooldownMs > 0 && this.#now() < rec.dueAtMs;
      if (!inTime && rec.remainingRuns <= 0) state.delete(ch);
    }
  }
}
