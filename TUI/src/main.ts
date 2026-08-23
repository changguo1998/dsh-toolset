// src/main.ts — 程序入口：组装 renderer + app + adapter
//
// 阶段 1 无真实 DSH，因此 adapter 默认取自 demo mock（通过 createMockDshAdapter
// 注入）；阶段 2 替换为真实 dsh adapter 实现即可，本文件结构不变。

import { createRenderer, type Renderer } from "./renderer/index.ts";
import { App } from "./app/index.ts";
import type { DshAdapter } from "./app/adapter/dsh.ts";
import { createMockDshAdapter } from "../demo/mockAdapter.ts";

export function main(opts: { adapter?: DshAdapter } = {}): void {
  const renderer: Renderer = createRenderer();
  const adapter: DshAdapter = opts.adapter ?? createMockDshAdapter();

  const app = new App({ renderer, adapter });
  app.setLogger((msg) => void msg);
  app.start();

  // renderer/app 退出路径：close() 恢复终端；进程生命周期由 renderer 的
  // 信号钩子（SIGINT/TERM）或 stdin 关闭后的显式 exit 处理。
  // 挂一个 stub，保持此处结构清晰（阶段 2 可挂真实清理）。
  void app;
  void renderer;
}

main();
