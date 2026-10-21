/**
 * 学习层用例（追踪文档「测试要点」18 组）。
 *
 * 全部用假件：假宿主（`createFakeHost`）、假 LLM（`createFakeLlm`）、假会话路径，
 * 手控定时器（合并窗口不依赖真实时间），不连真实模型、不启动 dsh。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AUDIT_FILE_NAME } from "../src/audit.ts";
import { CallTable } from "../src/calls.ts";
import { dispatch, renderForms } from "../src/command.ts";
import { resolveConfig, type Config } from "../src/config.ts";
import {
  decide,
  decideDeterministic,
  type DecisionContext,
} from "../src/decide.ts";
import { FingerprintStore } from "../src/fingerprint.ts";
import {
  createLearner,
  FormStore,
  formHash,
  formOfCommand,
  maskToken,
  matchesForm,
  mergeForm,
  readAuditCallIds,
  splitCommandSegments,
  tokenizeSegment,
  type Learner,
  type LearnerOptions,
} from "../src/learn.ts";
import { createBundle } from "../src/main.ts";
import {
  parseLearnDecisions,
  runLearnReview,
  type LearnCandidate,
  type LearnReviewer,
  type LlmLike,
} from "../src/review.ts";
import { SessionObserver, type SessionEventLike } from "../src/sessions.ts";
import type { FormView, PluginHost } from "../src/types.ts";
import {
  createFakeHost,
  createFakeLlm,
  createFakeSessionPaths,
  reviewChunks,
  tempDir,
} from "./fakes.ts";

/** 学习审阅的批量回答（每条 id 一个结果）。 */
function learnChunks(
  results: readonly {
    id: string;
    allow: boolean;
    risk: string;
    reason?: string;
  }[],
): string {
  return JSON.stringify({ results });
}

/** 手控定时器：窗口回调攒起来，由用例显式触发。 */
interface ManualScheduler {
  schedule: (fn: () => void, ms: number) => () => void;
  /** 已排期但还没触发的回调数。 */
  pending(): number;
  /** 触发全部已排期的回调。 */
  run(): void;
  /** 触发的窗口时长（断言 2 s 口径）。 */
  windows: number[];
}

function manualScheduler(): ManualScheduler {
  let queue: (() => void)[] = [];
  const windows: number[] = [];
  return {
    windows,
    schedule(fn, ms) {
      windows.push(ms);
      queue.push(fn);
      return () => {
        queue = queue.filter((item) => item !== fn);
      };
    },
    pending: () => queue.length,
    run() {
      const batch = queue;
      queue = [];
      for (const fn of batch) fn();
    },
  };
}

interface Harness {
  learner: Learner;
  forms: FormStore;
  fingerprints: FingerprintStore;
  calls: CallTable;
  sessions: SessionObserver;
  scheduler: ManualScheduler;
  reviews: { sessionId?: string; candidates: readonly LearnCandidate[] }[];
  logs: string[];
  warnings: string[];
  /** 记一次调用的参数（等价于 `tools/pre-execute` 侧）。 */
  record(callId: string, command: string, sessionId?: string): void;
  ask(sessionId: string, id: string, callId?: string, reason?: string): void;
  decide(
    sessionId: string,
    id: string,
    outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable",
  ): void;
  result(sessionId: string, callId: string, isError: boolean): void;
  /** 人工放行一次命令（asked + decided）。 */
  manual(sessionId: string, id: string, callId: string, command: string): void;
  /** 成功执行一次（tool/result）。 */
  success(sessionId: string, callId: string): void;
  dispose(): void;
}

function createHarness(
  options: {
    config?: Config;
    outcome?:
      | { allow: boolean; risk: "low" | "medium" | "high"; reason?: string }
      | "throw";
    isActive?: () => boolean;
    now?: () => number;
    withReviewer?: boolean;
    history?: LearnerOptions["history"];
  } = {},
): Harness {
  const config = resolveConfig(options.config);
  const forms = new FormStore(config.formCapacity);
  const fingerprints = new FingerprintStore(config.fingerprintCapacity);
  const calls = new CallTable(config.callTableCapacity);
  const sessions = new SessionObserver();
  const scheduler = manualScheduler();
  const reviews: {
    sessionId?: string;
    candidates: readonly LearnCandidate[];
  }[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const reviewer: LearnReviewer | undefined =
    options.withReviewer === false
      ? undefined
      : async (request) => {
          reviews.push(request);
          if (options.outcome === "throw") throw new Error("审阅失败");
          const outcome = options.outcome ?? {
            allow: true,
            risk: "low" as const,
          };
          return request.candidates.map(() => outcome);
        };
  const learner = createLearner({
    config,
    calls,
    sessions,
    forms,
    fingerprints,
    isActive: options.isActive ?? (() => true),
    ...(reviewer === undefined ? {} : { reviewer }),
    warn: (message) => warnings.push(message),
    log: (message) => logs.push(message),
    schedule: scheduler.schedule,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.history === undefined ? {} : { history: options.history }),
  });
  const harness: Harness = {
    learner,
    forms,
    fingerprints,
    calls,
    sessions,
    scheduler,
    reviews,
    logs,
    warnings,
    record(callId, command, sessionId = "s1") {
      calls.record({
        callId,
        name: "bash",
        arguments: { command },
        sessionId,
        cwd: "/w",
      });
      sessions.observe(sessionId, {
        type: "tool/call",
        data: { callId, name: "bash", arguments: JSON.stringify({ command }) },
      });
    },
    ask(sessionId, id, callId, reason) {
      learner.observe(sessionId, {
        type: "approval/asked",
        data: {
          id,
          toolName: "bash",
          ...(callId === undefined ? {} : { callId }),
          ...(reason === undefined ? {} : { reason }),
        },
      });
    },
    decide(sessionId, id, outcome) {
      learner.observe(sessionId, {
        type: "approval/decided",
        data: { id, outcome },
      });
    },
    result(sessionId, callId, isError) {
      learner.observe(sessionId, {
        type: "tool/result",
        data: { message: { toolCallId: callId, isError } },
      });
    },
    manual(sessionId, id, callId, command) {
      harness.record(callId, command, sessionId);
      harness.ask(sessionId, id, callId);
      harness.decide(sessionId, id, "allowed-once");
    },
    success(sessionId, callId) {
      harness.result(sessionId, callId, false);
    },
    dispose() {
      learner.dispose();
    },
  };
  return harness;
}

/** 触发窗口并等批次落地。 */
async function settle(harness: Harness): Promise<void> {
  harness.scheduler.run();
  await harness.learner.flush();
}

function viewForms(harness: Harness, sessionId = "s1"): FormView[] {
  return harness.forms.list(sessionId);
}

/* ── 词法层 ─────────────────────────────────────────────────────────────── */

test("切段口径与 security-guard 一致：引号内的 ; | & 换行不切", () => {
  const quoted = splitCommandSegments('echo "a;b|c&d" ; ls -la');
  assert.deepEqual(quoted.segments, ['echo "a;b|c&d"', "ls -la"]);
  assert.equal(quoted.balanced, true);
  assert.deepEqual(splitCommandSegments("a && b || c\nd").segments, [
    "a",
    "b",
    "c",
    "d",
  ]);
  const broken = splitCommandSegments('echo "abc');
  assert.equal(broken.balanced, false, "引号不配对按切分失败处理");
});

test('切 token：引号串整体成 token，-m"b" 粘连与 -m "b" 同形', () => {
  const glued = tokenizeSegment('git commit -m"b"');
  assert.deepEqual(
    glued.map((token) => [token.value, token.quoted]),
    [
      ["git", false],
      ["commit", false],
      ["-m", false],
      ["b", true],
    ],
  );
  const spaced = tokenizeSegment('git commit -m "b"');
  assert.deepEqual(
    spaced.map((token) => token.value),
    ["git", "commit", "-m", "b"],
  );
});

test("抹值：引号串 <msg> / 长 hex <hex> / 纯数字 <n>，路径与选项名保留", () => {
  assert.equal(maskToken({ value: "修复文档", quoted: true }), "<msg>");
  assert.equal(
    maskToken({ value: "0123456789abcdef", quoted: false }),
    "<hex>",
  );
  assert.equal(maskToken({ value: "12345", quoted: false }), "<n>");
  assert.equal(
    maskToken({ value: "src/main.ts", quoted: false }),
    "src/main.ts",
  );
  assert.equal(maskToken({ value: "--amend", quoted: false }), "--amend");
  assert.equal(maskToken({ value: "main", quoted: false }), "main");
});

test("A 层形态：引号与空格两种写法归一；段首命令词永不遮成占位", () => {
  const a = formOfCommand('git commit -m "a"');
  const b = formOfCommand('git commit -m"b"');
  assert.deepEqual(a, ["git commit -m <msg>"]);
  assert.deepEqual(b, a);
  assert.deepEqual(formOfCommand("  "), undefined);
  assert.deepEqual(formOfCommand('echo "abc'), undefined);
  const quotedHead = formOfCommand('"rm" -rf /tmp/x');
  assert.deepEqual(quotedHead, ["rm -rf /tmp/x"]);
});

/* ── 形态表 / 最小泛化 ──────────────────────────────────────────────────── */

test("段覆盖：复合命令逐段判定（顺序无关、缺一段即不命中）", () => {
  const store = new FormStore(8);
  store.add("s1", "echo a", "bash", "manual");
  store.add("s1", "ls -la", "bash", "manual");
  assert.equal(store.covers("s1", ["echo a", "ls -la"]), true);
  assert.equal(store.covers("s1", ["ls -la", "echo a"]), true, "顺序无关");
  assert.equal(store.covers("s1", ["echo a"]), true, "单段也按覆盖判定");
  assert.equal(
    store.covers("s1", ["echo a", "git status"]),
    false,
    "缺一段不命中",
  );
  assert.equal(store.covers("s2", ["echo a"]), false, "跨会话不生效");
  assert.equal(store.covers("s1", []), false, "段数 0 不命中");
});

test("最小泛化：只值位不同才升级；段首 / 子命令不通配；变位 ≤ 2；路径不泛化", () => {
  const main = "git push origin main".split(" ");
  const dev = "git push origin dev".split(" ");
  assert.deepEqual(mergeForm(main, dev), ["git", "push", "origin", "<v>"]);
  // 段首命令词 / 子命令不同：永不泛化
  assert.equal(
    mergeForm("git push x y".split(" "), "svn push x z".split(" ")),
    undefined,
  );
  assert.equal(
    mergeForm("git push a x".split(" "), "git fetch a y".split(" ")),
    undefined,
  );
  // 三个变位超过上限
  assert.equal(
    mergeForm("npm run a b c".split(" "), "npm run d e f".split(" ")),
    undefined,
  );
  // 路径不作为值位泛化（宁可少泛化）
  assert.equal(
    mergeForm("rm -rf /tmp/a".split(" "), "rm -rf /tmp/b".split(" ")),
    undefined,
  );
  // 无差异 → 不动表
  assert.equal(mergeForm(main, main), undefined);
});

test("泛化后的形态用 <v> 通配：同形不同值命中，长度不同不命中", () => {
  const pattern = "git push origin <v>".split(" ");
  assert.equal(matchesForm(pattern, "git push origin dev".split(" ")), true);
  assert.equal(
    matchesForm(pattern, "git push origin feature/x".split(" ")),
    true,
  );
  assert.equal(matchesForm(pattern, "git push origin".split(" ")), false);
  assert.equal(matchesForm(pattern, "git push".split(" ")), false);
});

test("形态表容量：近似 LRU 淘汰最早的条目；undo 只删一条、clear 只清一个会话", () => {
  const store = new FormStore(2);
  store.add("s1", "a 1", "bash", "manual");
  store.add("s1", "b 2", "bash", "manual");
  store.add("s1", "c 3", "bash", "manual");
  assert.equal(store.size("s1"), 2);
  assert.equal(store.covers("s1", ["a 1"]), false, "最早的被淘汰");
  const rows = store.list("s1");
  assert.equal(rows.length, 2);
  const first = rows[0];
  assert.ok(first);
  assert.equal(store.remove(first.formHash), 1);
  assert.equal(store.size("s1"), 1);
  store.add("s2", "d 4", "bash", "manual");
  assert.equal(store.clear("s1"), 1);
  assert.equal(store.size("s2"), 1, "clear 只清指定会话");
});

/* ── 学习器：入口 / 排除 / 关闭态 ───────────────────────────────────────── */

test("01 学习入口：人工 allowed-once 学一次后，同形不同值的调用走形态层且不再弹面板", async () => {
  const root = tempDir();
  const llm = createFakeLlm(
    reviewChunks(learnChunks([{ id: "0", allow: true, risk: "low" }])),
  );
  const host = createFakeHost({
    sessionPaths: createFakeSessionPaths(root),
    llm,
  });
  const warnings: string[] = [];
  const bundle = createBundle(
    host as unknown as PluginHost,
    resolveConfig({ review: { provider: "p", model: "m" } }),
    (message) => warnings.push(message),
  );
  const panel = { calls: 0 };
  host.on("approval/request", (() =>
    (async () => {
      panel.calls += 1;
      return "allowed-once";
    })()) as never);
  const session = { id: "s1", header: { cwd: "/w" } };
  const emit = (event: SessionEventLike): void => {
    host.emit("session/event", session, event);
  };
  const preExecute = async (
    callId: string,
    command: string,
  ): Promise<unknown> =>
    await host.waterfall(
      "tools/pre-execute",
      { name: "bash", callId, arguments: { command }, agent: { session } },
      () => ({ kind: "allow" }),
    );
  const ask = async (callId: string): Promise<unknown> =>
    await host.waterfall(
      "approval/request",
      { toolName: "bash", callId, agent: { session } },
      async () => "unavailable",
    );

  // 第一次：未命中任何层 → 人工面板放行
  await preExecute("c1", 'git commit -m "a"');
  emit({
    type: "approval/asked",
    data: { id: "a1", toolName: "bash", callId: "c1" },
  });
  assert.equal(await ask("c1"), "allowed-once");
  assert.equal(panel.calls, 1);
  emit({
    type: "approval/decided",
    data: { id: "a1", outcome: "allowed-once" },
  });
  await bundle.learn.flush();

  const forms = bundle.service.forms("s1");
  assert.equal(forms.length, 1);
  assert.equal(forms[0]?.form, "git commit -m <msg>");
  assert.equal(forms[0]?.source, "manual");
  assert.equal(llm.calls.length, 1, "一次学习只发一次审阅请求");
  assert.equal(bundle.service.status().forms, 1);

  // 第二次：同形不同值 → 形态层命中，面板不再被调用
  await preExecute("c2", 'git commit -m"b"');
  assert.equal(await ask("c2"), "allowed-once");
  assert.equal(panel.calls, 1, "形态层命中，未落面板");
  const rows = readAudit(root, "s1");
  const last = rows[rows.length - 1];
  assert.equal(last?.source, "fingerprint");
  assert.equal(last?.ruleId, "fingerprint:form");
  // 只允许审计项目那份的「memory-base 未挂载」这类环境性提示
  assert.equal(
    warnings.some((line) => line.includes("学习")),
    false,
    warnings.join("\n"),
  );
  bundle.dispose();
});

/** 读本包会话审计行（只取判定来源相关字段）。 */
function readAudit(
  root: string,
  sessionId: string,
): { source?: string; ruleId?: string; toolName?: string }[] {
  try {
    return readFileSync(join(root, sessionId, AUDIT_FILE_NAME), "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { source?: string; ruleId?: string });
  } catch {
    return [];
  }
}

test("02 本插件自己裁定的 allowed-once 不入学习（自记集合命中即跳过）", async () => {
  const harness = createHarness();
  harness.record("c1", "git push origin main");
  harness.learner.noteSelfDecision("c1");
  harness.ask("s1", "a1", "c1");
  harness.decide("s1", "a1", "allowed-once");
  await settle(harness);
  assert.equal(harness.forms.size(), 0);
  assert.equal(harness.fingerprints.size(), 0, "自记裁定的调用不记人工指纹");
  assert.equal(harness.reviews.length, 0, "不产生审阅请求");
  harness.dispose();
});

test("03 拒绝 / cancelled / unavailable 不入表", async () => {
  for (const outcome of ["rejected", "cancelled", "unavailable"] as const) {
    const harness = createHarness();
    harness.record("c1", "git push origin main");
    harness.ask("s1", "a1", "c1");
    harness.decide("s1", "a1", outcome);
    await settle(harness);
    assert.equal(harness.forms.size(), 0, outcome);
    assert.equal(harness.fingerprints.size(), 0, outcome);
    harness.dispose();
  }
});

test("09 取不到 callId / 参数原文：不学习也不报错", async () => {
  const harness = createHarness();
  harness.ask("s1", "a1");
  harness.decide("s1", "a1", "allowed-once");
  await settle(harness);
  assert.equal(harness.forms.size(), 0);
  assert.equal(harness.warnings.length, 0);

  harness.ask("s1", "a2", "missing");
  harness.decide("s1", "a2", "allowed-once");
  await settle(harness);
  assert.equal(harness.forms.size(), 0);
  assert.equal(harness.warnings.length, 0);
  harness.dispose();
});

test("14 关闭态：enabled false / mode off / learnFromManual false 都不学习、不审阅、不回填", async () => {
  for (const isActive of [() => false]) {
    const harness = createHarness({ isActive });
    harness.manual("s1", "a1", "c1", "git push origin main");
    await settle(harness);
    assert.equal(harness.forms.size(), 0);
    assert.equal(harness.reviews.length, 0);

    const free = createHarness({ config: { learnFromManual: false } });
    free.manual("s1", "a1", "c1", "git push origin main");
    await settle(free);
    assert.equal(free.forms.size(), 0);
    assert.equal(free.reviews.length, 0);
    assert.equal(
      await free.learner.rehydrate("s1"),
      0,
      "learnFromManual false 不回填",
    );
    harness.dispose();
    free.dispose();
  }
});

/* ── A / B 两层 ─────────────────────────────────────────────────────────── */

test("05 A 层：学一次后同形不同值命中；不同命令 / 子命令不命中", async () => {
  const harness = createHarness();
  harness.manual("s1", "a1", "c1", 'git commit -m "a"');
  await settle(harness);
  assert.equal(harness.forms.covers("s1", ["git commit -m <msg>"]), true);
  assert.equal(
    harness.forms.covers("s1", formOfCommand('git commit -m"b"') ?? []),
    true,
    "粘连写法与带空格写法等价",
  );
  assert.equal(
    harness.forms.covers("s1", formOfCommand('git push -m "b"') ?? []),
    false,
    "不同子命令不命中",
  );
  assert.equal(
    harness.forms.covers("s1", formOfCommand("git commit --amend") ?? []),
    false,
    "不同命令不命中",
  );
  harness.dispose();
});

test("06 B 层：第二次成功观测才泛化；只观测一次不泛化", async () => {
  const harness = createHarness();
  // 第一次人工放行 + 成功执行 → 只有一次成功观测
  harness.manual("s1", "a1", "c1", "git push origin main");
  await settle(harness);
  harness.success("s1", "c1");
  assert.equal(
    harness.forms.covers("s1", ["git push origin main"]),
    true,
    "精确形态在表里",
  );
  assert.equal(
    harness.forms.covers("s1", ["git push origin dev"]),
    false,
    "只观测一次不泛化（值位不同不命中）",
  );
  // 第二次：同段不同值的人工放行 + 成功执行 → 泛化
  harness.manual("s1", "a2", "c2", "git push origin dev");
  await settle(harness);
  harness.success("s1", "c2");
  await settle(harness);
  assert.equal(harness.forms.covers("s1", ["git push origin feature"]), true);
  assert.deepEqual(
    viewForms(harness).map((row) => row.form),
    ["git push origin <v>"],
    "被新形态覆盖的旧条目清掉",
  );
  harness.dispose();
});

test("17 / 18 失败只挡泛化：先失败后成功不泛化；两次成功（值位不同）才泛化", async () => {
  const failedThenOk = createHarness();
  failedThenOk.manual("s1", "a1", "c1", "git push origin main");
  await settle(failedThenOk);
  failedThenOk.result("s1", "c1", true); // 执行失败：不计成功观测
  failedThenOk.manual("s1", "a2", "c2", "git push origin dev");
  await settle(failedThenOk);
  failedThenOk.success("s1", "c2");
  await settle(failedThenOk);
  assert.equal(
    failedThenOk.forms.covers("s1", ["git push origin feature"]),
    false,
    "同一段只凑到一次成功观测 → 不泛化",
  );
  assert.equal(
    failedThenOk.forms.covers("s1", ["git push origin main"]),
    true,
    "首次学习不看结果，A 层照常入表",
  );
  failedThenOk.dispose();

  // 两次都成功 → 泛化（tool/result 缺失的那次不推进 B）
  const bothOk = createHarness();
  bothOk.manual("s1", "a1", "c1", "git push origin main");
  await settle(bothOk);
  bothOk.success("s1", "c1");
  bothOk.manual("s1", "a2", "c2", "git push origin dev");
  await settle(bothOk);
  assert.equal(
    bothOk.forms.covers("s1", ["git push origin feature"]),
    false,
    "第二次成功观测之前不泛化",
  );
  bothOk.success("s1", "c2");
  await settle(bothOk);
  assert.equal(bothOk.forms.covers("s1", ["git push origin feature"]), true);
  bothOk.dispose();
});

test("04 跨会话不生效：一个会话学到，另一个会话仍不命中", async () => {
  const harness = createHarness();
  harness.manual("s1", "a1", "c1", 'git commit -m "a"');
  await settle(harness);
  assert.equal(harness.forms.covers("s1", ["git commit -m <msg>"]), true);
  assert.equal(harness.forms.covers("s2", ["git commit -m <msg>"]), false);
  harness.dispose();
});

/* ── LLM 审阅 ───────────────────────────────────────────────────────────── */

test("10 审阅：allow 达标入表；deny / 高风险 / 抛错 / JSON 非法一律不入且不抛", async () => {
  const allow = createHarness({
    config: { review: { maxRiskAllow: "medium" } },
  });
  allow.manual("s1", "a1", "c1", "git push origin main");
  await settle(allow);
  assert.equal(allow.forms.size(), 1, "allow + low 入表");
  allow.dispose();

  const deny = createHarness({ outcome: { allow: false, risk: "medium" } });
  deny.manual("s1", "a1", "c1", "git push origin main");
  await settle(deny);
  assert.equal(deny.forms.size(), 0, "deny 不入表");
  deny.dispose();

  const risky = createHarness({ outcome: { allow: true, risk: "high" } });
  risky.manual("s1", "a1", "c1", "git push origin main");
  await settle(risky);
  assert.equal(risky.forms.size(), 0, "高风险不入表");
  risky.dispose();

  const strict = createHarness({
    config: { review: { maxRiskAllow: "low" } },
    outcome: { allow: true, risk: "medium" },
  });
  strict.manual("s1", "a1", "c1", "git push origin main");
  await settle(strict);
  assert.equal(strict.forms.size(), 0, "风险高于 maxRiskAllow 不入表");
  strict.dispose();

  const broken = createHarness({ outcome: "throw" });
  broken.manual("s1", "a1", "c1", "git push origin main");
  await settle(broken);
  assert.equal(broken.forms.size(), 0, "审阅抛错不入表");
  assert.match(broken.warnings.join("\n"), /学习审阅不可用/);
  broken.dispose();

  const noReviewer = createHarness({ withReviewer: false });
  noReviewer.manual("s1", "a1", "c1", "git push origin main");
  await settle(noReviewer);
  assert.equal(noReviewer.forms.size(), 0, "审阅器不可用按失败处理");
  noReviewer.dispose();
});

test("10 审阅解析：批量 / 单条两种形态；非法 JSON 与非法组合拒绝", () => {
  const batch = parseLearnDecisions(
    learnChunks([
      { id: "0", allow: true, risk: "low" },
      { id: "1", allow: false, risk: "medium", reason: "范围太宽" },
    ]),
    2,
  );
  assert.equal(batch[0]?.allow, true);
  assert.equal(batch[1]?.allow, false);
  const single = parseLearnDecisions('{"allow":true,"risk":"low"}', 1);
  assert.equal(single[0]?.allow, true);
  assert.throws(
    () => parseLearnDecisions('{"allow":false,"risk":"medium"}', 2),
    /缺少 results/,
    "多条候选不接受单条形态",
  );
  assert.deepEqual(parseLearnDecisions('{"results":[{"id":"9"}]}', 1), [
    undefined,
  ]);
  assert.deepEqual(parseLearnDecisions('{"results":[]}', 1), [undefined]);
  assert.throws(() => parseLearnDecisions("not json", 1), /不是 JSON/);
});

test("10 审阅超时：模型不返回时按失败处理（不抛到上层）", async () => {
  const hanging: LlmLike = {
    stream(options) {
      return (async function* generate() {
        await new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      })();
    },
  };
  await assert.rejects(
    runLearnReview(
      hanging,
      { provider: "p", model: "m" },
      [
        {
          index: 0,
          toolName: "bash",
          form: "git push origin <v>",
          command: "git push origin main",
          cwd: "/w",
        },
      ],
      10,
    ),
    /aborted|timeout/,
  );
});

test("11 审阅关闭：跳过审阅直接按 A / B 入表；learnFromManual false 整条路径不启用", async () => {
  const off = createHarness({
    config: { learnReview: { enabled: false } },
    withReviewer: false,
  });
  off.manual("s1", "a1", "c1", "git push origin main");
  await settle(off);
  assert.equal(off.forms.size(), 1, "审阅关闭时直接入表");
  assert.equal(off.reviews.length, 0);
  off.dispose();

  const disabled = createHarness({ config: { learnFromManual: false } });
  disabled.manual("s1", "a1", "c1", "git push origin main");
  await settle(disabled);
  assert.equal(disabled.forms.size(), 0);
  disabled.dispose();
});

test("15 合并审阅：2 s 窗口内 3 条候选只发一次请求，结果按条落地", async () => {
  const harness = createHarness();
  harness.manual("s1", "a1", "c1", "git push origin main");
  harness.manual("s1", "a2", "c2", "echo hello");
  harness.manual("s1", "a3", "c3", "npm run build");
  assert.equal(harness.reviews.length, 0, "窗口内不发请求");
  assert.equal(harness.scheduler.pending(), 1);
  await settle(harness);
  assert.deepEqual(harness.scheduler.windows, [2000], "合并窗口 2 s");
  assert.equal(harness.reviews.length, 1, "三条候选合成一次请求");
  assert.equal(harness.reviews[0]?.candidates.length, 3);
  assert.equal(harness.forms.size(), 3, "结果按条落地");

  // 窗口外另起一次
  harness.manual("s1", "a4", "c4", "ls -la");
  await settle(harness);
  assert.equal(harness.reviews.length, 2);
  assert.equal(harness.forms.size(), 4);
  harness.dispose();
});

/* ── 回填 ───────────────────────────────────────────────────────────────── */

/** 造一份会话历史：`pairs` 条人工放行 + `self` 条本插件裁定。 */
function historyOf(options: {
  pairs: number;
  self?: number;
  failed?: readonly number[];
  /** 本插件裁定的 callId（审计文件里出现）。 */
  auditSelf?: readonly string[];
}): LearnerOptions["history"] {
  const events: SessionEventLike[] = [];
  const auditCallIds: string[] = [...(options.auditSelf ?? [])];
  let seq = 0;
  const failed = new Set(options.failed ?? []);
  for (let index = 0; index < options.pairs; index += 1) {
    const callId = `c${index}`;
    const command = `git push origin branch${index}`;
    seq += 1;
    events.push({
      seq,
      type: "approval/asked",
      data: { id: `a${index}`, toolName: "bash", callId },
    });
    events.push({
      seq: seq + 1,
      type: "tool/call",
      data: { callId, name: "bash", arguments: JSON.stringify({ command }) },
    });
    if (!failed.has(index)) {
      events.push({
        seq: seq + 2,
        type: "tool/result",
        data: { message: { toolCallId: callId, isError: false } },
      });
    }
    events.push({
      seq: seq + 3,
      type: "approval/decided",
      data: { id: `a${index}`, outcome: "allowed-once" },
    });
    seq += 3;
  }
  for (let index = 0; index < (options.self ?? 0); index += 1) {
    const callId = `p${index}`;
    seq += 1;
    events.push({
      seq,
      type: "approval/asked",
      data: { id: `p${index}`, toolName: "bash", callId },
    });
    events.push({
      seq: seq + 1,
      type: "tool/call",
      data: {
        callId,
        name: "bash",
        arguments: JSON.stringify({ command: `echo plugin${index}` }),
      },
    });
    events.push({
      seq: seq + 2,
      type: "tool/result",
      data: { message: { toolCallId: callId, isError: false } },
    });
    events.push({
      seq: seq + 3,
      type: "approval/decided",
      data: { id: `p${index}`, outcome: "allowed-once" },
    });
    auditCallIds.push(callId);
    seq += 3;
  }
  return {
    async readEvents() {
      return events;
    },
    readAuditCallIds() {
      return auditCallIds;
    },
  };
}

test("12 回填：3 对（2 人工 + 1 本插件）只重建 2 条；只计成功执行；一次性", async () => {
  const harness = createHarness({ history: historyOf({ pairs: 2, self: 1 }) });
  assert.equal(await harness.learner.rehydrate("s1"), 2);
  assert.equal(harness.forms.size("s1"), 2);
  assert.equal(
    harness.forms.covers("s1", ["git push origin branch0"]),
    true,
    "本插件裁定的那条不进形态表",
  );
  assert.equal(await harness.learner.rehydrate("s1"), 0, "回填只做一次");
  harness.dispose();

  const partial = createHarness({
    history: historyOf({ pairs: 3, failed: [1] }),
  });
  assert.equal(await partial.learner.rehydrate("s1"), 2, "失败执行的不回填");
  partial.dispose();
});

test("12 回填：超过 20 条截断并记一条日志；数据源缺失 → 空集不抛", async () => {
  const many = createHarness({ history: historyOf({ pairs: 25 }) });
  assert.equal(await many.learner.rehydrate("s1"), 20);
  assert.match(many.logs.join("\n"), /单次只处理最近 20 条/);
  many.dispose();

  const none = createHarness();
  assert.equal(await none.learner.rehydrate("s1"), 0);
  none.dispose();

  const failing = createHarness({
    history: {
      async readEvents() {
        throw new Error("会话读不到");
      },
      readAuditCallIds() {
        return [];
      },
    },
  });
  assert.equal(await failing.learner.rehydrate("s1"), 0);
  assert.match(failing.warnings.join("\n"), /学习回填失败/);
  failing.dispose();

  // 审计文件缺失 / 服务缺失 → 空集
  const root = tempDir();
  assert.deepEqual(readAuditCallIds(undefined, "s1"), []);
  assert.deepEqual(readAuditCallIds(createFakeSessionPaths(root), "s1"), []);
});

/* ── 自记集合 ───────────────────────────────────────────────────────────── */

test("13 自记集合：容量有界、TTL 过期后不再排除本插件裁定", async () => {
  let clock = 1_000;
  const ttl = createHarness({
    config: { selfDecidedTtlMs: 300_000 },
    now: () => clock,
  });
  ttl.record("c1", "git push origin main");
  ttl.learner.noteSelfDecision("c1");
  ttl.ask("s1", "a1", "c1");
  ttl.decide("s1", "a1", "allowed-once");
  await settle(ttl);
  assert.equal(ttl.forms.size(), 0, "TTL 内按本插件裁定排除");

  // 过期后（> 5 min）不再排除：这条 decided 会被当作人工放行
  clock += 300_001;
  ttl.record("c2", "git push origin dev");
  ttl.ask("s1", "a2", "c2");
  ttl.decide("s1", "a2", "allowed-once");
  await settle(ttl);
  assert.equal(ttl.forms.size(), 1, "过期后不再排除");
  ttl.dispose();

  // 容量 1：记两条后最早那条被挤出（不再被排除 → 按人工放行学习）
  const capacity = createHarness({ config: { selfDecidedCapacity: 1 } });
  capacity.learner.noteSelfDecision("c3");
  capacity.learner.noteSelfDecision("c4");
  capacity.record("c3", "echo kept");
  capacity.ask("s1", "a3", "c3");
  capacity.decide("s1", "a3", "allowed-once");
  await settle(capacity);
  capacity.record("c4", "echo evicted");
  capacity.ask("s1", "a4", "c4");
  capacity.decide("s1", "a4", "allowed-once");
  await settle(capacity);
  assert.equal(capacity.forms.size(), 1, "只有一条进表");
  assert.equal(
    capacity.forms.covers("s1", ["echo kept"]),
    true,
    "被容量挤出的那条按人工放行学习",
  );
  assert.equal(
    capacity.forms.covers("s1", ["echo evicted"]),
    false,
    "最新自记仍生效",
  );
  capacity.dispose();
});

/* ── 命令面 ─────────────────────────────────────────────────────────────── */

test("16 命令面：learn list 只列本会话并带 source；undo 只删一条；clear 清本会话", async () => {
  const harness = createHarness();
  harness.manual("s1", "a1", "c1", "git push origin main");
  harness.manual("s2", "a2", "c2", "echo hello");
  await settle(harness);
  const service = {
    status: () => {
      throw new Error("未用到");
    },
    recent: () => [],
    fingerprints: () => [],
    forms: (sessionId?: string) => harness.forms.list(sessionId),
    setMode: () => {},
  };
  const handles = {
    isEnabled: () => harness.learner.isEnabled(),
    setEnabled: (on: boolean) => harness.learner.setEnabled(on),
    undo: (hash: string) => harness.forms.remove(hash, "s1"),
    clear: () => harness.forms.clear("s1"),
  };
  const options = {
    clearFingerprints: () => 0,
    defaultLogLines: 10,
    learn: handles,
    sessionId: () => "s1",
  };
  const list = dispatch(service, "learn list", options);
  assert.equal(list.kind, "success");
  assert.match(list.text ?? "", /本会话 s1/);
  assert.match(list.text ?? "", /来源=manual/);
  assert.doesNotMatch(list.text ?? "", /echo hello/, "不列其它会话");

  const rows = harness.forms.list("s1");
  // 列表里显示的是 8 位前缀：`undo` 支持前缀匹配
  const hash = (rows[0]?.formHash ?? "").slice(0, 8);
  const undo = dispatch(service, `learn undo ${hash}`, options);
  assert.match(undo.text ?? "", /已撤销 1 条形态/);
  assert.equal(harness.forms.size("s1"), 0);
  assert.equal(harness.forms.size("s2"), 1, "undo 只删本会话的一条");

  harness.forms.add("s1", "ls -la", "bash", "manual");
  const cleared = dispatch(service, "learn clear", options);
  assert.match(cleared.text ?? "", /已清空 1 条/);
  assert.equal(harness.forms.size("s2"), 1, "clear 只清本会话");
  harness.dispose();
});

test("16 learn off 后人工放行不再学习；learn on 恢复；不动运行时裁定与精确指纹", async () => {
  const harness = createHarness();
  const service = {
    status: () => {
      throw new Error("未用到");
    },
    recent: () => [],
    fingerprints: () => [],
    forms: (sessionId?: string) => harness.forms.list(sessionId),
    setMode: () => {},
  };
  const options = {
    clearFingerprints: () => 0,
    defaultLogLines: 10,
    learn: {
      isEnabled: () => harness.learner.isEnabled(),
      setEnabled: (on: boolean) => harness.learner.setEnabled(on),
      undo: (hash: string) => harness.forms.remove(hash, "s1"),
      clear: () => harness.forms.clear("s1"),
    },
    sessionId: () => "s1",
  };
  // 先记一条精确指纹（运行时裁定留下），learn 子命令不得动它
  harness.fingerprints.approve("s1", "hash-1", "bash", "decision");
  assert.equal(dispatch(service, "learn off", options).kind, "success");
  harness.manual("s1", "a1", "c1", "git push origin main");
  await settle(harness);
  assert.equal(harness.forms.size(), 0, "learn off 不学习");
  assert.equal(
    harness.fingerprints.has("s1", "hash-1"),
    true,
    "精确指纹不受影响",
  );

  assert.equal(dispatch(service, "learn on", options).kind, "success");
  harness.manual("s1", "a2", "c2", "git push origin main");
  await settle(harness);
  assert.equal(harness.forms.size(), 1, "learn on 恢复学习");

  const bad = dispatch(service, "learn bogus", options);
  assert.equal(bad.kind, "error");
  assert.match(bad.text ?? "", /未知子命令: learn bogus/);
  harness.dispose();
});

test("16 形态列表渲染：空表 / 带升级目标 / learn 参数缺失报错", () => {
  assert.match(renderForms([], "s1"), /没有学来的形态/);
  const row: FormView = {
    sessionId: "s1",
    formHash: formHash("git push origin <v>", "workspace-write"),
    form: "git push origin <v>",
    toolName: "bash",
    source: "manual",
    target: "workspace-write",
    approvedAt: "2026-10-21T00:00:00.000Z",
  };
  const text = renderForms([row], undefined);
  assert.match(text, /全部会话/);
  assert.match(text, /升级 workspace-write/);
  const service = {
    status: () => {
      throw new Error("未用到");
    },
    recent: () => [],
    fingerprints: () => [],
    forms: () => [row],
    setMode: () => {},
  };
  assert.equal(
    dispatch(service, "learn undo", {
      clearFingerprints: () => 0,
      defaultLogLines: 10,
    }).kind,
    "error",
  );
  assert.equal(
    dispatch(service, "learn list", {
      clearFingerprints: () => 0,
      defaultLogLines: 10,
    }).kind,
    "success",
  );
});

/* ── 判定阶梯 ───────────────────────────────────────────────────────────── */

test("判定：精确指纹优先于形态层；形态未命中继续走后续层；空命令 / 切分失败不命中", async () => {
  const config = resolveConfig({ allow: { commands: { bash: ["^ls\\b"] } } });
  const forms = new FormStore(config.formCapacity);
  const audit = {
    sessionUsable: () => true,
    write: () => {},
    health: () => ({
      sessionWritable: true,
      projectWritable: false,
      projectSkipped: 0,
      sessionLines: 0,
      truncated: false,
    }),
    recent: () => [],
    dispose: () => {},
  };
  const fingerprints = new FingerprintStore(config.fingerprintCapacity);
  const context: DecisionContext = {
    config,
    fingerprints,
    audit,
    forms,
    warn: () => {},
  };
  const input = (callId: string, command: string) => ({
    call: {
      callId,
      name: "bash",
      arguments: { command },
      sessionId: "s1",
      cwd: "/w",
    },
    cwd: "/w",
    history: [],
    projectInstructions: [],
  });
  // 形态层未命中 → 命令白名单兜底
  forms.add("s1", "git push origin <v>", "bash", "manual");
  assert.equal(
    decideDeterministic(context, input("c1", "ls"))?.decision.outcome,
    "allowed-once",
  );
  assert.equal(
    decideDeterministic(context, input("c2", "git push origin dev"))?.decision
      .ruleId,
    "fingerprint:form",
  );
  // 精确指纹优先（同一调用第二次判定）
  const first = decideDeterministic(
    context,
    input("c3", "git push origin dev"),
  );
  assert.ok(first?.fingerprintHash);
  fingerprints.approve("s1", first.fingerprintHash, "bash");
  assert.match(
    decideDeterministic(context, input("c4", "git push origin dev"))?.decision
      .ruleId ?? "",
    /^fingerprint:[0-9a-f]{16}$/,
    "精确指纹层先于形态层",
  );
  // 空命令 / 引号不配对 → 不命中形态层
  assert.equal(
    decideDeterministic(context, input("c5", "   "))?.decision.ruleId,
    undefined,
  );
  assert.equal(
    decideDeterministic(context, input("c6", 'git push origin "abc'))?.decision
      .ruleId,
    undefined,
  );
  // 形态层不参与非命令类工具
  assert.equal(
    decideDeterministic(context, {
      ...input("c7", "x"),
      call: {
        callId: "c7",
        name: "write",
        arguments: { file_path: "git push origin dev" },
        sessionId: "s1",
      },
    })?.decision.ruleId,
    undefined,
  );
  // learnFromManual: false → 形态层整体不启用
  const off: DecisionContext = {
    ...context,
    config: { ...config, learnFromManual: false },
  };
  assert.equal(
    decideDeterministic(off, input("c8", "git push origin feature"))?.decision
      .ruleId,
    undefined,
  );
  // enabled: false → 不裁定
  const disabled: DecisionContext = {
    ...context,
    config: { ...config, enabled: false },
  };
  assert.equal(
    (await decide(disabled, input("c9", "git push origin dev"))).decision
      .outcome,
    "next",
  );
});

test("判定：形态层命中后记原文指纹（下一次走更窄的精确层）", async () => {
  const config = resolveConfig(undefined);
  const forms = new FormStore(config.formCapacity);
  forms.add("s1", "git commit -m <msg>", "bash", "manual");
  const fingerprints = new FingerprintStore(config.fingerprintCapacity);
  const audit = {
    sessionUsable: () => true,
    write: () => {},
    health: () => ({
      sessionWritable: true,
      projectWritable: false,
      projectSkipped: 0,
      sessionLines: 0,
      truncated: false,
    }),
    recent: () => [],
    dispose: () => {},
  };
  const context: DecisionContext = {
    config,
    fingerprints,
    audit,
    forms,
    warn: () => {},
  };
  const call = (callId: string) => ({
    call: {
      callId,
      name: "bash",
      arguments: { command: 'git commit -m "x"' },
      sessionId: "s1",
    },
    cwd: "/w",
    history: [] as [],
    projectInstructions: [] as [],
  });
  const hit = decideDeterministic(context, call("c1"));
  assert.equal(hit?.decision.ruleId, "fingerprint:form");
  const hash = hit?.fingerprintHash;
  assert.ok(hash);
  // 形态层命中后由运行时记原文指纹（`recordApproval`）；这里直接构造同一下次判定
  fingerprints.approve("s1", hash, "bash");
  assert.equal(
    decideDeterministic(context, call("c2"))?.decision.ruleId,
    `fingerprint:${hash}`,
    "下一次完全相同的调用走精确层",
  );
});

test("学习日志：每会话首次一条（不刷屏）", async () => {
  const harness = createHarness();
  harness.manual("s1", "a1", "c1", 'git commit -m "a"');
  await settle(harness);
  harness.manual("s1", "a2", "c2", "echo hello");
  await settle(harness);
  assert.equal(
    harness.logs.filter((line) => line.includes("新增")).length,
    1,
    "同一会话只记一条学习日志",
  );
  harness.dispose();
});
