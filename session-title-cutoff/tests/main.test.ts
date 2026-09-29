/**
 * session-title-cutoff 单测：提交判定、窗口过滤与回退、记账（容量）、事件重建、
 * 配置合并与 apply 装配（假 ctx + 假 helper，不触宿主与真实 LLM）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  apply,
  commandOf,
  COMMIT_SEGMENT_RE,
  CommitCutoffTracker,
  DEFAULT_CONFIG,
  isCommitCall,
  isCommitCommand,
  latestCommitSeq,
  resolveConfig,
  selectSinceCommit,
  type ApplyDeps,
} from "../src/main.ts";

/** 假 helper：记录调用参数，返回固定标题。 */
function fakeHelper() {
  const calls: Array<{ selected: readonly { seq: number }[]; id: unknown }> =
    [];
  return {
    calls,
    resolveSessionTitleLlmConfig: (config: Record<string, unknown>) => config,
    generateSessionTitleWithLlm: async (
      _ctx: unknown,
      _config: unknown,
      _request: unknown,
      selected: readonly { seq: number }[],
      id: unknown,
    ) => {
      calls.push({ selected, id });
      return {
        title: "标题",
        messageSeqs: selected.map((m) => m.seq),
      };
    },
  };
}

/** 假 ctx：捕获注册的 provider 与 session/event 监听器。 */
function fakeCtx() {
  let provider:
    | {
        id: string;
        automatic: string;
        generate(request: unknown): Promise<{ title: string }>;
      }
    | undefined;
  const listeners: Array<(session: { id?: unknown }, event: unknown) => void> =
    [];
  const ctx = {
    sessionTitle: {
      register: (p: typeof provider) => {
        provider = p;
        return () => {};
      },
    },
    llm: {},
    on: (
      _event: string,
      listener: (session: unknown, event: unknown) => void,
    ) => void listeners.push(listener as never),
  };
  return { ctx, listeners, providerOf: () => provider };
}

const depsWith = (helper: ReturnType<typeof fakeHelper>): ApplyDeps => ({
  loadHelper: async () => helper,
});

test("commandOf / isCommitCall：命令解析与提交判定", () => {
  assert.equal(commandOf('{"command":"git commit -m x"}'), "git commit -m x");
  assert.equal(commandOf('{"cmd":"git commit -a"}'), "git commit -a");
  assert.equal(commandOf("not json"), "not json", "非法 JSON 退化为原文");
  assert.equal(commandOf('{"foo":1}'), undefined);
  assert.equal(commandOf(""), undefined);
  assert.equal(commandOf(123), undefined);

  assert.equal(isCommitCall('{"command":"git commit -m \\"x\\""}'), true);
  assert.equal(
    isCommitCall('{"command":"git commit --amend --no-edit"}'),
    true,
  );
  assert.equal(isCommitCall('{"command":"git commit -am fix"}'), true);
  assert.equal(isCommitCall('{"command":"git log --oneline"}'), false);
  assert.equal(isCommitCall('{"command":"echo hi"}'), false);
  // 命令段落判定：只有「以 git commit 开头的段」才算提交（防文本提及误判，真机日志实证）
  assert.equal(isCommitCall('{"command":"cd /repo && git commit -m x"}'), true);
  assert.equal(isCommitCall('{"command":"git -C /repo commit -m x"}'), true);
  assert.equal(isCommitCall('{"command":"sudo git commit -m x"}'), true);
  assert.equal(
    isCommitCall(
      '{"command":"node -e \\"if (/git\\\\s+commit/.test(x)) log()\\""}',
    ),
    false,
    "核对脚本里提到 git commit 不算提交",
  );
  assert.equal(
    isCommitCall('{"command":"zstdcat log | grep \\"git commit\\""}'),
    false,
    "管道后段以 grep 开头，不算提交",
  );
  assert.ok(COMMIT_SEGMENT_RE.test("  git commit -m x"));
  assert.equal(isCommitCommand("git status && git commit"), true);
});

test("selectSinceCommit：只取 cutoff 之后；空结果回退全量", () => {
  const messages = [
    { seq: 1, text: "a" },
    { seq: 2, text: "b" },
    { seq: 5, text: "c" },
  ];
  assert.deepEqual(
    selectSinceCommit(messages, undefined),
    messages,
    "无 cutoff → 全量",
  );
  assert.deepEqual(
    selectSinceCommit(messages, 2).map((m) => m.seq),
    [5],
    "cutoff 之后的消息",
  );
  assert.deepEqual(
    selectSinceCommit(messages, 99),
    messages,
    "窗口为空 → 回退全量",
  );
});

test("CommitCutoffTracker：按会话记账 + FIFO 容量上限", () => {
  const tracker = new CommitCutoffTracker(2);
  assert.equal(tracker.cutoffOf("s1"), undefined);
  tracker.note("s1", 10);
  tracker.note("s1", 12);
  assert.equal(tracker.cutoffOf("s1"), 12, "同会话只保留最新");
  tracker.note("s2", 20);
  assert.equal(tracker.size(), 2);
  tracker.note("s3", 30);
  assert.equal(tracker.size(), 2, "容量上限生效");
  assert.equal(tracker.cutoffOf("s1"), undefined, "最旧会话被淘汰");
  tracker.note("", 1);
  tracker.note("s3", Number.NaN);
  assert.equal(tracker.size(), 2, "非法入参被忽略");
});

test("latestCommitSeq：从会话事件取最近一次提交 seq", () => {
  const events = [
    { seq: 1, type: "tool/call", data: { arguments: '{"command":"git log"}' } },
    { seq: 2, type: "user/message", data: {} },
    {
      seq: 4,
      type: "tool/call",
      data: { arguments: '{"command":"git commit -m a"}' },
    },
    {
      seq: 7,
      type: "tool/call",
      data: { arguments: '{"command":"git commit --amend"}' },
    },
  ];
  assert.equal(latestCommitSeq(events), 7);
  assert.equal(
    latestCommitSeq([
      { seq: 1, type: "tool/call", data: { arguments: '{"command":"ls"}' } },
    ]),
    undefined,
  );
  assert.equal(latestCommitSeq([]), undefined);
});

test("resolveConfig：合并缺省、忽略空串、丢弃非白名单字段", () => {
  assert.deepEqual(resolveConfig(), { ...DEFAULT_CONFIG });
  const merged = resolveConfig({
    targetCjkCharacters: 20,
    provider: "ustc",
    model: "deepseek-flash",
    unknownField: 1,
  } as never);
  assert.equal(merged["targetCjkCharacters"], 20);
  assert.equal(merged["provider"], "ustc");
  assert.equal(merged["model"], "deepseek-flash");
  assert.equal("unknownField" in merged, false, "白名单外的字段不传给 helper");
  const withEmpty = resolveConfig({ provider: "", model: "" });
  assert.equal("provider" in withEmpty, false);
  assert.equal("model" in withEmpty, false);
});

test("apply：注册 all-prompts provider；有提交时窗口只含其后的消息", async () => {
  const helper = fakeHelper();
  const fake = fakeCtx();
  await apply(fake.ctx, {}, depsWith(helper));

  const provider = fake.providerOf();
  assert.ok(provider, "应注册 provider");
  assert.equal(provider.id, "session-title-cutoff");
  assert.equal(provider.automatic, "all-prompts");

  // 记账：提交类工具调用写入 cutoff（seq 2）
  assert.equal(fake.listeners.length, 1);
  const listener = fake.listeners[0]!;
  listener(
    { id: "s1" },
    { type: "tool/call", seq: 1, data: { arguments: '{"command":"ls"}' } },
  );
  listener(
    { id: "s1" },
    {
      type: "tool/call",
      seq: 2,
      data: { arguments: '{"command":"git commit -am x"}' },
    },
  );

  const messages = [
    { seq: 1, text: "旧消息" },
    { seq: 2, text: "提交那次" },
    { seq: 3, text: "新消息" },
  ];
  await provider.generate({ session: { id: "s1" }, messages });
  assert.deepEqual(
    helper.calls[0]?.selected.map((m) => m.seq),
    [3],
    "只取提交之后的人类消息",
  );
  assert.equal(helper.calls[0]?.id, "session-title-cutoff");

  // 未提交过的会话 → 全量
  await provider.generate({ session: { id: "s2" }, messages });
  assert.deepEqual(
    helper.calls[1]?.selected.map((m) => m.seq),
    [1, 2, 3],
    "无提交记录 → 回退全量",
  );
});

test("apply：sessionQuery 重建 cutoff（重启场景）与失败降级", async () => {
  const helper = fakeHelper();
  const registered: Array<(session: unknown, event: unknown) => void> = [];
  const ctx: Record<string, unknown> = {
    sessionTitle: {
      register: (p: unknown) => {
        registered.push(p as never);
        return () => {};
      },
    },
    llm: {},
    on: () => {},
    get: (name: string) =>
      name === "sessionQuery"
        ? {
            readSession: async () => ({
              events: [
                {
                  seq: 9,
                  type: "tool/call",
                  data: { arguments: '{"command":"git commit -m r"}' },
                },
              ],
            }),
          }
        : undefined,
  };
  await apply(ctx, {}, depsWith(helper));
  const provider = registered[0] as unknown as {
    generate(request: unknown): Promise<unknown>;
  };
  const messages = [
    { seq: 1, text: "旧" },
    { seq: 12, text: "重建后" },
  ];
  await provider.generate({ session: { id: "s9" }, messages });
  assert.deepEqual(
    helper.calls[0]?.selected.map((m) => m.seq),
    [12],
    "重启后按会话事件重建 cutoff",
  );
});

test("apply：helper 缺失 / 服务缺失 / 配置非法时告警且不抛", async () => {
  const fake = fakeCtx();
  await apply(fake.ctx, {}, { loadHelper: async () => undefined });
  assert.equal(fake.providerOf(), undefined, "helper 缺失 → 不注册");

  await apply({}, {}, depsWith(fakeHelper())); // 无 sessionTitle → 直接返回

  const badConfigHelper = {
    resolveSessionTitleLlmConfig: () => {
      throw new Error("bad config");
    },
    generateSessionTitleWithLlm: async () => ({ title: "", messageSeqs: [] }),
  };
  const fake2 = fakeCtx();
  await apply(
    fake2.ctx,
    {},
    { loadHelper: async () => badConfigHelper as never },
  );
  assert.equal(fake2.providerOf(), undefined, "配置非法 → 不注册");
});
