/**
 * 运行流水：JSONL 追加 + 有界轮转。
 *
 * 口径（设计 §C③）：
 * - 字段 `taskId / at / outcome / error / durationMs`（另带 `sessionId` / `mode` / `detail`）；
 * - **有界**：当前文件最多 `limit` 行（缺省 200, 与宿主 `schedule` 的 200 条对齐）,
 *   写满后轮转到 `<file>.1`（覆盖上一代）——盘上总量 ≤ 2 × limit, 内存只保留最近 limit 条；
 * - 流水是账本、不是权威记录：坏行（手改 / 半截写）**跳过并告警**, 不像任务表那样拒启。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";

import type { RunRecord } from "./types.ts";

/** 流水条数上限缺省值（与宿主 `schedule` 的 200 条对齐）。 */
export const DEFAULT_JOURNAL_LIMIT = 200;

/** 流水外送口（memory-base 作可搜索流水时的写透; 必须不抛）。 */
export type RunSink = (record: RunRecord) => void;

export interface JournalOptions {
  /** 条数上限（正整数; 非正 / 非有限取 200）。 */
  limit?: number;
  /** 坏行告警（缺省不输出）。 */
  onWarn?: (message: string) => void;
  /** 外送口（memory-base 的 `daemon_run` kind; 缺省不外送）。 */
  sink?: RunSink;
}

/** 运行流水（内存镜像 + JSONL 落盘）。 */
export class Journal {
  readonly #file: string;
  readonly #limit: number;
  readonly #onWarn: ((message: string) => void) | undefined;
  readonly #sink: RunSink | undefined;
  readonly #records: RunRecord[] = [];
  #currentLines = 0;

  constructor(file: string, options: JournalOptions = {}) {
    this.#file = file;
    const limit = options.limit;
    this.#limit =
      typeof limit === "number" && Number.isFinite(limit) && limit >= 1
        ? Math.floor(limit)
        : DEFAULT_JOURNAL_LIMIT;
    this.#onWarn = options.onWarn;
    this.#sink = options.sink;
  }

  get file(): string {
    return this.#file;
  }

  get limit(): number {
    return this.#limit;
  }

  /** 读盘恢复（主文件 + 上一代 `.1`）；返回恢复的条数。 */
  load(): number {
    this.#records.length = 0;
    for (const file of [`${this.#file}.1`, this.#file]) {
      if (!existsSync(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (err) {
        this.#onWarn?.(`流水读取失败（跳过）：${file} — ${String(err)}`);
        continue;
      }
      let lines = 0;
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        lines += 1;
        const record = parseRecord(line);
        if (record === null) {
          this.#onWarn?.(`流水坏行（跳过）：${file} — ${line.slice(0, 120)}`);
          continue;
        }
        this.#records.push(record);
      }
      if (file === this.#file) this.#currentLines = lines;
    }
    this.#trim();
    return this.#records.length;
  }

  /** 追加一条流水（写满即轮转）。 */
  append(record: RunRecord): void {
    if (this.#currentLines >= this.#limit) this.#rotate();
    mkdirSync(path.dirname(this.#file), { recursive: true });
    appendFileSync(this.#file, `${JSON.stringify(record)}\n`, "utf8");
    this.#currentLines += 1;
    this.#records.push(record);
    this.#trim();
    // 外送口自己保证不抛；这里再兜一层, 不让流水入库失败影响本地账本
    try {
      this.#sink?.(record);
    } catch (err) {
      this.#onWarn?.(`流水外送失败（已忽略）：${String(err)}`);
    }
  }

  /** 最近 n 条（可按任务 id 过滤; 时间正序返回）。 */
  tail(limit = 20, taskId?: string): RunRecord[] {
    const wanted =
      typeof limit === "number" && Number.isFinite(limit) && limit >= 0
        ? Math.floor(limit)
        : 20;
    const filtered =
      taskId === undefined
        ? this.#records
        : this.#records.filter((record) => record.taskId === taskId);
    return filtered.slice(Math.max(0, filtered.length - wanted));
  }

  #trim(): void {
    const overflow = this.#records.length - this.#limit;
    if (overflow > 0) this.#records.splice(0, overflow);
  }

  #rotate(): void {
    try {
      renameSync(this.#file, `${this.#file}.1`);
    } catch (err) {
      // 轮转失败不能挡住落盘（否则流水丢得更彻底）：退化为继续追加
      this.#onWarn?.(`流水轮转失败（继续追加）：${String(err)}`);
      return;
    }
    this.#currentLines = 0;
  }
}

/** 解析一行流水；形状不符返回 null。 */
function parseRecord(line: string): RunRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record["taskId"] !== "string") return null;
  if (typeof record["at"] !== "number" || !Number.isFinite(record["at"])) {
    return null;
  }
  if (typeof record["outcome"] !== "string") return null;
  if (typeof record["durationMs"] !== "number") return null;
  const rawTier = record["tier"];
  const tier =
    rawTier === "S" || rawTier === "P" || rawTier === "U" ? rawTier : undefined;
  return {
    taskId: record["taskId"],
    ...(tier === undefined ? {} : { tier }),
    at: record["at"],
    sessionId:
      typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    mode: record["mode"] === "command" ? "command" : "deliver",
    outcome: record["outcome"] as RunRecord["outcome"],
    error: typeof record["error"] === "string" ? record["error"] : null,
    durationMs: record["durationMs"],
    detail: typeof record["detail"] === "string" ? record["detail"] : null,
  };
}
