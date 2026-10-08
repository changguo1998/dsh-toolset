// src/app/layout/pipeline/flag.ts — 新旧排版路径开关
//
// 2026-10-09 起**默认走六步流水线**（等价性回归见 `tests/pipeline-frame.test.ts`：
// 同一语料两条路径 `buildFrame` 逐行一致）。回落旧路径：`TUI_LAYOUT_PIPELINE=0`。
// 环境变量只作初始值，运行时经 setPipelineEnabled 切换（测试 / 基准同进程对比，
// 照 layout/cache.ts 的既有做法）。

let enabled = process.env.TUI_LAYOUT_PIPELINE !== "0";

export function pipelineEnabled(): boolean {
  return enabled;
}

export function setPipelineEnabled(next: boolean): void {
  enabled = next;
}
