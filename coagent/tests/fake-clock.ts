/**
 * tests/fake-clock.ts — 手控假时钟：`now()` 读当前时刻，`sleep(ms)` 推进并触发一次回调。
 *
 * 认领与优雅退出都按 `now()` 判上限；用假时钟避免单测真的等 180 s，也让「第 N 轮才上线」
 * 这类时序可精确构造。
 */

import type { Clock } from "../src/types.ts";

export class ManualClock implements Clock {
  #now: number;
  #onSleep?: () => void | Promise<void>;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  /** 直接推进（不走 sleep）。 */
  advance(ms: number): void {
    this.#now += ms;
  }

  /** 每次 sleep 后执行一次（用于「下一轮前让 peer 上线」）。 */
  onSleep(fn: () => void | Promise<void>): void {
    this.#onSleep = fn;
  }

  async sleep(ms: number): Promise<void> {
    this.#now += ms;
    await this.#onSleep?.();
  }
}
