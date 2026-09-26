/**
 * 运行时层持久化：JSON 文件（`<stateDir>/rules.json`），原子写（tmp + rename）。
 *
 * 外壳对齐 metric-loop 惯例：`{version, state}`；版本不符时**拒载且拒写**（避免用旧
 * schema 覆盖新数据），只记 warning 后以空运行时层继续。任何 IO/解析异常都不向宿主抛。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { RuntimeLayer } from "./types.ts";

/** 状态文件 schema 版本（不兼容时拒绝加载）。 */
export const STATE_VERSION = 1;

/** 默认状态目录。 */
export function defaultStateDir(): string {
  return (
    process.env["RULE_ENGINE_STATE_DIR"] ??
    path.join(homedir(), ".dsh", "rule-engine")
  );
}

/** 状态文件路径。 */
export function statePathFor(stateDir: string): string {
  return path.join(stateDir, "rules.json");
}

/** 加载结果：readOnly 表示版本不符，已拒载（后续 save 也会跳过）。 */
export interface LoadResult {
  layer: RuntimeLayer;
  warnings: string[];
  readOnly: boolean;
}

/** 空运行时层。 */
export function emptyLayer(): RuntimeLayer {
  return { rules: [], removed: [] };
}

/** 形状校验：逐项尝试，坏项丢弃并记 warning（保住其余可用规则）。 */
function coerceLayer(state: unknown, warnings: string[]): RuntimeLayer {
  if (state === null || typeof state !== "object") {
    warnings.push("运行时状态缺少 state 段，已按空层处理");
    return emptyLayer();
  }
  const raw = state as { rules?: unknown; removed?: unknown };
  const rules = Array.isArray(raw.rules)
    ? (raw.rules.filter(
        (item) => item !== null && typeof item === "object",
      ) as RuntimeLayer["rules"])
    : [];
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) {
    warnings.push("运行时状态 rules 不是数组，已忽略");
  }
  const removed = Array.isArray(raw.removed)
    ? raw.removed.filter((id): id is string => typeof id === "string")
    : [];
  if (raw.removed !== undefined && !Array.isArray(raw.removed)) {
    warnings.push("运行时状态 removed 不是数组，已忽略");
  }
  return { rules, removed };
}

/** 加载运行时层；文件缺失返回空层，损坏/版本不符返回 warning + 空层。 */
export function loadLayer(stateDir: string): LoadResult {
  const file = statePathFor(stateDir);
  if (!existsSync(file))
    return { layer: emptyLayer(), warnings: [], readOnly: false };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    return {
      layer: emptyLayer(),
      warnings: [`状态文件损坏（非合法 JSON）：${file} — ${String(err)}`],
      readOnly: false,
    };
  }
  if (raw["version"] !== STATE_VERSION) {
    return {
      layer: emptyLayer(),
      warnings: [
        `状态文件版本不兼容（version=${String(raw["version"])}，要求 ${STATE_VERSION}）：${file}，已拒载并暂停写入`,
      ],
      readOnly: true,
    };
  }
  const warnings: string[] = [];
  const layer = coerceLayer(raw["state"], warnings);
  return { layer, warnings, readOnly: false };
}

/** 原子写运行时层；readOnly 时跳过并记 warning。 */
export function saveLayer(
  stateDir: string,
  layer: RuntimeLayer,
  options: { readOnly?: boolean } = {},
): { ok: boolean; warning: string | null } {
  if (options.readOnly === true) {
    return {
      ok: false,
      warning: `状态文件版本不兼容，已暂停写入：${statePathFor(stateDir)}`,
    };
  }
  const file = statePathFor(stateDir);
  try {
    mkdirSync(stateDir, { recursive: true });
    const payload = JSON.stringify(
      { version: STATE_VERSION, state: layer },
      null,
      2,
    );
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, file);
    return { ok: true, warning: null };
  } catch (err) {
    return { ok: false, warning: `状态写入失败：${file} — ${String(err)}` };
  }
}
