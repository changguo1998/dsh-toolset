/**
 * 集成层：`apply` 与宿主接线。
 *
 * 覆盖 4.2 要求的四段 —— 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、
 * rule-engine 消费者的注入内容、服务 provide / get；另外走一遍三条信号（S1 / S2 / S3）从
 * 事件面到账簿写回的整条链路，以及候选待审与降级路径。状态写临时目录，用后删除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { INJECTION_HEADER } from "../../src/apply.ts";
import { assemble } from "../assemble.ts";

test("装配：事件面 / 消费者 / 三个工具各注册一次，启动归纳落盘空账簿", async () => {
  const host = await assemble();
  try {
    assert.deepEqual(host.events.names, ["session/event"]);
    assert.deepEqual(
      host.tools.defs.map((def) => def.name),
      ["preference_list", "preference_add", "preference_remove"],
    );
    assert.equal(host.pinNotes.holds.length, 1);
    const ledger = await host.flush((file) => file.revision >= 1, {
      nudge: false,
    });
    assert.deepEqual(ledger.entries, []);
    assert.equal(ledger.unformed, 0);
  } finally {
    await host.cleanup();
  }
});

test("三条信号：S1 重复约束 / S2 纠正加权 / S3 审批拒绝都写回同一账簿", async () => {
  const host = await assemble();
  try {
    // S1：一个会话里的重复约束
    host.feed("s1", "不要用 emoji");
    // S2：上一回合被打断 -> 紧随其后的同句权重 x1.5
    host.events.emit(
      { id: "s2", header: { cwd: "/p" } },
      { type: "turn/end", data: { reason: { type: "aborted" } } },
    );
    host.feed("s2", "不要用 emoji");
    // 纠正语境里没有约束句 -> 只记未成形观察
    host.feed("s2", "不对，重新来一遍");
    // S3：tool/call -> approval/asked -> approval/decided 配对后产出指纹证据
    host.events.emit(
      { id: "s3", header: { cwd: "/p" } },
      {
        type: "tool/call",
        data: {
          name: "bash",
          callId: "call_1",
          arguments: JSON.stringify({ command: "sudo rm -rf /tmp/x" }),
        },
      },
    );
    host.events.emit(
      { id: "s3", header: { cwd: "/p" } },
      {
        type: "approval/asked",
        data: { id: "ap_1", toolName: "bash", callId: "call_1" },
      },
    );
    host.events.emit(
      { id: "s3", header: { cwd: "/p" } },
      { type: "approval/decided", data: { id: "ap_1", outcome: "rejected" } },
    );

    const ledger = await host.flush(
      (file) => file.entries.length >= 2 && file.unformed >= 1,
    );
    const constraint = ledger.entries.find(
      (entry) => entry.key === "不要用emoji",
    );
    assert.ok(constraint !== undefined, "S1 / S2 应合并为一条");
    assert.equal(constraint.evidence, 2.5, "1 + 1.5（纠正加权）");
    assert.deepEqual(constraint.sessions, ["s1", "s2"]);
    assert.equal(constraint.status, "observe", "2.5 条证据未达 3 的门槛");
    assert.equal(constraint.origin, "user");

    const approval = ledger.entries.find((entry) => entry.key === "bashrm");
    assert.ok(approval !== undefined, "S3 应产出指纹证据");
    assert.equal(approval.origin, "approval");
    assert.equal(approval.evidence, 1);
    assert.ok(approval.text.includes("不要直接 bash rm"));
    assert.ok(!approval.text.includes("sudo"), "参数只留首段");
    assert.equal(ledger.unformed, 1);
    assert.equal(host.memory.puts.length, 0, "观察态不写库");
    assert.equal(host.pinNotes.text(), null);
  } finally {
    await host.cleanup();
  }
});

test("高置信写回：跨三会话自动应用、库行引用入账、消费者注入正文", async () => {
  const host = await assemble();
  try {
    for (const sessionId of ["s1", "s2", "s3"]) {
      host.feed(sessionId, "不要用 emoji");
    }
    const ledger = await host.flush(
      (file) => file.entries[0]?.status === "active",
    );
    const entry = ledger.entries[0]!;
    assert.equal(entry.importance, 4);
    assert.equal(host.memory.puts.length, 1);
    const put = host.memory.puts[0]!;
    assert.equal(put.kind, "preference");
    assert.equal(put.input.tier, "project");
    assert.equal(put.input.project, "/p");
    assert.equal(put.input.content, "不要用 emoji");
    assert.equal(put.input.sessionId, "s3", "取最近一次证据的会话 id");
    assert.deepEqual(entry.memory, {
      scope: "induction",
      tier: "project",
      id: host.memory.rows[0]!.id,
    });

    // 动态保持：登记了 preference 这一个 key
    assert.equal(host.pinNotes.holds.length, 1);
    assert.equal(host.pinNotes.holds[0]!.key, "preference");

    // 注入内容：首行说明 + 条目
    const injected = host.pinNotes.text();
    assert.ok(injected !== null);
    assert.ok(injected.startsWith(INJECTION_HEADER));
    assert.ok(injected.includes("- 不要用 emoji"));
  } finally {
    await host.cleanup();
  }
});

test("工具面：preference_add 落候选待审，list 的 canonical 值与 render 投影一致", async () => {
  const host = await assemble();
  try {
    const added = (await host.tools.call("preference_add", {
      text: "  提交信息用中文  ",
      project: "/p",
      title: "提交风格",
    })) as { ok: boolean; id: string; status: string };
    assert.equal(added.ok, true);
    assert.equal(added.status, "candidate");
    assert.equal(host.memory.puts.length, 0, "模型提议不自动写库");
    assert.equal(host.pinNotes.text(), null, "候选不注入");

    const canonical = (await host.tools.call("preference_list", {
      status: "candidate",
    })) as { count: number; entries: Array<Record<string, unknown>> };
    assert.equal(canonical.count, 1);
    const row = canonical.entries[0]!;
    assert.equal(row["id"], added.id);
    assert.equal(row["text"], "提交信息用中文");
    assert.equal(row["status"], "candidate");
    assert.equal(row["evidence"], 1);
    assert.equal(row["sessions"], 0, "模型提议没有会话归属");
    assert.equal(row["origin"], "model");
    assert.equal(row["importance"], 3);
    assert.equal(row["title"], "提交风格");
    assert.equal(typeof row["lastSeen"], "string");

    const rendered = host.tools.render("preference_list", canonical);
    assert.deepEqual(JSON.parse(rendered), canonical);
  } finally {
    await host.cleanup();
  }
});

test("工具面：撤销候选只改状态（无库行），未知 id 给 not-found", async () => {
  const host = await assemble();
  try {
    const added = (await host.tools.call("preference_add", {
      text: "提交信息用中文",
    })) as { id: string };
    const removed = await host.tools.call("preference_remove", {
      id: added.id,
    });
    assert.deepEqual(removed, { ok: true, removed: 0 });
    assert.equal(host.memory.forgets.length, 0);
    assert.equal(host.pinNotes.text(), null);
    assert.deepEqual(await host.tools.call("preference_remove", { id: "x" }), {
      ok: false,
      reason: "not-found",
    });
    // 撤销后同一模式不再登记（抑制键经工具面回传）
    assert.deepEqual(
      await host.tools.call("preference_add", { text: "提交信息用中文" }),
      { ok: false, reason: "该模式已被撤销，不再登记" },
    );
  } finally {
    await host.cleanup();
  }
});

test("撤销生效条目：真删库行、账簿留副本、注入清空", async () => {
  const host = await assemble();
  try {
    for (const sessionId of ["s1", "s2", "s3"]) {
      host.feed(sessionId, "不要用 emoji");
    }
    const ledger = await host.flush(
      (file) => file.entries[0]?.status === "active",
    );
    const id = ledger.entries[0]!.id;
    assert.deepEqual(await host.tools.call("preference_remove", { id }), {
      ok: true,
      removed: 1,
    });
    assert.deepEqual(host.memory.forgets, [
      { kind: "preference", refs: [{ tier: "project", ids: [1] }] },
    ]);
    assert.equal(host.pinNotes.text(), null);
    const after = await host.readLedger();
    assert.equal(after.entries[0]!.status, "retired");
    assert.equal(after.entries[0]!.retiredReason, "removed");
    assert.ok(after.suppressed.includes("不要用emoji"));
  } finally {
    await host.cleanup();
  }
});

test("降级：memory 缺席不登记 hold 与工具，只观察并告警", async () => {
  const host = await assemble({ memory: null });
  try {
    assert.equal(host.events.names.length, 1, "观测订阅不受影响");
    assert.equal(host.pinNotes.holds.length, 0);
    assert.deepEqual(host.tools.defs, []);
    assert.ok(
      host.warnings.join("").includes("memory 服务不可用"),
      `应记一次明确告警，实际：${host.warnings.join("")}`,
    );
    host.feed("s1", "不要用 emoji");
    host.feed("s2", "不要用 emoji");
    const ledger = await host.flush((file) => file.entries.length >= 1);
    assert.equal(ledger.entries[0]!.status, "observe");
    assert.equal(host.pinNotes.text(), null);
  } finally {
    await host.cleanup();
  }
});

test("降级：pinNotes 缺席时工具照常注册、hold 不登记并告警", async () => {
  const host = await assemble({ pinNotes: false });
  try {
    assert.deepEqual(
      host.tools.defs.map((def) => def.name),
      ["preference_list", "preference_add", "preference_remove"],
    );
    assert.equal(host.pinNotes.holds.length, 0);
    assert.ok(host.warnings.join("").includes("ctx.pinNotes 不可用"));
  } finally {
    await host.cleanup();
  }
});

test("enabled: false：零注册、零观测、零落盘", async () => {
  const host = await assemble({ config: { enabled: false } });
  try {
    assert.deepEqual(host.events.names, []);
    assert.deepEqual(host.tools.defs, []);
    assert.deepEqual(host.pinNotes.holds, []);
    assert.deepEqual(host.warnings, []);
    await assert.rejects(() => readFile(host.ledgerPath, "utf8"));
  } finally {
    await host.cleanup();
  }
});

test("dispose：解绑事件与 hold，之后的事件不再进账簿", async () => {
  const host = await assemble();
  try {
    host.feed("s1", "不要用 emoji");
    await host.flush((file) => file.entries.length >= 1);
    host.dispose();
    assert.equal(host.events.offs, 1);
    assert.equal(host.pinNotes.offs, 1);
    assert.equal(host.events.listeners.length, 0);
    assert.equal(host.pinNotes.holds.length, 0);
    const before = await host.readLedger();
    host.feed("s2", "不要用 emoji");
    await host
      .flush((file) => file.entries[0]!.evidence === 2, {
        timeoutMs: 100,
      })
      .catch(() => undefined);
    const after = await host.readLedger();
    assert.equal(after.entries[0]!.evidence, before.entries[0]!.evidence);
    assert.equal(host.pinNotes.text(), null);
  } finally {
    await host.cleanup();
  }
});

test("非 cordis 宿主：没有 ctx.get 时经直接属性取服务", async () => {
  const host = await assemble({ viaGet: false });
  try {
    assert.equal(host.pinNotes.holds.length, 1);
    assert.equal(host.tools.defs.length, 3);
  } finally {
    await host.cleanup();
  }
});
