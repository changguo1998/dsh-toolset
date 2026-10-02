/**
 * GuardEngine + 宿主挂接单测：pre-execute 的 deny/allow 分流、
 * 配置覆盖（enabled / allowPatterns / allowedPaths / 追加规则）、
 * 官方文件工具（read / write / edit / patch / grep / glob 与读面 read_image）、
 * 插件文件工具登记表（写面 hash_edit / md_logic / ast_replace；读面 ast_query /
 * hash_read / fs_digest / code_map / md_map）、插件命令工具登记表
 * （metric_loop.measureCmd / task_decompose 的嵌套命令）与未登记工具边界
 * （`unknownToolPolicy` 三态 allow / check / deny + `unknownToolAllowlist`）；
 * 以及外部命令复查 `inspectCommand`（命令不在工具入参里的场景，如 metric-loop 的 tick
 * 执行状态文件里的 measureCmd）与服务面暴露。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GuardEngine,
  createSecurityGuard,
  name,
  inject,
  apply,
  DEFAULT_COMMAND_RULES,
  TOOL_SURFACE,
  type GuardHost,
  type GuardRecord,
  type GuardService,
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
      assert.match(hit!, /已拦截：读取敏感文件/);
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

test("插件工具：读面四工具读敏感路径 → deny（读侧回执 + 工具名）", () => {
  const fx = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({ homeDir: HOME });
    for (const [tool, args, ruleId] of [
      // hash_read / fs_digest：单值 path（读工具，返回行内容 / 摘要）
      ["hash_read", { path: fx.envPath, offset: 1, limit: 50 }, "env-file"],
      ["fs_digest", { path: fx.keyPath, mode: "outline" }, "ssh-rsa-key"],
      // code_map：root（缺省 cwd），此处指向凭据目录
      ["code_map", { action: "index", root: "~/.ssh" }, "ssh-directory"],
      // md_map：root 建索引 / path 查文档（path 相对 root，basename 语义同样命中）
      ["md_map", { action: "index", root: "~/.ssh" }, "ssh-directory"],
      ["md_map", { action: "callers", path: ".env", root: fx.dir }, "env-file"],
    ] as const) {
      const hit = guard.inspect(tool, args);
      assert.notEqual(hit, null, `expected deny for ${tool}`);
      assert.match(hit!, /已拦截：读取敏感文件/);
      assert.match(hit!, new RegExp(ruleId));
      assert.match(hit!, new RegExp(`工具：${tool}`));
      assert.match(hit!, /allowedPaths/);
      // 读面工具不得被标成写侧
      assert.match(hit!, /已拦截：读取敏感文件/);
    }
  } finally {
    fx.cleanup();
  }
});

test("插件工具：hash_read 读敏感路径 → deny（pre-execute 回执为读侧措辞）", async () => {
  const fx = makeSensitiveFixture();
  try {
    const { host, listeners } = makeHost();
    createSecurityGuard(host, { homeDir: HOME });
    const result = await listeners[0]!(
      execOf("hash_read", { path: fx.keyPath, offset: 1, limit: 50 }),
      nextAllow,
    );
    assert.equal(result.kind, "deny");
    const reason = (result as { reason: string }).reason;
    assert.match(reason, /已拦截：读取敏感文件/);
    assert.match(reason, /ssh-rsa-key/);
    assert.match(reason, /工具：hash_read/);
    assert.match(reason, /放行方式：/);
  } finally {
    fx.cleanup();
  }
});

test("插件工具：读面四工具读普通路径 → 放行（不误伤）", () => {
  const fx = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({ homeDir: HOME });
    for (const [tool, args] of [
      ["hash_read", { path: fx.normalPath, offset: 1, limit: 50 }],
      ["fs_digest", { path: fx.normalPath, mode: "pruned" }],
      ["code_map", { action: "index", root: fx.dir }],
      ["code_map", { action: "summary" }],
      ["md_map", { action: "index", root: fx.dir }],
      ["md_map", { action: "callers", path: "notes.md", root: fx.dir }],
      // 非 string 值被忽略，不因类型异常误拦
      ["hash_read", { path: 42 }],
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

test("插件工具：读面工具参数缺失 / root 缺省 → 放行（不产路径，不猜测语义）", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  for (const [tool, args] of [
    ["hash_read", {}],
    ["hash_read", { offset: 1, limit: 10 }],
    ["fs_digest", { mode: "outline" }],
    // root 缺省 = 会话 cwd（不在入参里）→ 不产路径
    ["code_map", { action: "index" }],
    ["code_map", { action: "summary" }],
    ["md_map", { action: "index" }],
    ["md_map", { action: "report" }],
    // 相对路径且普通名 → 放行；空串不产路径
    ["md_map", { action: "callers", path: "notes.md" }],
    ["md_map", { action: "index", root: "" }],
  ] as const) {
    assert.equal(guard.inspect(tool, args), null, `expected allow for ${tool}`);
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

test("插件命令工具：metric_loop{measureCmd} 命中黑名单 → deny（回执含工具名、参数与规则 id）", async () => {
  const { host, listeners } = makeHost();
  createSecurityGuard(host, { homeDir: HOME });
  const result = await listeners[0]!(
    execOf("metric_loop", { action: "start", measureCmd: "sudo ls /" }),
    nextAllow,
  );
  assert.equal(result.kind, "deny");
  const reason = (result as { reason: string }).reason;
  // 来源标注（工具名 + 命令参数路径）+ 标准命令回执（规则 id / 原因 / 放行方式）
  assert.match(reason, /插件命令工具「metric_loop」/);
  assert.match(reason, /命令参数（measureCmd）/);
  assert.match(reason, /命令命中黑名单规则「sudo」/);
  assert.match(reason, /原因：/);
  assert.match(reason, /放行方式：/);
  // 引擎直调：与 bash 同文本走同一条规则（同一命令黑名单层）
  const guard = new GuardEngine({ homeDir: HOME });
  assert.match(
    guard.inspect("metric_loop", {
      action: "start",
      measureCmd: "sudo ls /",
    }) ?? "",
    /「sudo」/,
  );
});

test("插件命令工具：task_decompose 的嵌套命令（executor / mechanical 验收）→ deny", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  // children[].executor.command（command 后端，执行在 task_execute）
  const executorHit = guard.inspect("task_decompose", {
    parent_id: "root",
    children: [
      {
        id: "c1",
        title: "跑测量",
        spec: "跑测量命令",
        acceptance: [{ id: "a1", check: "输出数字", level: "mechanical" }],
        need_decompose: false,
        executor: { kind: "command", command: "sudo ls /" },
      },
    ],
  });
  assert.notEqual(executorHit, null);
  assert.match(executorHit!, /插件命令工具「task_decompose」/);
  assert.match(executorHit!, /children\[\]\.executor\.command/);
  assert.match(executorHit!, /「sudo」/);
  // children[].acceptance[].command（mechanical 验收，执行在 task_stop；文本在声明处检查）
  const acceptanceHit = guard.inspect("task_decompose", {
    parent_id: "root",
    children: [
      {
        id: "c1",
        title: "跑测量",
        spec: "跑测量命令",
        acceptance: [
          {
            id: "a1",
            check: "输出数字",
            level: "mechanical",
            command: "rm -rf .",
          },
        ],
        need_decompose: false,
      },
    ],
  });
  assert.match(acceptanceHit ?? "", /children\[\]\.acceptance\[\]\.command/);
  assert.match(acceptanceHit ?? "", /rm-recursive-root/);
});

test("插件命令工具：普通命令 / 无命令声明 / model 后端 → 放行（不误伤）", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  for (const [tool, args] of [
    // metric_loop：普通测量命令与不带命令的 action
    ["metric_loop", { action: "start", measureCmd: "echo 42" }],
    ["metric_loop", { action: "tick", id: "default", wake: "auto" }],
    ["task_decompose", { parent_id: "root" }],
    // task_decompose：model 后端 + 普通验收命令
    [
      "task_decompose",
      {
        parent_id: "root",
        children: [
          {
            id: "c1",
            title: "写文档",
            spec: "更新文档",
            acceptance: [
              {
                id: "a1",
                check: "命令通过",
                level: "mechanical",
                command: "npm run check",
              },
            ],
            need_decompose: false,
            executor: { kind: "model" },
          },
        ],
      },
    ],
    // task_decompose：command 后端 + 普通命令
    [
      "task_decompose",
      {
        parent_id: "root",
        children: [
          {
            id: "c2",
            title: "跑检查",
            spec: "跑检查命令",
            acceptance: [{ id: "a1", check: "退出码 0", level: "mechanical" }],
            need_decompose: false,
            executor: { kind: "command", command: "npm run test" },
          },
        ],
      },
    ],
    // 执行侧工具入参只有 task_id（命令文本不在入参里，见 README 边界）
    ["task_execute", { task_id: "c2" }],
    ["task_stop", { task_id: "c2" }],
  ] as const) {
    assert.equal(guard.inspect(tool, args), null, `expected allow for ${tool}`);
  }
});

test("插件命令工具：命令文本含敏感文件名路径 → deny（敏感层，读写口径）", async () => {
  const fx = makeSensitiveFixture();
  try {
    const { host, listeners } = makeHost();
    createSecurityGuard(host, { homeDir: HOME });
    const result = await listeners[0]!(
      execOf("metric_loop", {
        action: "start",
        measureCmd: `cat "${fx.envPath}"`,
      }),
      nextAllow,
    );
    assert.equal(result.kind, "deny");
    const reason = (result as { reason: string }).reason;
    // 命令经 shell 执行：与 shell 工具同口径标「读写」，回执含工具名与规则 id
    assert.match(reason, /已拦截：读写敏感文件/);
    assert.match(reason, /env-file/);
    assert.match(reason, /工具：metric_loop/);
    assert.match(reason, /allowedPaths/);
    // 嵌套命令文本同样过路径抽取（fixture 目录下的敏感文件名，非真实家目录路径）
    const guard = new GuardEngine({ homeDir: HOME });
    const nested = guard.inspect("task_decompose", {
      parent_id: "root",
      children: [
        {
          id: "c1",
          title: "检查文件",
          spec: "检查文件存在",
          acceptance: [
            {
              id: "a1",
              check: "文件存在",
              level: "mechanical",
              command: `test -f ${fx.keyPath}`,
            },
          ],
          need_decompose: false,
        },
      ],
    });
    assert.match(nested ?? "", /已拦截：读写敏感文件/);
    assert.match(nested ?? "", /工具：task_decompose/);
    assert.match(nested ?? "", /ssh-rsa-key/);
    // allowPatterns 只放开命令层，不放开敏感层（与 shell 工具同口径）
    const allowed = new GuardEngine({
      homeDir: HOME,
      commandBlacklist: { allowPatterns: ["^cat "] },
    });
    assert.notEqual(
      allowed.inspect("metric_loop", {
        action: "start",
        measureCmd: `cat "${fx.envPath}"`,
      }),
      null,
    );
  } finally {
    fx.cleanup();
  }
});

test("插件命令工具：命令参数缺失 / 非 string / 空串 → 放行（不猜测语义）", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  for (const [tool, args] of [
    ["metric_loop", {}],
    ["metric_loop", { action: "status" }],
    ["metric_loop", { action: "start", measureCmd: 42 }],
    ["metric_loop", { action: "start", measureCmd: "" }],
    ["metric_loop", { action: "start", measureCmd: ["sudo ls /"] }],
    ["metric_loop", { action: "start", measureCmd: null }],
    ["task_decompose", {}],
    // children 非数组 / 空数组 / 元素非对象：嵌套路径取不到 string，按缺失处理
    ["task_decompose", { parent_id: "root", children: "sudo ls /" }],
    ["task_decompose", { parent_id: "root", children: [] }],
    ["task_decompose", { parent_id: "root", children: [null, 42] }],
    [
      "task_decompose",
      { parent_id: "root", children: [{ executor: { kind: "command" } }] },
    ],
    [
      "task_decompose",
      {
        parent_id: "root",
        children: [{ executor: { command: 42, kind: "command" } }],
      },
    ],
    [
      "task_decompose",
      { parent_id: "root", children: [{ acceptance: [{ command: null }] }] },
    ],
    // 非数组的嵌套值不做隐式包装
    [
      "task_decompose",
      { parent_id: "root", children: { executor: { command: "sudo ls /" } } },
    ],
  ] as const) {
    assert.equal(guard.inspect(tool, args), null, `expected allow for ${tool}`);
  }
});

test("回归：命令工具登记不影响 shell / run_code / 官方文件工具与未登记工具语义", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  // shell 工具回执保持原样（无插件来源标注行），规则命中不变
  const shell = guard.inspect("bash", { command: "sudo ls /" });
  assert.match(shell ?? "", /命令命中黑名单规则「sudo」/);
  assert.doesNotMatch(shell ?? "", /拦截来源/);
  assert.equal(guard.inspect("bash", { command: "echo ok" }), null);
  assert.match(
    guard.inspect("run_code", { code: "rm -rf /" }) ?? "",
    /rm-recursive-root/,
  );
  assert.match(
    guard.inspect("read", { file_path: "~/.ssh/id_rsa" }) ?? "",
    /ssh-directory/,
  );
  // 未登记工具即使入参形态与登记工具相同也不参与判定（白名单语义）
  assert.equal(
    guard.inspect("todo_write", {
      children: [{ executor: { kind: "command", command: "sudo ls /" } }],
    }),
    null,
  );
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
    // ast_query 与读面四工具（hash_read / fs_digest / code_map / md_map）均已登记
    // → 不在本清单；此处只列未登记工具名
    for (const [tool, args] of [
      ["context_report", { session_id: "s1", detail: "summary" }],
      ["rule_list", {}],
      ["metric_loop", { action: "status" }],
      ["todo_write", { todos: [] }],
      ["read", {}],
      ["bash", {}],
      // 未登记工具的入参完全不参与判定：即使塞进敏感路径文本也放行（白名单语义）
      ["session_channel", { action: "peers", path: fx.keyPath }],
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

test("官方工具：read_image 读敏感路径 → deny（读侧回执 + 规则 id，与 read 同级）", () => {
  const fx = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({ homeDir: HOME });
    for (const [filePath, ruleId] of [
      [fx.envPath, "env-file"],
      [fx.keyPath, "ssh-rsa-key"],
    ] as const) {
      const hit = guard.inspect("read_image", { file_path: filePath });
      assert.notEqual(hit, null, `expected deny for read_image ${filePath}`);
      assert.match(hit!, /已拦截：读取敏感文件/);
      assert.match(hit!, new RegExp(`规则「${ruleId}」`));
      assert.match(hit!, /工具：read_image/);
      assert.match(hit!, /放行方式：/);
      // 读面工具不得被标成写侧
      assert.match(hit!, /已拦截：读取敏感文件/);
      // 同路径经官方 read 命中同一规则（read_image 与 read 同级口径）
      assert.match(
        guard.inspect("read", { file_path: filePath }) ?? "",
        new RegExp(`规则「${ruleId}」`),
      );
    }
  } finally {
    fx.cleanup();
  }
});

test("官方工具：read_image 读普通路径 / 参数缺失 → 放行（不误伤）", () => {
  const fx = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({ homeDir: HOME });
    // 守卫只按路径判定：普通名文件放行；缺省 / 非 string 的 file_path 不产路径
    assert.equal(
      guard.inspect("read_image", { file_path: fx.normalPath }),
      null,
    );
    assert.equal(guard.inspect("read_image", {}), null);
    assert.equal(guard.inspect("read_image", { file_path: 42 }), null);
  } finally {
    fx.cleanup();
  }
});

test("插件工具：code_map 的 root 为目录名命中 basename 型规则 → deny（宁可误拦口径）", () => {
  const fx = makeSensitiveFixture();
  try {
    // 目录名本身命中 basename 型 glob 规则（.env.*）：只按传入路径本身判定，不扫目录内容
    const sensitiveDir = join(fx.dir, "x", ".env.d");
    mkdirSync(sensitiveDir, { recursive: true });
    const guard = new GuardEngine({ homeDir: HOME });
    const hit = guard.inspect("code_map", {
      action: "index",
      root: sensitiveDir,
    });
    assert.notEqual(hit, null);
    assert.match(hit!, /已拦截：读取敏感文件/);
    assert.match(hit!, /env-variant/);
    assert.match(hit!, /工具：code_map/);
    assert.match(hit!, /已拦截：读取敏感文件/);
    // 同目录树内的普通名父目录不命中（规则按 basename / 路径本身，不递归内容）
    assert.equal(
      guard.inspect("code_map", { action: "index", root: join(fx.dir, "x") }),
      null,
    );
  } finally {
    fx.cleanup();
  }
});

test("配置覆盖：allowedPaths 放行读面四工具（hash_read / fs_digest / code_map / md_map）", () => {
  const fx = makeSensitiveFixture();
  try {
    const sensitiveDir = join(fx.dir, "x", ".env.d");
    mkdirSync(sensitiveDir, { recursive: true });
    // 各工具的登记路径参数指向敏感名路径（读侧），放行清单逐条命中该路径
    const cases = [
      [
        "hash_read",
        { path: fx.envPath, offset: 1, limit: 50 },
        fx.envPath,
        /env-file/,
      ],
      [
        "fs_digest",
        { path: fx.keyPath, mode: "outline" },
        fx.keyPath,
        /ssh-rsa-key/,
      ],
      [
        "code_map",
        { action: "index", root: sensitiveDir },
        sensitiveDir,
        /env-variant/,
      ],
      [
        "md_map",
        { action: "index", root: sensitiveDir },
        sensitiveDir,
        /env-variant/,
      ],
    ] as const;
    for (const [tool, args, allowedPath, ruleId] of cases) {
      // 未放行时仍被拦（放行清单是唯一变量）
      const denied = new GuardEngine({ homeDir: HOME });
      assert.match(
        denied.inspect(tool, args) ?? "",
        ruleId,
        `expected deny for ${tool}`,
      );
      // allowedPaths 命中该路径 → 放行
      const allowed = new GuardEngine({
        homeDir: HOME,
        sensitiveFiles: { allowedPaths: [allowedPath] },
      });
      assert.equal(
        allowed.inspect(tool, args),
        null,
        `expected allow for ${tool}`,
      );
    }
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 外部命令复查（inspectCommand）：给「命令不在工具入参里」的场景补执行前检查点
// （metric-loop 的 tick 执行状态文件里的 spec.measureCmd；追踪文档
// docs/implementation/2026-10-02-metric-loop-state-cmd-check.md）。
// ---------------------------------------------------------------------------

/** 命中 sudo 规则的无害命令文本（拼接构造：仓库内不出现真实危险命令字面量）。 */
function riskyCommand(): string {
  return `echo 0 # su${"do"} --version`;
}

test("命令复查：inspectCommand 命中默认黑名单 → deny 回执（含来源标注、规则 id、放行方式）", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  const receipt = guard.inspectCommand(
    riskyCommand(),
    "metric_loop{tick} id=p1",
  );
  assert.notEqual(receipt, null);
  // 首行来源标注（模型据此知道被拦的是状态文件里的命令，而非本次工具入参）
  assert.match(
    receipt!,
    /^\[security-guard\] 命令复查来源：metric_loop\{tick\} id=p1。/,
  );
  assert.match(receipt!, /命令命中黑名单规则「sudo」/);
  assert.match(receipt!, /原因：/);
  assert.match(receipt!, /放行方式：/);
  // 与 shell 工具同口径：同一文本经 bash 工具也被同一条规则拦
  assert.match(
    guard.inspect("bash", { command: riskyCommand() }) ?? "",
    /「sudo」/,
  );
  // 普通命令 / 空命令 → 放行
  assert.equal(guard.inspectCommand("echo 42", "metric_loop{tick}"), null);
  assert.equal(guard.inspectCommand(""), null);
});

test("命令复查：判定记入 recent()（toolName = 来源标注，新在前）", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  assert.notEqual(
    guard.inspectCommand(riskyCommand(), "metric_loop{tick} id=p1"),
    null,
  );
  assert.equal(
    guard.inspectCommand("echo 42", "metric_loop{tick} id=p1"),
    null,
  );
  const records = guard.recent();
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => [r.toolName, r.verdict]),
    [
      ["metric_loop{tick} id=p1", "allow"],
      ["metric_loop{tick} id=p1", "deny"],
    ],
  );
  assert.match(records[1]?.reason ?? "", /「sudo」/);
});

test("命令复查：allowPatterns / 关层 / 敏感路径 / 非字符串防御（与 shell 同口径）", () => {
  const allowSudo = {
    homeDir: HOME,
    commandBlacklist: { allowPatterns: ["\\bsu" + "do\\b"] },
  };
  // allowPatterns 只放开命令层：命令面命中规则也放行
  const allowed = new GuardEngine(allowSudo);
  assert.equal(allowed.inspectCommand(riskyCommand(), "src"), null);
  assert.equal(allowed.inspectCommand(`su${"do"} -n true`, "src"), null);
  // 命令黑名单层关闭 → 命令面放行；总开关关闭 → 全放行
  assert.equal(
    new GuardEngine({
      homeDir: HOME,
      commandBlacklist: { enabled: false },
    }).inspectCommand(`su${"do"} -n true`, "src"),
    null,
  );
  assert.equal(
    new GuardEngine({ homeDir: HOME, enabled: false }).inspectCommand(
      `su${"do"} -n true`,
      "src",
    ),
    null,
  );
  // 敏感文件层同口径（命令内路径；命令面按读写措辞，工具名 = 来源标注）
  const fx = makeSensitiveFixture();
  try {
    const hit = new GuardEngine({ homeDir: HOME }).inspectCommand(
      `cat ${fx.envPath}`,
      "metric_loop{tick} id=p1",
    );
    assert.match(hit ?? "", /读写敏感文件/);
    assert.match(hit ?? "", /工具：metric_loop\{tick\} id=p1/);
  } finally {
    fx.cleanup();
  }
  // 防御：服务面是跨包结构调用，非字符串按「无命令」放行且不抛
  const guard = new GuardEngine({ homeDir: HOME });
  assert.equal(guard.inspectCommand(undefined as unknown as string), null);
  assert.equal(guard.inspectCommand(42 as unknown as string, ""), null);
});

test("服务面：provide('guard') 暴露 inspectCommand（与 recent / policy 同面、同一引擎记账）", () => {
  const provided = new Map<string, unknown>();
  const host: GuardHost & { provide: (name: string, value: unknown) => void } =
    {
      on: () => () => {},
      logger: () => ({ info: () => {} }),
      provide: (serviceName, value) => {
        provided.set(serviceName, value);
      },
    };
  apply(host, { homeDir: HOME });
  const service = provided.get("guard") as GuardService;
  assert.equal(typeof service.recent, "function");
  assert.equal(typeof service.policy, "function");
  assert.equal(typeof service.inspectCommand, "function");
  // 经服务面复查：命中 → 回执；普通 → null（来源缺省 external-command）
  assert.match(
    service.inspectCommand(riskyCommand(), "metric_loop{tick} id=p1") ?? "",
    /命令复查来源：metric_loop\{tick\} id=p1/,
  );
  assert.equal(service.inspectCommand("echo 1"), null);
  // 与 pre-execute 用同一引擎实例 → recent() 能看到这两次复查
  assert.deepEqual(
    service.recent().map((r) => r.verdict),
    ["allow", "deny"],
  );
});

// ---------------------------------------------------------------------------
// 命令层优先级与放行：命令层与敏感层同时命中 → 只回命令层（命令层先判即返回）；
// 插件命令层的 allowPatterns 正向放行（对照：不匹配 / 空则仍被拦）。
// ---------------------------------------------------------------------------

test("命令层 + 敏感层同时命中：只回命令层（来源标注 + 规则 id，不含敏感层文案）", async () => {
  const fx = makeSensitiveFixture();
  try {
    // 同一条命令文本：黑名单命中（"su"+"do" 拼接，仓库内不出现危险命令字面量）
    // + 敏感文件名路径（临时目录 fixture 的 .env，非真实家目录路径）
    const command = `cat "${fx.envPath}" # su${"do"} --version`;
    const { host, listeners } = makeHost();
    createSecurityGuard(host, { homeDir: HOME });
    const result = await listeners[0]!(
      execOf("metric_loop", { action: "start", measureCmd: command }),
      nextAllow,
    );
    assert.equal(result.kind, "deny");
    const reason = (result as { reason: string }).reason;
    // 命令层信息齐全：来源标注（工具名 + 命令参数路径）+ 规则 id + 原因 + 放行方式
    assert.match(reason, /插件命令工具「metric_loop」/);
    assert.match(reason, /命令参数（measureCmd）/);
    assert.match(reason, /命令命中黑名单规则「sudo」/);
    assert.match(reason, /原因：/);
    assert.match(reason, /放行方式：/);
    assert.match(reason, /commandBlacklist\.allowPatterns/);
    // 敏感层文案完全不出现：命令层命中即返回，不回落到敏感层
    assert.doesNotMatch(reason, /已拦截：读取敏感文件/);
    assert.doesNotMatch(reason, /敏感文件/);
    assert.doesNotMatch(reason, /allowedPaths/);
    // 反证：同一路径去掉命令层命中后，敏感层确实命中（不是路径没被识别）
    const guard = new GuardEngine({ homeDir: HOME });
    assert.match(
      guard.inspect("metric_loop", {
        action: "start",
        measureCmd: `cat "${fx.envPath}"`,
      }) ?? "",
      /已拦截：读写敏感文件/,
    );
    // shell 工具同口径：同文本同样由命令层短路（回执无敏感层文案）
    const shellHit = guard.inspect("bash", { command }) ?? "";
    assert.match(shellHit, /「sudo」/);
    assert.doesNotMatch(shellHit, /敏感文件/);
  } finally {
    fx.cleanup();
  }
});

test("插件命令工具：allowPatterns 正向放行（对照：不匹配 / 空的 allowPatterns 仍被拦）", async () => {
  const command = riskyCommand();
  // 能匹配该命令文本的放行正则（与 command 同款拼接构造）
  const allowPattern = `^echo 0 # su${"do"} --version$`;
  const { host, listeners } = makeHost();
  createSecurityGuard(host, {
    homeDir: HOME,
    commandBlacklist: { allowPatterns: [allowPattern] },
  });
  // 放行：命令层被 allowPatterns 打开 → 落到 next()（同文件既有 allow 断言风格）
  assert.deepEqual(
    await listeners[0]!(
      execOf("metric_loop", { action: "start", measureCmd: command }),
      nextAllow,
    ),
    { kind: "allow" },
  );
  // 引擎直调同一判定口径
  assert.equal(
    new GuardEngine({
      homeDir: HOME,
      commandBlacklist: { allowPatterns: [allowPattern] },
    }).inspect("metric_loop", { action: "start", measureCmd: command }),
    null,
  );
  // 对照：同命令在不匹配（或空）的 allowPatterns 下仍被命令层拦（放行按正则匹配生效）
  for (const allowPatterns of [["^echo 42$"], []] as const) {
    const hit = new GuardEngine({
      homeDir: HOME,
      commandBlacklist: { allowPatterns },
    }).inspect("metric_loop", { action: "start", measureCmd: command });
    assert.notEqual(hit, null);
    assert.match(hit!, /插件命令工具「metric_loop」/);
    assert.match(hit!, /命令命中黑名单规则「sudo」/);
  }
});

test("unknownToolPolicy：缺省 allow —— 未登记工具带 path 仍放行（行为回归）", () => {
  const guard = new GuardEngine({ homeDir: HOME });
  assert.equal(guard.inspect("some_unknown_tool", { path: "/tmp/x" }), null);
  assert.equal(
    guard.inspect("another_unknown", { measureCmd: "echo ok" }),
    null,
  );
});

test("unknownToolPolicy:deny —— 只拦携带潜在路径/命令参数的未登记工具", () => {
  const guard = new GuardEngine({ homeDir: HOME, unknownToolPolicy: "deny" });
  const hit = guard.inspect("some_unknown_tool", { path: "/tmp/x" });
  assert.ok(typeof hit === "string", "带 path 的未登记工具应被拦");
  assert.match(hit as string, /some_unknown_tool/);
  assert.match(hit as string, /path/);
  assert.match(hit as string, /放行方式/);
  // 数组元素一层（files[].path）与嵌套对象一层（executor.command）
  const arrHit = guard.inspect("other_unknown", {
    files: [{ path: "/tmp/y" }],
  });
  assert.ok(typeof arrHit === "string" && /path/.test(arrHit as string));
  const nestedHit = guard.inspect("nested_unknown", {
    spec: { command: "echo ok" },
  });
  assert.ok(
    typeof nestedHit === "string" && /command/.test(nestedHit as string),
  );
  // 防误伤：无路径/命令参数的未登记工具仍放行
  assert.equal(guard.inspect("plain_unknown", { id: "x", symbol: "y" }), null);
  assert.equal(guard.inspect("empty_unknown", {}), null);
});

test("unknownToolPolicy:deny —— 已登记与官方工具判定与缺省一致", () => {
  const strict = new GuardEngine({ homeDir: HOME, unknownToolPolicy: "deny" });
  const loose = new GuardEngine({ homeDir: HOME });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["read", { file_path: "/tmp/notes.txt" }],
    ["bash", { command: "echo ok" }],
    ["hash_read", { path: "/tmp/notes.txt" }],
    ["metric_loop", { action: "start", measureCmd: "echo 42" }],
  ];
  for (const [tool, args] of cases) {
    assert.equal(
      strict.inspect(tool, args),
      loose.inspect(tool, args),
      `${tool} 的判定不应受 unknownToolPolicy 影响`,
    );
  }
});

/** check 模式的命令键用例：黑名单命中命令按拼接构造（不在测试文件里写危险命令字面量）。 */
const CHECK_BLACKLIST_COMMAND = `echo ${["su", "do ls /"].join("")}`;

// ---------------------------------------------------------------- check 模式（D1）
// 键类定向：命令键（command / measureCmd / cmd）→ 命令黑名单层；
// 路径键与值面绝对路径 → 敏感文件层；代码键（script / code / program）只做路径提取。

test("unknownToolPolicy:check —— 缺省 allow 不受影响（未登记工具带敏感参数仍放行）", () => {
  const fixture = makeSensitiveFixture();
  try {
    const args = { files: [{ path: fixture.envPath }] };
    assert.equal(
      new GuardEngine({ homeDir: HOME }).inspect("present", args),
      null,
      "缺省 allow 必须与历史行为逐字一致（不因新增 check 而开始判定）",
    );
    assert.ok(
      typeof new GuardEngine({
        homeDir: HOME,
        unknownToolPolicy: "check",
      }).inspect("present", args) === "string",
      "同一参数在 check 下应被敏感层拦（对照）",
    );
  } finally {
    fixture.cleanup();
  }
});

test("unknownToolPolicy:check —— 普通路径放行、敏感路径经敏感层拦（含 present 的真实参数面）", () => {
  const fixture = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({
      homeDir: HOME,
      unknownToolPolicy: "check",
    });
    // present 的唯一必填参数面是 files[].path（数组元素一层键）——普通路径放行
    assert.equal(
      guard.inspect("present", {
        files: [{ path: fixture.normalPath, description: "交付物" }],
      }),
      null,
    );
    // 敏感路径 → 敏感层拦：回执前置来源标注 + 读写口径 + 规则 id + 放行方式
    const hit = guard.inspect("present", {
      files: [{ path: fixture.envPath }],
    });
    assert.ok(typeof hit === "string", "check 下敏感路径应被拦");
    const receipt = hit as string;
    assert.match(receipt, /路径复查来源：未登记工具「present」的 path。/);
    assert.match(receipt, /读写敏感文件/);
    assert.match(receipt, /env-file/);
    assert.match(receipt, /放行方式：/);
    // 参数缺失 / 无 watched 键 / 空数组 → 放行（不猜测语义）
    assert.equal(guard.inspect("present", { files: [] }), null);
    assert.equal(
      guard.inspect("plain_unknown", { id: "x", symbol: "y" }),
      null,
    );
    assert.equal(guard.inspect("present", {}), null);
  } finally {
    fixture.cleanup();
  }
});

test("unknownToolPolicy:check —— 命令键（command / measureCmd / cmd）整段过命令黑名单层", () => {
  const guard = new GuardEngine({ homeDir: HOME, unknownToolPolicy: "check" });
  for (const key of ["command", "measureCmd", "cmd"]) {
    const hit = guard.inspect("unknown_runner", {
      [key]: CHECK_BLACKLIST_COMMAND,
    });
    assert.ok(typeof hit === "string", `${key} 命中黑名单应被拦`);
    const receipt = hit as string;
    assert.match(
      receipt,
      new RegExp(`命令复查来源：未登记工具「unknown_runner」的 ${key}。`),
    );
    assert.match(receipt, /命令命中黑名单规则「sudo」/);
    assert.match(receipt, /放行方式：/);
  }
  // 安全命令放行；命令参数缺失 / 非字符串 → 放行
  assert.equal(guard.inspect("unknown_runner", { command: "echo ok" }), null);
  assert.equal(guard.inspect("unknown_runner", { command: 42 }), null);
  assert.equal(guard.inspect("unknown_runner", { timeoutMs: 100 }), null);
  // allowPatterns（既有放行面）在 check 下同样生效，且只放开命令层
  const allowed = new GuardEngine({
    homeDir: HOME,
    unknownToolPolicy: "check",
    commandBlacklist: { allowPatterns: ["^echo "] },
  });
  assert.equal(
    allowed.inspect("unknown_runner", { command: CHECK_BLACKLIST_COMMAND }),
    null,
  );
});

test("unknownToolPolicy:check —— 代码键（script / code / program）只做路径提取，不整段过命令层", () => {
  const fixture = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({
      homeDir: HOME,
      unknownToolPolicy: "check",
    });
    // workflow 的 script 是 JS 编排脚本（不是 shell 命令串）：安全脚本放行
    assert.equal(
      guard.inspect("workflow", { script: "const a = 1;\nreturn a;" }),
      null,
    );
    // 代码文本里出现提权词**字面**（不是执行该命令）→ 放行：不整段过命令层，避免误拦
    assert.equal(
      guard.inspect("workflow", {
        script: `const note = ${JSON.stringify(CHECK_BLACKLIST_COMMAND)};`,
      }),
      null,
    );
    // 代码里出现敏感路径 → 路径提取后过敏感层拦（读侧口径的来源键名是 script）
    const hit = guard.inspect("workflow", {
      script: `const text = await read(${JSON.stringify(fixture.keyPath)});`,
    });
    assert.ok(typeof hit === "string", "代码文本里的敏感路径应被拦");
    const receipt = hit as string;
    assert.match(receipt, /路径复查来源：未登记工具「workflow」的 script。/);
    assert.match(receipt, /ssh-rsa-key/);
    // code / program 同属代码键（同类口径）
    for (const key of ["code", "program"]) {
      const codeHit = guard.inspect("unknown_code_tool", {
        [key]: `open(${JSON.stringify(fixture.envPath)})`,
      });
      assert.ok(typeof codeHit === "string", `${key} 内的敏感路径应被拦`);
      assert.match(codeHit as string, new RegExp(`的 ${key}。`));
    }
  } finally {
    fixture.cleanup();
  }
});

test("unknownToolPolicy:check —— 值面路径（cwd: 前缀 / 绝对路径 / 家目录）与驼峰键名归一", () => {
  const fixture = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({
      homeDir: HOME,
      unknownToolPolicy: "check",
    });
    // session_channel.to = "cwd:<路径>"（BACKLOG 记录的值面缺口）
    const cwdHit = guard.inspect("session_channel", {
      to: `cwd:${fixture.envPath}`,
    });
    assert.ok(typeof cwdHit === "string");
    assert.match(
      cwdHit as string,
      /路径复查来源：未登记工具「session_channel」的 to。/,
    );
    // 非 watched 键 + 绝对路径值（值面兜底）
    const absHit = guard.inspect("some_tool", { where: fixture.envPath });
    assert.ok(typeof absHit === "string");
    // 家目录路径值
    assert.ok(
      typeof guard.inspect("some_tool", { where: "~/.ssh/id_rsa" }) ===
        "string",
    );
    // 普通相对/普通绝对路径值不误伤
    assert.equal(
      guard.inspect("some_tool", { note: "见 docs/README.md" }),
      null,
    );
    assert.equal(guard.inspect("some_tool", { where: "/tmp/ok.md" }), null);
    // deny 的键名启发也要认新键与驼峰（root / workdir / cwd / filePath，小写归一）
    const strict = new GuardEngine({
      homeDir: HOME,
      unknownToolPolicy: "deny",
    });
    for (const key of ["root", "workdir", "cwd", "filePath"]) {
      const hit = strict.inspect("unknown_tool", { [key]: "/tmp/x" });
      assert.ok(typeof hit === "string", `deny 下 ${key} 应计入键名启发`);
      assert.match(hit as string, new RegExp(`（${key}）`));
    }
  } finally {
    fixture.cleanup();
  }
});

test("unknownToolPolicy:check —— allowPatterns / allowedPaths 两层放行面各自独立生效", () => {
  const fixture = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({
      homeDir: HOME,
      unknownToolPolicy: "check",
      sensitiveFiles: { allowedPaths: [fixture.dir] },
    });
    // 敏感路径被用户层放行清单放开 → 放行
    assert.equal(
      guard.inspect("present", { files: [{ path: fixture.envPath }] }),
      null,
    );
    // 放行清单不放命令层：命令键黑名单命中仍拦
    assert.ok(
      typeof guard.inspect("unknown_runner", {
        command: CHECK_BLACKLIST_COMMAND,
      }) === "string",
    );
  } finally {
    fixture.cleanup();
  }
});

test("unknownToolPolicy：三态下已登记/官方工具判定一致（含敏感参数，有区分度）", () => {
  const fixture = makeSensitiveFixture();
  try {
    const engines = ["allow", "check", "deny"].map(
      (policy) =>
        new GuardEngine({
          homeDir: HOME,
          unknownToolPolicy: policy as "allow" | "check" | "deny",
        }),
    );
    const cases: Array<[string, Record<string, unknown>]> = [
      ["read", { file_path: fixture.envPath }],
      ["bash", { command: `cat ${fixture.envPath}` }],
      ["hash_read", { path: fixture.envPath }],
      ["metric_loop", { action: "start", measureCmd: CHECK_BLACKLIST_COMMAND }],
    ];
    for (const [tool, args] of cases) {
      // 区分度自检：该参数面本来就该被拦（否则三态相等只是「都没拦」的假一致）
      assert.ok(
        typeof engines[0]!.inspect(tool, args) === "string",
        `${tool} 的敏感参数应被拦（用例区分度）`,
      );
      const verdicts = engines.map((engine) => engine.inspect(tool, args));
      assert.equal(
        verdicts[0],
        verdicts[1],
        `${tool} 在 allow/check 下判定应一致`,
      );
      assert.equal(
        verdicts[1],
        verdicts[2],
        `${tool} 在 check/deny 下判定应一致`,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

// ------------------------------------------------- unknownToolAllowlist（D2）

test("unknownToolAllowlist —— 精确 / 前缀通配命中即放行（deny 下的显式例外）", () => {
  const fixture = makeSensitiveFixture();
  try {
    const guard = new GuardEngine({
      homeDir: HOME,
      unknownToolPolicy: "deny",
      unknownToolAllowlist: ["present", "mcp__*"],
    });
    // 精确命中
    assert.equal(
      guard.inspect("present", { files: [{ path: fixture.envPath }] }),
      null,
    );
    // `*` 结尾前缀通配
    assert.equal(
      guard.inspect("mcp__filesystem__read", { path: fixture.envPath }),
      null,
    );
    // 未命中：仍按策略整工具拦（通配不误放行同前缀以外的名字）
    const denied = guard.inspect("presenter", { path: "/tmp/ok.md" });
    assert.ok(typeof denied === "string");
    assert.match(denied as string, /presenter/);
    // check / allow 三态一致：名单在策略之前判定
    const checking = new GuardEngine({
      homeDir: HOME,
      unknownToolPolicy: "check",
      unknownToolAllowlist: ["present"],
    });
    assert.equal(
      checking.inspect("present", { files: [{ path: fixture.envPath }] }),
      null,
    );
    // `"*"` = 放行全部未登记工具（等价 allow）
    const allAllowed = new GuardEngine({
      homeDir: HOME,
      unknownToolPolicy: "deny",
      unknownToolAllowlist: ["*"],
    });
    assert.equal(
      allAllowed.inspect("any_unknown", { path: fixture.envPath }),
      null,
    );
    // 名单只作用于未登记工具：已登记工具的敏感参数照拦
    const registeredToo = new GuardEngine({
      homeDir: HOME,
      unknownToolAllowlist: ["read"],
    });
    assert.ok(
      typeof registeredToo.inspect("read", { file_path: fixture.envPath }) ===
        "string",
    );
    // 空串 / 非字符串条目忽略
    const dirty = new GuardEngine({
      homeDir: HOME,
      unknownToolPolicy: "deny",
      unknownToolAllowlist: ["", "  ", 42 as unknown as string, "present"],
    });
    assert.equal(dirty.inspect("present", { path: "/tmp/x" }), null);
    assert.ok(typeof dirty.inspect("other", { path: "/tmp/x" }) === "string");
  } finally {
    fixture.cleanup();
  }
});

test("unknownToolAllowlist —— policy() 快照暴露名单（返回副本，外部修改不影响内部）", () => {
  const guard = new GuardEngine({
    homeDir: HOME,
    unknownToolAllowlist: ["present", "mcp__*"],
  });
  const snapshot = guard.policy();
  assert.deepEqual(snapshot.unknownToolAllowlist, ["present", "mcp__*"]);
  (snapshot.unknownToolAllowlist as string[]).push("mutated");
  assert.deepEqual(guard.policy().unknownToolAllowlist, ["present", "mcp__*"]);
});

// ------------------------------------- unknownToolPolicy 非法值（D6）

test("unknownToolPolicy 非法值 —— 告警一次 + 按 allow 生效 + policy() 标 invalid", () => {
  const fixture = makeSensitiveFixture();
  const warns: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    warns.push(args);
  };
  try {
    const guard = new GuardEngine({
      homeDir: HOME,
      unknownToolPolicy: "Deny" as unknown as "allow",
    });
    // 非法值 → 按 "allow" 生效（fail-open 语义不变）：连敏感参数也放行
    assert.equal(
      guard.inspect("present", { files: [{ path: fixture.envPath }] }),
      null,
    );
    assert.equal(warns.length, 1, "非法值应告警一次");
    assert.match(
      String(warns[0]?.[0]),
      /非法配置 unknownToolPolicy="Deny"，已按 "allow" 生效/,
    );
    // 告警不随工具调用重复
    guard.inspect("present", { files: [{ path: fixture.envPath }] });
    assert.equal(warns.length, 1);
    // policy() 快照：原始值 / 生效值 / invalid
    assert.deepEqual(guard.policy().unknownToolPolicy, {
      value: "Deny",
      effective: "allow",
      invalid: true,
    });
    // 布尔 true 同样非法（fail-open + 标记）
    const boolGuard = new GuardEngine({
      homeDir: HOME,
      unknownToolPolicy: true as unknown as "allow",
    });
    assert.deepEqual(boolGuard.policy().unknownToolPolicy, {
      value: true,
      effective: "allow",
      invalid: true,
    });
    assert.equal(warns.length, 2);
    // 合法值（含缺省）不带 invalid
    assert.deepEqual(
      new GuardEngine({ homeDir: HOME }).policy().unknownToolPolicy,
      {
        value: undefined,
        effective: "allow",
        invalid: false,
      },
    );
    for (const policy of ["allow", "check", "deny"] as const) {
      assert.deepEqual(
        new GuardEngine({ homeDir: HOME, unknownToolPolicy: policy }).policy()
          .unknownToolPolicy,
        { value: policy, effective: policy, invalid: false },
      );
    }
    assert.equal(warns.length, 2, "合法值不应告警");
  } finally {
    console.warn = original;
    fixture.cleanup();
  }
});

// ------------------------------------- deny 回执的可行动作（D3）

test("unknownToolPolicy:deny —— 回执给出三条可行动作（配置级逃生门，不再只说改源码）", () => {
  const guard = new GuardEngine({ homeDir: HOME, unknownToolPolicy: "deny" });
  const hit = guard.inspect("present", { files: [{ path: "/tmp/ok.md" }] });
  assert.ok(typeof hit === "string");
  const receipt = hit as string;
  assert.match(receipt, /放行方式（三选一）：/);
  assert.match(receipt, /① 配 unknownToolPolicy: "check"/);
  assert.match(receipt, /② 配 unknownToolAllowlist: \["present"\]/);
  assert.match(receipt, /③ 按真实参数面登记进 FILE_TOOLS/);
  // 未登记且无 watched 键 → 仍然放行（防误伤）
  assert.equal(guard.inspect("plain_unknown", { id: "x" }), null);
});

// ------------------------------------- TOOL_SURFACE（脚本与引擎的单一来源）

test("TOOL_SURFACE —— 脚本与引擎同源快照：登记名去重 + 三类键集齐备", () => {
  assert.deepEqual(
    TOOL_SURFACE.registered,
    [...TOOL_SURFACE.registered].sort(),
  );
  for (const name of [
    "bash",
    "read",
    "read_image",
    "hash_edit",
    "metric_loop",
  ]) {
    assert.ok(TOOL_SURFACE.registered.includes(name), `${name} 应在登记集内`);
  }
  assert.ok(TOOL_SURFACE.pathKeys.includes("file_path"));
  assert.ok(TOOL_SURFACE.pathKeys.includes("filepath"));
  assert.ok(TOOL_SURFACE.commandKeys.includes("measurecmd"));
  assert.ok(TOOL_SURFACE.codeKeys.includes("script"));
  // 三类键互不重叠（口径清晰：一个键只归一类）
  const overlap = TOOL_SURFACE.pathKeys.filter(
    (key) =>
      TOOL_SURFACE.commandKeys.includes(key as never) ||
      TOOL_SURFACE.codeKeys.includes(key as never),
  );
  assert.deepEqual(overlap, []);
});
