/**
 * GuardEngine + 宿主挂接单测：pre-execute 的 deny/allow 分流、
 * 配置覆盖（enabled / allowPatterns / allowedPaths / 追加规则）、
 * 插件文件工具登记表（hash_edit / md_logic / ast_replace / ast_query）与未登记工具边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * 临时目录 fixture：含敏感名文件（.env / id_rsa）与普通文件（notes.md）。
 * 敏感名条目（env-file / ssh-rsa-key）按 basename 匹配，任意深度命中。
 */
function makeSensitiveFixture(): {
  dir: string;
  envPath: string;
  keyPath: string;
  normalPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "sg-plugin-"));
  const envPath = join(dir, ".env");
  const keyPath = join(dir, "id_rsa");
  const normalPath = join(dir, "notes.md");
  writeFileSync(envPath, "TOKEN=fixture\n");
  writeFileSync(keyPath, "PRIVATE KEY fixture\n");
  writeFileSync(normalPath, "# notes\n");
  return {
    dir,
    envPath,
    keyPath,
    normalPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

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

test("插件工具：hash_edit 写敏感路径 → deny（pre-execute 回执含工具名与规则）", async () => {
  const fx = makeSensitiveFixture();
  try {
    const { host, listeners } = makeHost();
    createSecurityGuard(host, { homeDir: HOME });
    const result = await listeners[0]!(
      execOf("hash_edit", { path: fx.envPath, edits: [] }),
      nextAllow,
    );
    assert.equal(result.kind, "deny");
    const reason = (result as { reason: string }).reason;
    assert.match(reason, /已拦截：写入敏感文件/);
    assert.match(reason, /env-file/);
    assert.match(reason, /工具：hash_edit/);
    assert.match(reason, /allowedPaths/);
  } finally {
    fx.cleanup();
  }
});

test("配置覆盖：allowedPaths 放行插件工具路径（写侧 / 读侧 / 数组参数）", async () => {
  const fx = makeSensitiveFixture();
  try {
    const { host, listeners } = makeHost();
    createSecurityGuard(host, {
      homeDir: HOME,
      sensitiveFiles: { allowedPaths: [fx.envPath, fx.keyPath] },
    });
    // 写侧：hash_edit 写敏感路径，但命中放行清单 → pre-execute 放行
    const allowed = await listeners[0]!(
      execOf("hash_edit", { path: fx.envPath, edits: [] }),
      nextAllow,
    );
    assert.deepEqual(allowed, { kind: "allow" });
    // 读侧：ast_query 的单值 path 与数组 paths 同样按放行清单逐元素匹配
    const guard = new GuardEngine({
      homeDir: HOME,
      sensitiveFiles: { allowedPaths: [fx.envPath, fx.keyPath] },
    });
    assert.equal(
      guard.inspect("ast_query", { action: "search", path: fx.keyPath }),
      null,
    );
    assert.equal(
      guard.inspect("ast_query", {
        action: "rules",
        paths: [fx.normalPath, fx.keyPath],
      }),
      null,
    );
    assert.equal(
      guard.inspect("md_logic", { action: "replace", path: fx.envPath }),
      null,
    );
    // 未列入放行清单的敏感路径仍被拦（放行是逐条字面/glob 匹配，不误放开同类文件）
    assert.notEqual(
      guard.inspect("hash_edit", {
        path: join(fx.dir, ".env.local"),
        edits: [],
      }),
      null,
    );
  } finally {
    fx.cleanup();
  }
});

test("插件工具：md_logic 只读 action 读敏感路径 → deny（读侧口径，与官方 read/grep/glob 同级）", () => {
  const fx = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({ homeDir: HOME });
    for (const action of ["structure", "blocks", "links"] as const) {
      const hit = guard.inspect("md_logic", { action, path: fx.keyPath });
      assert.notEqual(hit, null, `expected deny for md_logic ${action}`);
      assert.match(hit!, /已拦截：读取敏感文件/);
      assert.match(hit!, /ssh-rsa-key/);
      assert.match(hit!, new RegExp(`工具：md_logic ${action}`));
      assert.doesNotMatch(hit!, /写入/);
    }
  } finally {
    fx.cleanup();
  }
});

test("插件工具：md_logic replace 写敏感路径 → deny（写侧回执，工具名带 action）", () => {
  const fx = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({ homeDir: HOME });
    const hit = guard.inspect("md_logic", {
      action: "replace",
      path: fx.envPath,
      edits: [],
    });
    assert.notEqual(hit, null);
    assert.match(hit!, /已拦截：写入敏感文件/);
    assert.match(hit!, /env-file/);
    assert.match(hit!, /工具：md_logic replace/);
  } finally {
    fx.cleanup();
  }
});

test("插件工具：ast_replace 的 path（写侧，真实参数面无 paths）→ deny", () => {
  const fx = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({ homeDir: HOME });
    const single = guard.inspect("ast_replace", {
      pattern: "$A",
      replacement: "$A",
      language: "ts",
      path: fx.envPath,
    });
    assert.match(single ?? "", /已拦截：写入敏感文件/);
    assert.match(single ?? "", /env-file/);
    assert.match(single ?? "", /工具：ast_replace/);
    // ast_replace 真实参数面只有 path（无 paths）：未登记键不参与判定，故普通 path 仍放行
    assert.equal(
      guard.inspect("ast_replace", {
        path: fx.normalPath,
        paths: [fx.envPath],
      }),
      null,
    );
  } finally {
    fx.cleanup();
  }
});

test("插件工具：ast_query 的 path / paths（读侧）读敏感路径 → deny", () => {
  const fx = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({ homeDir: HOME });
    // 单值 path（search / outline）
    const single = guard.inspect("ast_query", {
      action: "search",
      pattern: "x",
      language: "ts",
      path: fx.keyPath,
    });
    assert.match(single ?? "", /已拦截：读取敏感文件/);
    assert.match(single ?? "", /ssh-rsa-key/);
    assert.match(single ?? "", /工具：ast_query/);
    // paths 数组（rules）：普通路径在前、敏感路径在后仍命中（逐元素检查）
    const after = guard.inspect("ast_query", {
      action: "rules",
      rules: "id: demo",
      paths: [fx.normalPath, fx.envPath, 42],
    });
    assert.match(after ?? "", /已拦截：读取敏感文件/);
    assert.match(after ?? "", /env-file/);
    // 敏感路径在前也命中
    const before = guard.inspect("ast_query", {
      action: "rules",
      paths: [fx.keyPath, fx.normalPath],
    });
    assert.match(before ?? "", /ssh-rsa-key/);
  } finally {
    fx.cleanup();
  }
});

test("插件工具：登记工具读写普通路径 → 放行（不误伤）", () => {
  const fx = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({ homeDir: HOME });
    for (const [tool, args] of [
      ["hash_edit", { path: fx.normalPath, edits: [] }],
      ["md_logic", { action: "structure", path: fx.normalPath }],
      ["md_logic", { action: "replace", path: fx.normalPath, edits: [] }],
      ["ast_replace", { path: fx.normalPath }],
      ["ast_query", { action: "search", path: fx.normalPath }],
      ["ast_query", { action: "rules", paths: [fx.normalPath, fx.normalPath] }],
      // 非 string 元素被忽略，不因类型异常误拦
      ["ast_query", { action: "rules", paths: [42, null, fx.normalPath] }],
    ] as const) {
      assert.equal(
        guard.inspect(tool, args),
        null,
        `expected allow for ${tool}`,
      );
    }
  } finally {
    fx.cleanup();
  }
});

test("回归：官方 write / edit / read / bash 语义不变（插件登记表不影响）", () => {
  const fx = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({ homeDir: HOME });
    const w = guard.inspect("write", { file_path: fx.envPath, content: "x" });
    assert.match(w ?? "", /已拦截：写入敏感文件/);
    assert.match(w ?? "", /工具：write/);
    const e = guard.inspect("edit", { file_path: fx.envPath });
    assert.match(e ?? "", /已拦截：写入敏感文件/);
    assert.match(e ?? "", /工具：edit/);
    const r = guard.inspect("read", { file_path: fx.keyPath });
    assert.match(r ?? "", /已拦截：读取敏感文件/);
    const shell = guard.inspect("bash", { command: `cat "${fx.envPath}"` });
    assert.match(shell ?? "", /已拦截：读写敏感文件/);
    // 官方工具写普通路径仍放行
    assert.equal(
      guard.inspect("write", { file_path: fx.normalPath, content: "x" }),
      null,
    );
    assert.equal(guard.inspect("edit", { file_path: fx.normalPath }), null);
  } finally {
    fx.cleanup();
  }
});

test("边界回归：未登记工具（含其它只读插件工具）仍不拦", () => {
  const fx = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({ homeDir: HOME });
    // ast_query 已登记（读侧）→ 不在本清单；此处只列未登记工具名
    for (const [tool, args] of [
      ["fs_digest", { path: fx.keyPath }],
      ["md_map", { action: "index", root: fx.dir }],
      ["todo_write", { todos: [] }],
      ["read", {}],
      ["bash", {}],
    ] as const) {
      assert.equal(
        guard.inspect(tool, args),
        null,
        `expected allow for ${tool}`,
      );
    }
  } finally {
    fx.cleanup();
  }
});

test("边界回归：原型链属性名（constructor / toString / valueOf）作工具名 → 放行不抛", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  for (const tool of ["constructor", "toString", "valueOf"] as const) {
    // 这些名字会命中 Object.prototype：必须按「未登记工具」放行，不得抛 TypeError
    assert.equal(
      guard.inspect(tool, { path: "~/.ssh/id_rsa", paths: ["~/.env"] }),
      null,
      `expected allow (no throw) for ${tool}`,
    );
  }
});
