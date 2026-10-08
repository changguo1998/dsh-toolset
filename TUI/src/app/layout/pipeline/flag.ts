// src/app/layout/pipeline/flag.ts — 新旧排版路径开关
//
// 口径（追踪文档「分批」批 0）：开关只为**等价性对照**存在——关 = 完全走既有路径
// （行为不变），开 = 新六步流水线。环境变量只作初始值，运行时经
// setPipelineEnabled 切换（测试 / 基准同进程对比，照 layout/cache.ts 的既有做法）。

let enabled = process.env.TUI_LAYOUT_PIPELINE === "1";

export function pipelineEnabled(): boolean {
  return enabled;
}

export function setPipelineEnabled(next: boolean): void {
  enabled = next;
}
