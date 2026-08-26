// demo/main.ts — demo 入口：mock adapter 喂数据，走通 renderer→app 全栈
//
// 独立入口，无 DSH 依赖。构建后运行 dist/demo/main.js。
// 无 TTY（管道/CI 等）或带 --smoke 时自动走冒烟脚本：合成按键驱动 /model 列表与切换，
// 随后 /quit 以退出码 0 收尾，便于无头环境演示与机械验证。

import { createRenderer, type KeyEvent } from "../src/renderer/index.ts";
import { App } from "../src/app/index.ts";
import { createProcessStatusQueries } from "../src/app/status.ts";
import { createMockDshAdapter } from "./mockAdapter.ts";

const renderer = createRenderer();
const adapter = createMockDshAdapter();

const app = new App({
  renderer,
  adapter,
  status: { queries: createProcessStatusQueries(), intervalMs: 5000 },
});
app.start();

// 退出路径交 renderer：/quit 命令、SIGINT/SIGTERM 信号或进程结束即可；此处不加额外逻辑。

// —— 冒烟模式（无 TTY 或显式 --smoke）：合成按键驱动 /model 与切换后退出 0 ——
const smoke = process.argv.includes("--smoke") || !process.stdin.isTTY;

const key = (name: string): KeyEvent => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
});
const typeLine = (line: string): void => {
  for (const ch of line) renderer.emitKey(key(ch));
  renderer.emitKey(key("enter"));
};
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

if (smoke) {
  // 等 app.start() 完成 onKey 注册与首帧渲染后再注入按键
  setTimeout(() => {
    void (async () => {
      typeLine("/model"); // 无参列出
      await sleep(600); // 等 modelCatalog 异步完成并渲染
      typeLine("/model deepseek-reasoner"); // 切换默认模型
      await sleep(600);
      typeLine("/quit");
    })();
  }, 150);
}
