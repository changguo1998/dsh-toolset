// src/app/layout/tool-line.ts — 工具行展示纯函数
//
// 状态层（state.ts）用它构建工具调用/结果行的 buffer 文本（工具调用 ○ / 结果 ✓|✗ 前缀），
// 渲染层按 BufferKind="tool" + tone 着色。summary/detail 的启发式提取已由
// adapter（dsh.ts）在归一化时产出（tool/call → summary、tool/result → detail），
// 本文件只负责展示行组装，避免重复解析。零运行时依赖。

/** 工具调用行：○ <name> <summary>（summary 为空时省略） */
export function toolCallLine(name: string, summary: string): string {
  return "○ " + name + (summary ? " " + summary : "");
}

/** 工具结果行：成功 ✓ <detail> / 失败 ✗ <detail>（detail 为空给占位） */
export function toolResultLine(ok: boolean, detail: string): string {
  return (ok ? "✓ " : "✗ ") + (detail || "(无结果)");
}
