import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AUDIT_FILE_NAME } from "../src/audit.ts";
import { apply, name } from "../src/main.ts";
import type { Config } from "../src/config.ts";
import type {
  ApprovalOutcome,
  ApprovalRequestLike,
  AutoApproveService,
  PluginHost,
} from "../src/types.ts";
import {
  createFakeHost,
  createFakeLlm,
  createFakeMemory,
  createFakeSessionPaths,
  reviewChunks,
  tempDir,
  type FakeHost,
} from "./fakes.ts";

const AGENT = { id: "agent-1", session: { id: "s1", header: { cwd: "/w" } } };

interface Setup {
  host: FakeHost;
  service: AutoApproveService;
  root: string;
  memory: ReturnType<typeof createFakeMemory>;
  llm: ReturnType<typeof createFakeLlm>;
  dispose: () => void;
  /** 人工面板（注册在最后，模拟 TUI 应答者）。 */
  panel: { calls: number; outcome: ApprovalOutcome };
}

function setup(
  options: {
    config?: Config;
    auditDir?: string | null;
    llmText?: string;
    withMemory?: boolean;
  } = {},
): Setup {
  const root = options.auditDir ?? tempDir();
  const sessionPaths = createFakeSessionPaths(root);
  const memory = createFakeMemory();
  const llm = createFakeLlm(
    reviewChunks(options.llmText ?? '{"risk":"low","decision":"allow"}'),
  );
  const services: Record<string, unknown> = { sessionPaths, llm };
  if (options.withMemory !== false) services["memory"] = memory;
  if (options.auditDir === null) delete services["sessionPaths"];
  const host = createFakeHost(services);
  const dispose = apply(host as unknown as PluginHost, options.config);
  const service = host.provided.get("autoApprove") as AutoApproveService;
  const panel = {
    calls: 0,
    outcome: "rejected" as ApprovalOutcome,
  };
  host.on("approval/request", ((
    req: ApprovalRequestLike,
    next: () => unknown,
  ) =>
    (async () => {
      panel.calls += 1;
      if (panel.outcome === "rejected") return "rejected";
      return await next();
    })()) as never);
  return { host, service, root, memory, llm, dispose, panel };
}

function request(
  overrides: Partial<ApprovalRequestLike> = {},
): ApprovalRequestLike {
  return { toolName: "bash", callId: "c1", agent: AGENT, ...overrides };
}

async function approve(
  host: FakeHost,
  req: ApprovalRequestLike,
): Promise<unknown> {
  return await host.waterfall(
    "approval/request",
    req,
    async () => "unavailable",
  );
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("apply：契约符号、服务面、三个监听器与启动日志（默认 rules + 空名单 + 零 token）", () => {
  const { host, service, dispose } = setup();
  assert.equal(name, "auto-approve");
  assert.equal(service.status().mode, "rules");
  assert.equal(service.status().configuredMode, "rules");
  assert.equal(service.status().llmEnabled, false);
  assert.equal(host.count("approval/request"), 2, "本插件 + 模拟 TUI");
  assert.equal(host.count("tools/pre-execute"), 1);
  assert.equal(host.count("session/event"), 1);
  assert.match(host.logs.join("\n"), /auto-approve mounted: mode=rules/);
  dispose();
  assert.equal(host.count("approval/request"), 1, "dispose 后只剩模拟 TUI");
  assert.equal(host.count("tools/pre-execute"), 0);
});

test("默认配置：只读类自动放行（不碰面板），名单外的调用照常落面板", async () => {
  const { host, root, panel, service } = setup();
  const readonly = await approve(
    host,
    request({ toolName: "read", callId: "r1", reason: "只读" }),
  );
  assert.equal(readonly, "allowed-once");
  assert.equal(panel.calls, 0);
  const gray = await approve(host, request({ toolName: "bash", callId: "b1" }));
  assert.equal(gray, "rejected");
  assert.equal(panel.calls, 1);
  const rows = readFileSync(join(root, "s1", AUDIT_FILE_NAME), "utf8")
    .trim()
    .split("\n")
    .map(
      (row) =>
        JSON.parse(row) as {
          toolName: string;
          source: string;
          ruleId?: string;
        },
    );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.toolName, "read");
  assert.equal(rows[0]?.source, "readonly");
  assert.equal(rows[0]?.ruleId, "readonly:read");
  assert.equal(service.recent(5).length, 1);
  assert.equal(service.fingerprints().length, 1);
});

test("顺序：本插件应答者先于 TUI（未命中必落到面板；命中时面板不被调用）", async () => {
  const { host, panel } = setup({
    config: { allow: { commands: { bash: ["^git status\\b"] } } },
  });
  assert.equal(
    await approve(host, request({ callId: "c1", reason: "deps" })),
    "rejected",
    "未命中：交面板（面板返回 rejected）",
  );
  assert.equal(panel.calls, 1);
  host.emit(
    "session/event",
    { id: "s1", header: { cwd: "/w" } },
    {
      type: "tool/call",
      data: {
        callId: "c2",
        name: "bash",
        arguments: '{"command":"git status"}',
      },
    },
  );
  assert.equal(
    await approve(host, request({ callId: "c2", reason: undefined })),
    "allowed-once",
  );
  assert.equal(panel.calls, 1, "命中时不调面板");
});

test("沙箱升级端到端：升级白名单两维命中 → allowed-once；等价调用第二次走指纹", async () => {
  const { host, root } = setup({
    config: {
      escalation: {
        allow: [
          { id: "npm-test", match: "^npm test\\b", to: ["workspace-write"] },
        ],
      },
    },
  });
  const exec = {
    name: "bash",
    arguments: '{"command":"npm test"}',
    callId: "c1",
    agent: AGENT,
  };
  await host.waterfall("tools/pre-execute", exec, () => ({ kind: "allow" }));
  const first = await approve(
    host,
    request({
      reason: "escalate sandbox to workspace-write: node_modules 只读",
    }),
  );
  assert.equal(first, "allowed-once");
  // 第二次等价调用：同样先经 gate 记参数（callId 不同），再触发审批 → 命中指纹
  await host.waterfall(
    "tools/pre-execute",
    {
      name: "bash",
      arguments: '{"command":"npm test"}',
      callId: "c2",
      agent: AGENT,
    },
    () => ({ kind: "allow" }),
  );
  const second = await approve(
    host,
    request({
      callId: "c2",
      reason: "escalate sandbox to workspace-write: node_modules 只读",
    }),
  );
  assert.equal(second, "allowed-once");
  const rows = readFileSync(join(root, "s1", AUDIT_FILE_NAME), "utf8")
    .trim()
    .split("\n")
    .map(
      (row) =>
        JSON.parse(row) as {
          source: string;
          ruleId?: string;
          fingerprintHash?: string;
        },
    );
  assert.equal(rows[0]?.source, "upgrade");
  assert.equal(rows[0]?.ruleId, "npm-test");
  assert.match(rows[0]?.fingerprintHash ?? "", /^[0-9a-f]{16}$/);
  assert.equal(rows[1]?.source, "fingerprint");
});

test("拒绝名单：审批请求直接 rejected；升级例外优先于升级白名单", async () => {
  const { host, panel } = setup({
    config: {
      deny: { tools: ["mcp__*"], escalation: { to: ["danger-full-access"] } },
      escalation: {
        allow: [{ match: "^npm test\\b", to: ["danger-full-access"] }],
      },
    },
  });
  assert.equal(
    await approve(
      host,
      request({ toolName: "mcp__figma__read", callId: "m1" }),
    ),
    "rejected",
  );
  host.emit(
    "session/event",
    { id: "s1", header: { cwd: "/w" } },
    {
      type: "tool/call",
      data: { callId: "c9", name: "bash", arguments: '{"command":"npm test"}' },
    },
  );
  assert.equal(
    await approve(
      host,
      request({
        callId: "c9",
        reason: "escalate sandbox to danger-full-access: x",
      }),
    ),
    "rejected",
  );
  assert.equal(panel.calls, 0);
});

test("关闭开关：/autoapprove off 后请求回到面板；mode 立即生效", async () => {
  const { host, service, panel } = setup();
  service.setMode("off");
  assert.equal(
    await approve(host, request({ toolName: "read", callId: "r1" })),
    "rejected",
  );
  assert.equal(panel.calls, 1);
  service.setMode("rules");
  assert.equal(
    await approve(host, request({ toolName: "read", callId: "r2" })),
    "allowed-once",
  );
  assert.equal(panel.calls, 1);
  assert.equal(service.status().mode, "rules");
});

test("enabled: false：与未挂载逐项一致（不裁定、不写审计）", async () => {
  const { host, service, root, panel } = setup({ config: { enabled: false } });
  assert.equal(
    await approve(host, request({ toolName: "read", callId: "r1" })),
    "rejected",
  );
  assert.equal(panel.calls, 1);
  assert.equal(service.recent(5).length, 0);
  assert.throws(() => readFileSync(join(root, "s1", AUDIT_FILE_NAME), "utf8"));
});

test("LLM 灰区：rules+llm 时蓝区交审查；名单命中不产生请求", async () => {
  const { host, llm, service } = setup({
    config: {
      mode: "rules+llm",
      allow: { commands: { bash: ["^git status\\b"] } },
    },
    llmText: '{"risk":"medium","decision":"allow"}',
  });
  assert.equal(service.status().llmEnabled, true);
  // 会话日志给出模型路由（缺省跟随当前会话模型）
  host.emit(
    "session/event",
    { id: "s1", header: { cwd: "/w" } },
    {
      type: "request/header",
      data: {
        header: { config: { provider: "deepseek", model: "deepseek-flash" } },
      },
    },
  );
  assert.equal(
    await approve(host, request({ toolName: "read", callId: "r1" })),
    "allowed-once",
  );
  assert.equal(llm.calls.length, 0, "只读类不调模型");
  host.emit(
    "session/event",
    { id: "s1", header: { cwd: "/w" } },
    {
      type: "tool/call",
      data: {
        callId: "c2",
        name: "bash",
        arguments: '{"command":"git status"}',
      },
    },
  );
  assert.equal(
    await approve(host, request({ callId: "c2", reason: undefined })),
    "allowed-once",
  );
  assert.equal(llm.calls.length, 0, "白名单不调模型");
  host.emit(
    "session/event",
    { id: "s1", header: { cwd: "/w" } },
    {
      type: "tool/call",
      data: {
        callId: "c3",
        name: "bash",
        arguments: '{"command":"pg_dump prod"}',
      },
    },
  );
  const gray = await approve(
    host,
    request({ callId: "c3", reason: "生产库只读查询" }),
  );
  assert.equal(gray, "allowed-once");
  assert.equal(llm.calls.length, 1);
  const rendered = JSON.stringify(llm.calls[0]);
  assert.match(rendered, /ENVIRONMENT/);
  assert.match(rendered, /pg_dump prod/);
  assert.equal(service.recent(1)[0]?.source, "llm");
});

test("LLM 失败：invalid 输出 → 交面板并警告（不静默放行）；onFailure reject → 拒绝", async () => {
  const panelFallback = setup({
    config: { mode: "rules+llm" },
    llmText: "不是 JSON",
  });
  hostGray(panelFallback.host);
  assert.equal(
    await approve(
      panelFallback.host,
      request({ callId: "c3", reason: undefined }),
    ),
    "rejected",
  );
  assert.equal(panelFallback.panel.calls, 1);
  assert.match(panelFallback.host.logs.join("\n"), /LLM 审查失败/);

  const rejectFallback = setup({
    config: { mode: "rules+llm", review: { onFailure: "reject" } },
    llmText: "不是 JSON",
  });
  hostGray(rejectFallback.host);
  assert.equal(
    await approve(
      rejectFallback.host,
      request({ callId: "c3", reason: undefined }),
    ),
    "rejected",
  );
  assert.equal(rejectFallback.panel.calls, 0);
  assert.equal(rejectFallback.service.recent(1)[0]?.fallback, "reject");
});

function hostGray(host: FakeHost): void {
  host.emit(
    "session/event",
    { id: "s1", header: { cwd: "/w" } },
    {
      type: "tool/call",
      data: {
        callId: "c3",
        name: "bash",
        arguments: '{"command":"pg_dump prod"}',
      },
    },
  );
}

test("memory-base 未挂载：项目那份跳过并警告一次，裁定不受影响", async () => {
  const { host, service } = setup({ withMemory: false });
  assert.match(host.logs.join("\n"), /项目那份审计行将被跳过/);
  assert.equal(
    await approve(host, request({ toolName: "read", callId: "r1" })),
    "allowed-once",
  );
  assert.equal(service.status().audit.projectWritable, false);
  assert.equal(service.status().audit.projectSkipped, 1);
});

test("审计双落点：会话 JSONL + memory-base project 层（不可用即跳过、不影响裁定）", async () => {
  const { host, memory } = setup();
  await approve(host, request({ toolName: "read", callId: "r1" }));
  await flush();
  assert.equal(memory.kinds.length, 1);
  assert.deepEqual(memory.kinds[0], {
    kind: "approval_audit",
    writableTiers: ["project"],
  });
  assert.equal(memory.puts.length, 1);
  const put = memory.puts[0] as { content: string; tier: string };
  assert.equal(put.tier, "project");
  assert.equal(
    (JSON.parse(put.content) as { toolName: string }).toolName,
    "read",
  );

  // memory-base 未挂载：裁定照常，项目那份跳过
  const withoutMemory = setup({ withMemory: false });
  assert.equal(
    await approve(
      withoutMemory.host,
      request({ toolName: "read", callId: "r1" }),
    ),
    "allowed-once",
  );
  await flush();
  assert.equal(withoutMemory.service.status().audit.projectWritable, false);
});

test("会话审计不可用：退回人工面板 + 一次警告 + status 降级标记", async () => {
  const { host, service, panel } = setup({ auditDir: null });
  assert.equal(service.status().audit.sessionWritable, false);
  assert.match(service.status().audit.degradedReason ?? "", /session-paths/);
  assert.match(host.logs.join("\n"), /会话审计落点不可得|自动放行已停用/);
  assert.equal(
    await approve(host, request({ toolName: "read", callId: "r1" })),
    "rejected",
  );
  assert.equal(panel.calls, 1);
  assert.equal(service.recent(5).length, 0);
});

test("会话审计首次写入失败：本次不自动裁定（退回面板 + 一次警告）", async () => {
  const root = tempDir();
  // 用同名文件占住会话目录，令首次 append 之前的 mkdir -p 失败
  writeFileSync(join(root, "s1"), "占位", "utf8");
  const { host, panel, service } = setup({ auditDir: root });
  assert.equal(
    await approve(host, request({ toolName: "read", callId: "r1" })),
    "rejected",
  );
  assert.equal(panel.calls, 1, "退回人工面板");
  assert.equal(service.status().audit.sessionWritable, false);
  assert.match(host.logs.join("\n"), /自动放行已停用/);
  assert.equal(service.recent(5).length, 0);
});

test("不消费 security-guard：ctx 无 guard 服务时行为不变", async () => {
  const { host, service } = setup();
  assert.equal(host.services.has("guard"), false);
  assert.equal(
    await approve(host, request({ toolName: "read", callId: "r1" })),
    "allowed-once",
  );
  assert.equal(service.status().readonlyTools > 0, true);
  assert.equal(
    host.logs.some((line) => line.includes("guard")),
    false,
  );
});

test("status 快照字段与名单计数一致", () => {
  const { service } = setup({
    config: {
      allow: { commands: { bash: ["^ls"] }, paths: { read: ["^/var/log/"] } },
      deny: { tools: ["mcp__*"], escalation: { to: ["danger-full-access"] } },
      escalation: { allow: [{ match: "^git", to: ["workspace-write"] }] },
      review: { provider: "p", model: "m" },
    },
  });
  const status = service.status();
  assert.equal(status.enabled, true);
  assert.equal(status.allowRules, 2);
  assert.equal(status.denyRules, 2);
  assert.equal(status.upgradeRules, 1);
  assert.equal(status.readonlyTools, 9);
  assert.equal(status.llmRoute, "p/m");
  assert.equal(status.audit.sessionWritable, true);
});
