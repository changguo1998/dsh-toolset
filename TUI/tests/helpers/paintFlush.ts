// tests/helpers/paintFlush.ts — 测试侧合帧冲刷登记
//
// App.paint() 现在是「标脏 + 同 tick 合并」：同一 tick 内多次标脏只画一次，
// 帧在 microtask 里冲刷。同步测试体（断言前没有 await）读帧时必须先显式冲刷，
// 否则读到的是合并前的上一帧。TrackedApp 构造即登记到本模块，FakeRenderer 的
// 帧访问器（renders/refreshes/lastRender）读前调用 flushApp()，用例写法不变。

let current: { flushPaint(): void } | null = null;

/** 登记当前用例的 App（TrackedApp 构造时调用；同文件用例顺序执行，单槽足够） */
export function registerApp(app: { flushPaint(): void }): void {
  current = app;
}

/** 同步冲刷待绘制帧（未登记 App 时为 no-op） */
export function flushApp(): void {
  current?.flushPaint();
}
