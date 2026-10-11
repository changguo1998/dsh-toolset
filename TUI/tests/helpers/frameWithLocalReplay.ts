// tests/helpers/frameWithLocalReplay.ts — 条目 16 段 C1 的过渡包装（逐文件迁移完成后删除）
//
// 背景：生产侧的「无 sink 回退」（`sectionsOf` 按 `state.local` 重放节缓存）已剥离，实现搬进
// `replay.ts` 的显式助手 `sectionsFromLocal()`。仍用 `reduceState` 造缓冲行再直接出帧的测试文件，
// 改成从这个助手导入 `buildFrame`：未注入 `pipeline` 时显式补一节缓存，行为与剥离前逐字等价。
//
// 用法（一行）：
//   import { buildFrame } from "./helpers/frameWithLocalReplay.ts";
//
// 段 C2 删掉内容类 `BufferKind` 后本包装自然失效，那些用例按批次改写成交付流。

import { buildFrame as buildFrameRaw } from "../../src/app/layout.ts";
import { sectionsFromLocal } from "../../src/app/layout/pipeline/replay.ts";

export const buildFrame = (...args: Parameters<typeof buildFrameRaw>) => {
  const state = args[0];
  if (state.pipeline !== undefined) return buildFrameRaw(...args);
  return buildFrameRaw(
    { ...state, pipeline: sectionsFromLocal(state.local) },
    ...(args.slice(1) as [Parameters<typeof buildFrameRaw>[1]]),
  );
};
