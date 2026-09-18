/**
 * GuardEngine + 宿主挂接单测：pre-execute 的 deny/allow 分流、
 * 配置覆盖（enabled / allowPatterns / allowedPaths / 追加规则）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GuardEngine,
  createSecurityGuard,
  name,
  inject,
  apply,
  DEFAULT_COMMAND_RULES,
  type GuardHost,
  type GuardRecord,
  type PreExecuteExecution,
  type PreToolDecision,
} from "../src/index.ts";

const HOME = "/home/tester";

/** 构造最小宿主（记录监听器与日志）。 */
function makeHost(): {
  host: GuardHost;
  listeners: Array<
    (
      exec: PreExecuteExecution,
      next: () => PreToolDecision | Promise<PreToolDecision>,
    ) => PreToolDecision | Promise<PreToolDecision>
  >;
  logs: string[];
} {
  const listeners: ReturnType<typeof makeHost>["listeners"] = [];
  const logs: string[] = [];
  const host: GuardHost = {
    on(_event, cb) {
      listeners.push(cb);
      return () => {};
    },
    logger: () => ({
      info: (m: string) => logs.push(m),
    }),
  };
  return { host, listeners, logs };
}

const nextAllow: () => PreToolDecision = () => ({ kind: "allow" });

function execOf(name: string, args: unknown): PreExecuteExecution {
  return {
    name,
    arguments: args,
    callId: "call-test",
    signal: new AbortController().signal,
  };
}

test("bundle 约定：name / inject / apply 存在", () => {
  assert.equal(name, "security-guard");
  assert.deepEqual([...inject], ["tools"]);
  const { host, listeners, logs } = makeHost();
  apply(host);
  assert.equal(listeners.length, 1);
  assert.ok(logs.some((l) => l.includes("mounted")));
});

test("pre-execute：危险命令 → deny，回执含原因与放行方式", async () => {
  const { host, listeners } = makeHost();
  createSecurityGuard(host, { homeDir: HOME });
  const result = await listeners[0]!(
    execOf("bash", { command: "sudo ls /", description: "测试" }),
    nextAllow,
  );
  assert.equal(result.kind, "deny");
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /\[security-guard\]/);
  assert.match(reason, /原因：/);
  assert.match(reason, /放行方式：/);
  assert.match(reason, /allowPatterns/);
  assert.match(reason, /sudo ls \//);
});

test("pre-execute：rm -rf / → deny（命令面）", async () => {
  const { host, listeners } = makeHost();
  createSecurityGuard(host, { homeDir: HOME });
  const result = await listeners[0]!(
    execOf("bash", { command: "rm -rf /" }),
    nextAllow,
  );
  assert.equal(result.kind, "deny");
  assert.match((result as { reason: string }).reason, /rm-recursive-root/);
});

test("pre-execute：安全命令 → next() 放行", async () => {
  const { host, listeners } = makeHost();
  createSecurityGuard(host, { homeDir: HOME });
  const result = await listeners[0]!(
    execOf("bash", { command: "echo hi && ls -la" }),
    nextAllow,
  );
  assert.deepEqual(result, { kind: "allow" });
});

test("pre-execute：文件工具读敏感路径 → deny（文件工具面）", async () => {
  const { host, listeners } = makeHost();
  createSecurityGuard(host, { homeDir: HOME });
  for (const [tool, args] of [
    ["read", { file_path: "~/.ssh/id_rsa" }],
    ["write", { file_path: "~/.aws/credentials", content: "x" }],
    ["edit", { file_path: "~/.kube/config" }],
    ["grep", { pattern: "token", path: "~/.netrc" }],
    ["glob", { pattern: "*.json", path: "~/.config/gh" }],
  ] as const) {
    const result = await listeners[0]!(execOf(tool, args), nextAllow);
    assert.equal(result.kind, "deny", `expected deny for ${tool}`);
    const reason = (result as { reason: string }).reason;
    assert.match(reason, /允许放行|放行方式：/);
    assert.match(reason, /allowedPaths/);
  }
});

test("pre-execute：shell 命令文本中的敏感路径 → deny", async () => {
  const { host, listeners } = makeHost();
  createSecurityGuard(host, { homeDir: HOME });
  const result = await listeners[0]!(
    execOf("bash", { command: "cat ~/.ssh/id_rsa" }),
    nextAllow,
  );
  assert.equal(result.kind, "deny");
  assert.match((result as { reason: string }).reason, /ssh-directory/);
});

test("pre-execute：bash workdir 敏感 → deny", async () => {
  const { host, listeners } = makeHost();
  createSecurityGuard(host, { homeDir: HOME });
  const result = await listeners[0]!(
    execOf("bash", { command: "ls", workdir: "~/.ssh" }),
    nextAllow,
  );
  assert.equal(result.kind, "deny");
});

test("pre-execute：run_code 内嵌危险命令 → deny", async () => {
  const { host, listeners } = makeHost();
  createSecurityGuard(host, { homeDir: HOME });
  const code = 'import subprocess\nsubprocess.run("rm -rf /", shell=True)';
  const result = await listeners[0]!(execOf("run_code", { code }), nextAllow);
  assert.equal(result.kind, "deny");
});

test("pre-execute：未知工具与参数缺失 → 放行", async () => {
  const { host, listeners } = makeHost();
  createSecurityGuard(host, { homeDir: HOME });
  for (const [tool, args] of [
    ["todo_write", { todos: [] }],
    ["bash", {}],
    ["read", {}],
  ] as const) {
    const result = await listeners[0]!(execOf(tool, args), nextAllow);
    assert.deepEqual(result, { kind: "allow" }, `expected allow for ${tool}`);
  }
});

test("配置覆盖：enabled=false 全放行", () => {
  const guard = new GuardEngine({ enabled: false, homeDir: HOME });
  assert.equal(guard.inspect("bash", { command: "sudo rm -rf /" }), null);
  assert.equal(guard.inspect("read", { file_path: "~/.ssh/id_rsa" }), null);
});

test("配置覆盖：commandBlacklist.enabled=false 仅关命令层", () => {
  const guard = new GuardEngine({
    homeDir: HOME,
    commandBlacklist: { enabled: false },
  });
  assert.equal(guard.inspect("bash", { command: "sudo ls /" }), null);
  // 敏感文件层仍生效
  assert.notEqual(
    guard.inspect("bash", { command: "cat ~/.ssh/id_rsa" }),
    null,
  );
});

test("配置覆盖：allowPatterns 只放开命令层、不放开敏感文件层", () => {
  const guard = new GuardEngine({
    homeDir: HOME,
    commandBlacklist: { allowPatterns: ["^sudo ls /$"] },
  });
  assert.equal(guard.inspect("bash", { command: "sudo ls /" }), null);
  assert.notEqual(guard.inspect("bash", { command: "sudo whoami" }), null);
  // 放行的命令若同时含敏感路径仍被拦
  assert.notEqual(guard.inspect("bash", { command: "sudo ls ~/.ssh" }), null);
});

test("配置覆盖：sensitiveFiles.allowedPaths 只放开敏感文件层", () => {
  const guard = new GuardEngine({
    homeDir: HOME,
    sensitiveFiles: { allowedPaths: ["~/.ssh"] },
  });
  assert.equal(guard.inspect("read", { file_path: "~/.ssh/id_rsa" }), null);
  assert.notEqual(
    guard.inspect("read", { file_path: "~/.aws/credentials" }),
    null,
  );
  // 命令黑名单层仍生效
  assert.notEqual(guard.inspect("bash", { command: "sudo ls /" }), null);
});

test("配置覆盖：追加用户层黑名单规则", () => {
  const guard = new GuardEngine({
    homeDir: HOME,
    commandBlacklist: { rules: ["^git push --force$"] },
  });
  const hit = guard.inspect("bash", { command: "git push --force" });
  assert.notEqual(hit, null);
  assert.match(hit!, /user-rule-1/);
  assert.equal(guard.inspect("bash", { command: "git push" }), null);
});

test("配置覆盖：追加用户层保护路径", () => {
  const guard = new GuardEngine({
    homeDir: HOME,
    sensitiveFiles: { rules: ["~/.vault"] },
  });
  const hit = guard.inspect("read", { file_path: "~/.vault/secrets.txt" });
  assert.notEqual(hit, null);
  assert.match(hit!, /user-path-1/);
  assert.equal(guard.inspect("read", { file_path: "~/.other/x" }), null);
});

test("回执：写类文件工具标注「写入」", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  const hit = guard.inspect("write", { file_path: "~/.env" });
  assert.match(hit ?? "", /写入/);
  const readHit = guard.inspect("read", { file_path: "~/.env" });
  assert.match(readHit ?? "", /读取/);
  const shellHit = guard.inspect("bash", { command: "cat ./.env" });
  assert.match(shellHit ?? "", /读写/);
});

test("记录缓冲：inspect 判定记入 recent()（拦截 + 放行，新在前）", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  guard.inspect("bash", { command: "sudo ls /" });
  guard.inspect("bash", { command: "echo ok" });
  guard.inspect("read", { file_path: "~/.ssh/id_rsa" });
  const records = guard.recent();
  assert.equal(records.length, 3);
  assert.equal(records[0]!.toolName, "read");
  assert.equal(records[0]!.verdict, "deny");
  assert.match(records[0]!.reason ?? "", /ssh-directory/);
  assert.equal(records[1]!.toolName, "bash");
  assert.equal(records[1]!.verdict, "allow");
  assert.equal(records[1]!.reason, undefined);
  assert.equal(records[2]!.toolName, "bash");
  assert.equal(records[2]!.verdict, "deny");
  assert.match(records[2]!.reason ?? "", /sudo/);
  for (const r of records) {
    assert.equal(typeof r.time, "number");
    assert.ok(r.time > 0);
  }
});

test("记录缓冲：有界，超过上限丢弃最旧（上限 200）", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  for (let i = 0; i < 210; i++) {
    guard.inspect("bash", { command: i % 2 === 0 ? "sudo ls /" : "echo ok" });
  }
  assert.equal(guard.recent().length, 200);
  // 最新的两条是最后两次判定（210 为 allow、209 为 deny）
  const last2 = guard.recent().slice(0, 2);
  assert.equal(last2[0]!.verdict, "allow");
  assert.equal(last2[1]!.verdict, "deny");
});

test("记录缓冲：recent() 返回副本，外部修改不影响内部", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  guard.inspect("bash", { command: "echo ok" });
  const recs = guard.recent();
  (recs as GuardRecord[]).length = 0;
  assert.equal(guard.recent().length, 1);
});

test("policy()：返回当前策略/规则快照", () => {
  const guard = new GuardEngine({
    homeDir: HOME,
    commandBlacklist: {
      allowPatterns: ["^echo ok$"],
      rules: ["^git push --force$"],
    },
    sensitiveFiles: { rules: ["~/.vault"], allowedPaths: ["~/.ssh"] },
  });
  const p = guard.policy();
  assert.equal(p.enabled, true);
  assert.equal(p.commandBlacklist.enabled, true);
  assert.equal(p.sensitiveFiles.enabled, true);
  // 默认规则 + 用户追加规则都在快照中
  assert.ok(p.commandBlacklist.rules.length > DEFAULT_COMMAND_RULES.length);
  assert.ok(p.commandBlacklist.rules.some((r) => r.id === "sudo"));
  assert.ok(p.commandBlacklist.rules.some((r) => r.id === "user-rule-1"));
  assert.deepEqual(p.commandBlacklist.allowPatterns, ["^echo ok$"]);
  // 敏感文件层：默认 + 用户追加 + 放行清单
  assert.ok(p.sensitiveFiles.rules.some((r) => r.id === "ssh-directory"));
  assert.ok(p.sensitiveFiles.rules.some((r) => r.id === "user-path-1"));
  assert.ok(p.sensitiveFiles.allowedPaths.some((r) => r.id === "allowed-1"));
  // 快照字段可序列化（无 RegExp / 谓词函数）
  for (const r of p.commandBlacklist.rules) {
    assert.equal(typeof r.id, "string");
    assert.equal(typeof r.reason, "string");
  }
});

test("policy()：enabled=false 与层级开关如实反映", () => {
  const guard = new GuardEngine({
    homeDir: HOME,
    enabled: false,
    commandBlacklist: { enabled: false },
    sensitiveFiles: { enabled: false },
  });
  const p = guard.policy();
  assert.equal(p.enabled, false);
  assert.equal(p.commandBlacklist.enabled, false);
  assert.equal(p.sensitiveFiles.enabled, false);
});
