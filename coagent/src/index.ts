// @dsh-toolset/coagent — dsh bundle 入口（re-export main.ts）
// 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, Config, apply }）：契约符号在
// main.ts 定义并在此透出；Config 以类型声明给出（宿主不校验，配置原样透传）。
export * from "./main.ts";
export * from "./types.ts";
export {
  CoagentActions,
  newCoagentId,
  countLive,
  screenExcerpt,
} from "./actions.ts";
export { FileCoagentStore, recordsToPrune } from "./store.ts";
export { claimSession, matchPeer } from "./channel.ts";
