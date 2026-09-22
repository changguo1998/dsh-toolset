// src/schema.ts — 极简 JSON 状态 schema（宿主通用 Schema 结构面）
//
// 为什么自建而不引 schemastery：本包零运行期依赖（与其余 dsh-toolset 包口径一致）。
// 宿主 `SessionProjectionRegistry.register` 只在**恢复持久化缓存行**时调用 `stateSchema.parse`
// （lib/index.js:255/297），注册期不校验；故这里只需实现 `parse` 的「形状校验 + 缺省补全」
// 语义，足够满足投影缓存契约（旧行版本不符时宿主按 stateVersion 丢弃）。
//
// 形状校验为白名单式的：数值字段必须是非负有限数，否则整行拒绝（抛错 → 宿主丢弃该缓存行），
// 从而避免把脏数据折叠成错误的累计值。

import type { SessionContextState } from "./types.ts";

/** schema 结构面（宿主 `ZodType<S>` 的最小兼容子集）。 */
export interface StateSchema<T> {
  /** 校验并返回该类型的值；不合法时抛错。 */
  parse(value: unknown): T;
}

const NUMERIC_FIELDS = [
  "asOfSeq",
  "turns",
  "steps",
  "llmMs",
  "toolMs",
  "ttftMs",
  "ttftSteps",
  "decodeMs",
  "decodeTokens",
  "uncachedInputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "usageSamples",
] as const;

const OPTIONAL_STRING_FIELDS = ["provider", "model"] as const;

/**
 * `SessionContextState` 的校验 schema：字段齐全、数值非负有限、可选路由为字符串。
 * @returns 校验器（不合法抛 `TypeError`）。
 */
export function sessionContextSchema(): StateSchema<SessionContextState> {
  return {
    parse(value: unknown): SessionContextState {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("sessionContext 状态必须是对象");
      }
      const record = value as Record<string, unknown>;
      const out: Record<string, number> = {};
      for (const field of NUMERIC_FIELDS) {
        const raw = record[field] ?? (field === "asOfSeq" ? -1 : 0);
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          throw new TypeError(`sessionContext.${field} 必须是有限数`);
        }
        if (field !== "asOfSeq" && raw < 0) {
          throw new TypeError(`sessionContext.${field} 不能为负`);
        }
        out[field] = raw;
      }
      const state: {
        -readonly [K in keyof SessionContextState]: SessionContextState[K];
      } = {
        asOfSeq: out["asOfSeq"] ?? -1,
        turns: out["turns"] ?? 0,
        steps: out["steps"] ?? 0,
        llmMs: out["llmMs"] ?? 0,
        toolMs: out["toolMs"] ?? 0,
        ttftMs: out["ttftMs"] ?? 0,
        ttftSteps: out["ttftSteps"] ?? 0,
        decodeMs: out["decodeMs"] ?? 0,
        decodeTokens: out["decodeTokens"] ?? 0,
        uncachedInputTokens: out["uncachedInputTokens"] ?? 0,
        outputTokens: out["outputTokens"] ?? 0,
        cacheReadTokens: out["cacheReadTokens"] ?? 0,
        cacheWriteTokens: out["cacheWriteTokens"] ?? 0,
        reasoningTokens: out["reasoningTokens"] ?? 0,
        usageSamples: out["usageSamples"] ?? 0,
      };
      for (const field of OPTIONAL_STRING_FIELDS) {
        const raw = record[field];
        if (raw === undefined || raw === null) continue;
        if (typeof raw !== "string") {
          throw new TypeError(`sessionContext.${field} 必须是字符串`);
        }
        if (field === "provider") state.provider = raw;
        else state.model = raw;
      }
      return state;
    },
  };
}
