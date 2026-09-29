/**
 * 接入面测试：`apply()` 注册 `session-channel` 工具与 `session-channel` 服务面，工具 action 端到端可用。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, getSessionChannelService } from "../src/index.ts";
import {
  makeFakeHost,
  redisTest,
  registerAgent,
  startTempRedis,
  waitUntil,
} from "./helpers.ts";

/** 工具定义（测试用最小形态）。 */
interface ToolDef {
  name?: string;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** 服务面（provide 值）。 */
interface ServiceFace {
  peers(): Promise<{ ok: boolean; peers?: { sessionId: string }[] }>;
  send(req: {
    to: string;
    text: string;
    from?: string;
    waitMs?: number;
  }): Promise<Record<string, unknown>>;
  aliasSet(
    alias: string,
    sessionId: string,
    opts?: { force?: boolean },
  ): Promise<{ ok: boolean }>;
  aliasList(): Promise<{
    ok: boolean;
    aliases?: { alias: string; sessionId: string; online: boolean }[];
  }>;
  aliasClear(opts: {
    alias?: string;
    sessionId?: string;
  }): Promise<{ ok: boolean; cleared?: string[] }>;
  status(): { connected: boolean; sessions: string[] };
}

redisTest(
  "apply：注册工具与 provide 服务；status/peers/send/inbox 全链可用",
  async () => {
    const redis = await startTempRedis();
    const fake = makeFakeHost();
    const received = registerAgent(fake, "sess-x");
    const tools: ToolDef[] = [];
    const provided = new Map<string, unknown>();
    fake.host["tools"] = {
      register: (def: unknown) => void tools.push(def as ToolDef),
    };
    fake.host["provide"] = (key: string, value: unknown) =>
      void provided.set(key, value);
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
      await waitUntil(() => service!.status().connected === true);
      assert.equal(tools.length, 1);
      assert.equal(tools[0]?.name, "session_channel");
      assert.ok(
        provided.has("sessionChannel"),
        "provide 面应暴露 session-channel",
      );

      // status（工具）
      const status = await tools[0]!.execute({ action: "status" });
      assert.equal(status["connected"], true);

      // 会话注册 → peers（工具 + 服务面各一次）
      fake.emitSession({ id: "sess-x", header: { cwd: "/tmp/apply" } });
      await waitUntil(async () => {
        const res = (await tools[0]!.execute({ action: "peers" })) as {
          peers?: { sessionId: string }[];
        };
        return res.peers?.some((p) => p.sessionId === "sess-x") === true;
      });
      const face = provided.get("sessionChannel") as ServiceFace;
      // 回归（TUI#48）：别名方法必须在服务面上，否则消费方（TUI 状态栏）调用即抛错
      for (const method of ["aliasSet", "aliasList", "aliasClear"] as const) {
        assert.equal(
          typeof (face as unknown as Record<string, unknown>)[method],
          "function",
          `服务面应暴露 ${method}`,
        );
      }
      const aliases = await face.aliasList();
      assert.equal(aliases.ok, true, "aliasList 经服务面可用");
      const peers = await face.peers();
      assert.deepEqual(
        peers.peers?.map((p) => p.sessionId),
        ["sess-x"],
      );

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
      const injected = received[0] as {
        content?: { text: string }[];
        source?: { kind?: string };
      };
      assert.equal(injected.content?.[0]?.text, "[CHANNEL] 自测");
      assert.equal(injected.source?.kind, "session-channel");

      // inbox（工具，只读）
      const inbox = (await tools[0]!.execute({
        action: "inbox",
        sessionId: "sess-x",
      })) as {
        ok: boolean;
        messages?: { text: string }[];
      };
      assert.equal(inbox.ok, true);
      assert.equal(inbox.messages?.[0]?.text, "自测");

      // 参数缺失与未知 action 的兜底
      assert.deepEqual(
        await tools[0]!.execute({ action: "send", to: "sess-x" }),
        {
          ok: false,
          error: "send 需要 to 与 text",
        },
      );
      assert.deepEqual(await tools[0]!.execute({ action: "inbox" }), {
        ok: false,
        error: "inbox 需要 sessionId",
      });
      const unknown = await tools[0]!.execute({ action: "nope" });
      assert.match(String(unknown["error"] ?? ""), /未知 action/);
    } finally {
      await getSessionChannelService()?.stop();
      await redis.stop();
    }
  },
);

test("apply：无 tools 面时不抛（仅告警），服务面仍可用（未连接态）", () => {
  const fake = makeFakeHost();
  assert.doesNotThrow(() => apply(fake.host, { disabled: true }));
  const service = getSessionChannelService();
  assert.equal(service?.status().enabled, false);
  assert.ok(fake.logs.some((line) => line.includes("tools 未挂载")));
});
