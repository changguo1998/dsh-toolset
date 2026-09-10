// scripts/verify-herdr.mjs — 端到端验证脚本
//
// 用真实 HerdrClient 对当前 herdr 服务（HERDR_SOCKET_PATH）上报状态，
// 供 `herdr api snapshot` 核实面板展示。用法见 README「端到端验证脚本」。
//   node scripts/verify-herdr.mjs <state> [message]
//     state: blocked | working | idle | session
//   node scripts/verify-herdr.mjs blocked "waiting for user"
//   node scripts/verify-herdr.mjs session   → 仅上报 pane.report_agent_session
import { HerdrClient, readHerdrEnv } from "../dist/src/herdr.js";

const args = process.argv.slice(2);
const state = args[0] ?? "idle";
const message = args[1];

const opts = readHerdrEnv(process.env);
if (!opts) {
  console.error("[verify] herdr 握手未启用（HERDR_ENV/SOCKET_PATH/PANE_ID）");
  process.exit(1);
}
console.log("[verify] pane:", opts.paneId, "socket:", opts.socketPath);

const client = new HerdrClient(opts);
client.setSessionRef({ id: "verify-" + Date.now() });

if (state === "session") {
  await client.reportSession({ id: "verify-" + Date.now() }, "startup");
} else {
  await client.reportState(state, message);
}
// 给服务端一点处理时间后退出
await new Promise((resolve) => setTimeout(resolve, 200));
console.log("[verify] 已上报", state, message ?? "");
