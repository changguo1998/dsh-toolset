// @dsh-toolset/escalation-hint — dsh bundle 入口（re-export src/main.ts）
// 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, Config, apply }）：契约符号在
// src/main.ts 定义并在此透出；本包不依赖 rule-engine，只订阅宿主 `tools/post-execute`。
export * from "./src/main.ts";
