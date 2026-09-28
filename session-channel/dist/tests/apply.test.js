/**
 * 接入面测试：`apply()` 注册 `session-channel` 工具与 `session-channel` 服务面，工具 action 端到端可用。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, getSessionChannelService } from "../src/index.js";
import { makeFakeHost, redisTest, registerAgent, startTempRedis, waitUntil, } from "./helpers.js";
redisTest("apply：注册工具与 provide 服务；status/peers/send/inbox 全链可用", async () => {
    const redis = await startTempRedis();
    const fake = makeFakeHost();
    const received = registerAgent(fake, "sess-x");
    const tools = [];
    const provided = new Map();
    fake.host["tools"] = {
        register: (def) => void tools.push(def),
    };
    fake.host["provide"] = (key, value) => void provided.set(key, value);
    try {
        apply(fake.host, {
            url: redis.socketPath,
            heartbeatMs: 200,
            presenceTtlSec: 4,
            readBlockMs: 300,
            instanceId: "apply-test",
        });
        const service = getSessionChannelService();
        assert.ok(service, "apply 应登记 activeService");
        await waitUntil(() => service.status().connected === true);
        assert.equal(tools.length, 1);
        assert.equal(tools[0]?.name, "session_channel");
        assert.ok(provided.has("sessionChannel"), "provide 面应暴露 session-channel");
        // status（工具）
        const status = await tools[0].execute({ action: "status" });
        assert.equal(status["connected"], true);
        // 会话注册 → peers（工具 + 服务面各一次）
        fake.emitSession({ id: "sess-x", header: { cwd: "/tmp/apply" } });
        await waitUntil(async () => {
            const res = (await tools[0].execute({ action: "peers" }));
            return res.peers?.some((p) => p.sessionId === "sess-x") === true;
        });
        const face = provided.get("sessionChannel");
        const peers = await face.peers();
        assert.deepEqual(peers.peers?.map((p) => p.sessionId), ["sess-x"]);
        // send（服务面，自发自收：sess-x → sess-x）→ 注入 + 回执
        const sent = await face.send({
            to: "sess-x",
            text: "自测",
            from: "sess-x",
            waitMs: 3000,
        });
        assert.equal(sent["ok"], true);
        assert.equal(sent["delivered"], true, JSON.stringify(sent));
        await waitUntil(() => received.length === 1);
        const injected = received[0];
        assert.equal(injected.content?.[0]?.text, "[CHANNEL] 自测");
        assert.equal(injected.source?.kind, "session-channel");
        // inbox（工具，只读）
        const inbox = (await tools[0].execute({
            action: "inbox",
            sessionId: "sess-x",
        }));
        assert.equal(inbox.ok, true);
        assert.equal(inbox.messages?.[0]?.text, "自测");
        // 参数缺失与未知 action 的兜底
        assert.deepEqual(await tools[0].execute({ action: "send", to: "sess-x" }), {
            ok: false,
            error: "send 需要 to 与 text",
        });
        assert.deepEqual(await tools[0].execute({ action: "inbox" }), {
            ok: false,
            error: "inbox 需要 sessionId",
        });
        const unknown = await tools[0].execute({ action: "nope" });
        assert.match(String(unknown["error"] ?? ""), /未知 action/);
    }
    finally {
        await getSessionChannelService()?.stop();
        await redis.stop();
    }
});
test("apply：无 tools 面时不抛（仅告警），服务面仍可用（未连接态）", () => {
    const fake = makeFakeHost();
    assert.doesNotThrow(() => apply(fake.host, { disabled: true }));
    const service = getSessionChannelService();
    assert.equal(service?.status().enabled, false);
    assert.ok(fake.logs.some((line) => line.includes("tools 未挂载")));
});
//# sourceMappingURL=apply.test.js.map