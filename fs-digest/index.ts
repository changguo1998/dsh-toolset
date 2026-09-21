// @dsh-toolset/fs-digest — dsh bundle 入口（re-export src/main.ts）
// 契约对齐 DSH-CTX-API.md §0（export { name, inject, Config, apply }）：四个契约符号都在
// src/main.ts 定义并在此透出（Config 为类型声明，无运行时 schema；注释见 src/main.ts 头）。
export * from "./src/main.ts";
