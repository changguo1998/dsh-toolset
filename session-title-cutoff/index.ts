// @dsh-toolset/session-title-cutoff — dsh bundle 入口（re-export src/main.ts）
// 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：契约符号在
// src/main.ts 定义并在此透出；Config 以类型声明给出（宿主不校验，配置原样透传）。
export * from "./src/main.ts";
