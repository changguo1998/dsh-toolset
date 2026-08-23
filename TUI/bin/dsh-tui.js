#!/usr/bin/env node
// bin/dsh-tui.js — CLI 入口
//
// 阶段 2 起 main.ts 不再顶层自启动(那会破坏 cordis 插件加载)。真实链路走
// `dsh --profile dsh-toolset-tui`(loader 以插件方式调用 apply(ctx))；
// 本 bin 仅作无 DSH 环境下的演示前端：显式用 mock adapter 跑全栈 demo。

const { createRenderer } = await import("../dist/src/renderer/index.js");
const { App } = await import("../dist/src/app/index.js");
const { createMockDshAdapter } = await import("../dist/demo/mockAdapter.js");

const renderer = createRenderer();
const app = new App({ renderer, adapter: createMockDshAdapter() });
app.start();
