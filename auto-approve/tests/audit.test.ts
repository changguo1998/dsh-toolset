import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AUDIT_FILE_NAME, AUDIT_KIND, createAudit } from "../src/audit.ts";
import type { AuditLine } from "../src/types.ts";
import { createFakeMemory, createFakeSessionPaths, tempDir } from "./fakes.ts";

function line(overrides: Partial<AuditLine> = {}): AuditLine {
  return {
    t: new Date("2026-10-17T00:00:00.000Z").toISOString(),
    sessionId: "s1",
    callId: "c1",
    toolName: "read",
    outcome: "allowed-once",
    source: "readonly",
    ruleId: "readonly:read",
    mode: "rules",
    fingerprintHash: "hash-1",
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("会话那份：写入 <会话目录>/auto-approve-audit.jsonl，字段与行数对得上", () => {
  const root = tempDir();
  const warnings: string[] = [];
  const audit = createAudit({
    sessionPaths: createFakeSessionPaths(root),
    memory: undefined,
    projectEnabled: false,
    maxBytes: 1024 * 1024,
    warn: (message) => warnings.push(message),
    projectOf: () => "/w",
  });
  assert.equal(audit.sessionUsable(), true);
  audit.write(line());
  audit.write(line({ callId: "c2", outcome: "rejected", source: "rule" }));
  const text = readFileSync(join(root, "s1", AUDIT_FILE_NAME), "utf8");
  const rows = text
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row) as AuditLine);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.toolName, "read");
  assert.equal(rows[1]?.outcome, "rejected");
  assert.deepEqual(
    audit.recent(1).map((row) => row.callId),
    ["c2"],
  );
  const health = audit.health();
  assert.equal(health.sessionWritable, true);
  assert.equal(health.sessionLines, 2);
  assert.equal(health.truncated, false);
  assert.deepEqual(warnings, []);
});

test("session-paths 缺失：会话那份不可得 → 降级 + 一次警告（不静默放行）", () => {
  const warnings: string[] = [];
  const audit = createAudit({
    sessionPaths: undefined,
    memory: undefined,
    projectEnabled: false,
    maxBytes: 1024,
    warn: (message) => warnings.push(message),
    projectOf: () => undefined,
  });
  assert.equal(audit.sessionUsable(), false);
  assert.match(audit.health().degradedReason ?? "", /session-paths/);
  assert.equal(warnings.length, 1);
  audit.write(line());
  assert.equal(warnings.length, 1, "只警告一次");
});

test("达上限：保留最近一半并写 truncated marker，最新记录仍在", () => {
  const root = tempDir();
  const audit = createAudit({
    sessionPaths: createFakeSessionPaths(root),
    memory: undefined,
    projectEnabled: false,
    maxBytes: 300,
    warn: () => {},
    projectOf: () => undefined,
  });
  for (let index = 0; index < 6; index += 1) {
    audit.write(
      line({
        callId: `c${index}`,
        toolName: `tool-${index}-${"x".repeat(60)}`,
      }),
    );
  }
  const text = readFileSync(join(root, "s1", AUDIT_FILE_NAME), "utf8");
  const rows = text.trim().split("\n");
  const first = JSON.parse(rows[0] ?? "{}") as {
    truncated?: boolean;
    keptLines?: number;
  };
  assert.equal(first.truncated, true);
  assert.ok((first.keptLines ?? 0) > 0);
  const last = JSON.parse(rows[rows.length - 1] ?? "{}") as AuditLine;
  assert.equal(last.callId, "c5");
  assert.equal(audit.health().truncated, true);
});

test("会话目录不可写：降级并警告一次，sessionUsable 转 false", () => {
  const warnings: string[] = [];
  // 用一个「同名文件占位」的落点制造不可写：mkdir -p 会因路径上已有文件而失败
  const root = tempDir();
  writeFileSync(join(root, "s1"), "占位文件", "utf8");
  const audit = createAudit({
    sessionPaths: {
      sessionDirFor() {
        return join(root, "s1");
      },
    },
    memory: undefined,
    projectEnabled: false,
    maxBytes: 1024,
    warn: (message) => warnings.push(message),
    projectOf: () => undefined,
  });
  assert.equal(audit.sessionUsable(), true);
  audit.write(line());
  assert.equal(audit.sessionUsable(), false);
  assert.equal(warnings.length, 1);
  assert.match(audit.health().degradedReason ?? "", /写入失败|落点不可得/);
});

test("项目那份：经作用域句柄 put 写入同形一行（kind approval_audit / tier project）", async () => {
  const root = tempDir();
  const memory = createFakeMemory();
  const audit = createAudit({
    sessionPaths: createFakeSessionPaths(root),
    memory,
    projectEnabled: true,
    maxBytes: 1024 * 1024,
    warn: () => {},
    projectOf: () => "/w",
  });
  audit.write(line());
  await flush();
  assert.deepEqual(memory.kinds[0], {
    kind: AUDIT_KIND,
    writableTiers: ["project"],
  });
  assert.equal(memory.puts.length, 1);
  const put = memory.puts[0] as {
    tier: string;
    project: string;
    content: string;
    title: string;
    source: { kind: string; label?: string; ref?: string };
  };
  assert.equal(put.tier, "project");
  assert.equal(put.project, "/w");
  assert.equal(put.source.kind, "manual");
  assert.equal(put.source.label, "auto-approve");
  assert.equal(put.source.ref, "c1");
  assert.match(put.title, /^auto-approve s1 /);
  assert.equal((JSON.parse(put.content) as AuditLine).callId, "c1");
});

test("项目那份不可用：memory 缺失 / 句柄注册失败 / put 抛错都只计数不抛，不影响裁定", async () => {
  const root = tempDir();
  const withoutMemory = createAudit({
    sessionPaths: createFakeSessionPaths(root),
    memory: undefined,
    projectEnabled: true,
    maxBytes: 1024 * 1024,
    warn: () => {},
    projectOf: () => undefined,
  });
  withoutMemory.write(line());
  await flush();
  assert.equal(withoutMemory.health().projectSkipped, 1);

  const warnings: string[] = [];
  const failing = createAudit({
    sessionPaths: createFakeSessionPaths(root),
    memory: createFakeMemory({ fail: true }),
    projectEnabled: true,
    maxBytes: 1024 * 1024,
    warn: (message) => warnings.push(message),
    projectOf: () => undefined,
  });
  failing.write(line());
  await flush();
  assert.equal(failing.health().projectSkipped, 1);
  assert.equal(failing.sessionUsable(), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /registerKind 失败|句柄注册失败/);

  const throwing = createAudit({
    sessionPaths: createFakeSessionPaths(root),
    memory: {
      registerKind: () => ({
        put: () => {
          throw new Error("隐私闸");
        },
      }),
    },
    projectEnabled: true,
    maxBytes: 1024 * 1024,
    warn: (message) => warnings.push(message),
    projectOf: () => undefined,
  });
  throwing.write(line());
  await flush();
  assert.equal(throwing.health().projectSkipped, 1);
  assert.equal(throwing.sessionUsable(), true);
});

test("audit.project: false 时不注册分类、不写项目那份", async () => {
  const root = tempDir();
  const memory = createFakeMemory();
  const audit = createAudit({
    sessionPaths: createFakeSessionPaths(root),
    memory,
    projectEnabled: false,
    maxBytes: 1024 * 1024,
    warn: () => {},
    projectOf: () => undefined,
  });
  audit.write(line());
  await flush();
  assert.equal(memory.puts.length, 0);
  assert.equal(memory.kinds.length, 0);
  assert.equal(existsSync(join(root, "s1", AUDIT_FILE_NAME)), true);
});
