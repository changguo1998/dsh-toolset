// demo/main.ts — demo 入口：mock adapter 喂数据，走通 renderer→app 全栈
//
// 独立入口，无 DSH 依赖。构建后运行 dist/demo/main.js。

import { createRenderer } from "../src/renderer/index.ts";
import { App } from "../src/app/index.ts";
import { createMockDshAdapter } from "./mockAdapter.ts";

const renderer = createRenderer();
const adapter = createMockDshAdapter();

const app = new App({ renderer, adapter });
app.start();

// 退出路径交 renderer：demo 命中 (Ctrl+C/Esc) 或信号即可；此处不加额外逻辑。
