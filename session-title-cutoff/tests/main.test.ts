/**
 * session-title-cutoff 单测：提交判定、窗口过滤与回退、记账（容量）、事件重建、
 * 配置拆分与 apply 装配（假 ctx + 严格复刻 0.2.1 键面的假 helper，不触宿主与真实 LLM）；
 * 另有一条用本机真实 helper 校验键面的契约测试（未安装时 skip）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  apply,
  assertTitleTarget,
  commandOf,
  COMMIT_SEGMENT_RE,
  CommitCutoffTracker,
  DEFAULT_CONFIG,
  executionConfigOf,
  frameTitleMessages,
  isCommitCall,
  isCommitCommand,
  isUsableTitleLlmHelper,
  latestCommitSeq,
  loadTitleLlmHelper,
  normalizeTitleText,
  resolveConfig,
  selectReasoningEffort,
  selectSinceCommit,
  titleFromResponse,
  titleSystemPrompt,
  type ApplyDeps,
} from "../src/main.ts";

/** 0.2.1 helper 接受的键集合（宿主 `CONFIG_KEYS`）。 */
const HELPER_CONFIG_KEYS = new Set([
  "maxInputBytes",
  "maxOutputTokens",
  "timeoutMs",
  "provider",
  "model",
]);

/**
 * 严格复刻 0.2.1 `resolveSessionTitleLlmConfig` 的键面：未知键抛、正整数、
 * `provider` / `model` 成对且非空、返回冻结对象。
 * （宽松替身「接受任何键」正是本缺陷被 11 例全绿盖住的原因。）
 */
function strictResolveSessionTitleLlmConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (config === null || typeof config !== "object") {
    throw new Error("session-title-llm: configuration is required");
  }
  for (const key of Object.keys(config)) {
    if (!HELPER_CONFIG_KEYS.has(key)) {
      throw new Error(`session-title-llm: unknown config key "${key}"`);
    }
  }
  for (const key of [
    "maxInputBytes",
    "maxOutputTokens",
    "timeoutMs",
  ] as const) {
    const value = config[key];
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new Error(`session-title-llm: ${key} must be a positive integer`);
    }
  }
  const hasProvider = config["provider"] !== undefined;
  if (hasProvider !== (config["model"] !== undefined)) {
    throw new Error(
      "session-title-llm: provider and model must be supplied together",
    );
  }
  if (
    hasProvider &&
    (typeof config["provider"] !== "string" ||
      config["provider"] === "" ||
      typeof config["model"] !== "string" ||
      config["model"] === "")
  ) {
    throw new Error(
      "session-title-llm: provider and model overrides must be non-empty strings",
    );
  }
  return Object.freeze({ ...config });
}

/** 假 helper（0.2.1 execute 形态）：捕获 prepared、provider id 与执行控制配置。 */
function fakeHelper021(title = "生成的标题") {
  const calls: Array<{
    prepared: { messageSeqs: readonly number[]; system: string; input: string };
    id: unknown;
    config: Record<string, unknown>;
  }> = [];
  return {
    calls,
    resolveSessionTitleLlmConfig: strictResolveSessionTitleLlmConfig,
    executeSessionTitleLlm: async (
      _ctx: unknown,
      config: Record<string, unknown>,
      _request: unknown,
      id: unknown,
      prepared: {
        messageSeqs: readonly number[];
        system: string;
        input: string;
        selectReasoningEffort: (m: unknown) => string | undefined;
      },
    ) => {
      calls.push({ prepared, id, config });
      void prepared.selectReasoningEffort;
      return {
        blocks: [{ type: "text", text: title }],
        finish: { kind: "stop" },
        model: { reasoning: { efforts: [{ id: "high" }] } },
      };
    },
  };
}

/** 假 ctx：捕获注册的 provider、session/event 监听器与 logger 告警。 */
function fakeCtx(options: { loggerThrows?: boolean } = {}) {
  let provider:
    | {
        id: string;
        automatic: string;
        generate(request: unknown): Promise<{ title: string }>;
      }
    | undefined;
  const listeners: Array<(session: { id?: unknown }, event: unknown) => void> =
    [];
  const warnings: string[] = [];
  const ctx = {
    sessionTitle: {
      register: (p: typeof provider) => {
        provider = p;
        return () => {};
      },
    },
    llm: {},
    logger: {
      warn: (message: string) => {
        if (options.loggerThrows === true) throw new Error("logger down");
        warnings.push(message);
      },
    },
    on: (
      _event: string,
      listener: (session: unknown, event: unknown) => void,
    ) => void listeners.push(listener as never),
  };
  return { ctx, listeners, providerOf: () => provider, warnings };
}

const depsWith = (helper: unknown): ApplyDeps => ({
  loadHelper: async () => helper as never,
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

test("executionConfigOf：恰好 5 个执行控制键；措辞键与路由缺省都不出现", () => {
  const execution = executionConfigOf(
    resolveConfig({
      targetWords: 7,
      targetCjkCharacters: 21,
      provider: "tollgate",
      model: "ds4f",
    }),
  );
  assert.deepEqual(Object.keys(execution).sort(), [
    "maxInputBytes",
    "maxOutputTokens",
    "model",
    "provider",
    "timeoutMs",
  ]);
  assert.equal(execution["maxInputBytes"], 32768);
  assert.equal(execution["provider"], "tollgate");
  assert.equal("targetWords" in execution, false, "措辞键不交给 helper");
  assert.equal("targetCjkCharacters" in execution, false);

  const noRoute = executionConfigOf(resolveConfig());
  assert.deepEqual(Object.keys(noRoute).sort(), [
    "maxInputBytes",
    "maxOutputTokens",
    "timeoutMs",
  ]);
  assert.equal(
    "provider" in noRoute,
    false,
    "缺省不带路由（由会话已记录路由兜底）",
  );
});

test("apply：严格 0.2.1 替身下注册成功；execute 收到的配置不含措辞键", async () => {
  const helper = fakeHelper021("长".repeat(60));
  const fake = fakeCtx();
  await apply(
    fake.ctx,
    {
      targetWords: 7,
      targetCjkCharacters: 21,
      provider: "tollgate",
      model: "ds4f",
    },
    depsWith(helper),
  );

  const provider = fake.providerOf();
  assert.ok(
    provider,
    "改前整份配置含 targetWords，严格替身会抛 unknown config key",
  );
  // 本地不再按 120 字节截断（决策 5）：超长标题原样返回，交给宿主 maxTitleBytes 裁剪
  const result = await provider.generate({
    session: { id: "s-long" },
    messages: [{ seq: 1, text: "x" }],
  });
  assert.equal(Array.from(result.title).length, 60);
  assert.match(
    helper.calls[0]?.prepared.system ?? "",
    /7 words in non-CJK languages or 21 CJK characters/,
    "措辞目标由本包校验后拼进系统提示",
  );
  const config = helper.calls[0]?.config ?? {};
  assert.deepEqual(Object.keys(config).sort(), [
    "maxInputBytes",
    "maxOutputTokens",
    "model",
    "provider",
    "timeoutMs",
  ]);
  assert.equal("targetWords" in config, false);
  assert.equal("targetCjkCharacters" in config, false);
  assert.ok(Object.isFrozen(config), "helper 返回已冻结的配置对象");
  assert.equal(fake.warnings.length, 0, "成功路径无告警");
});

test("apply：注册 all-prompts provider；有提交时窗口只含其后的消息（0.2.1 execute 形态）", async () => {
  const helper = fakeHelper021();
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
    helper.calls[0]?.prepared.messageSeqs,
    [3],
    "只取提交之后的人类消息",
  );
  assert.match(
    helper.calls[0]?.prepared.input ?? "",
    /新消息/,
    "input 帧含选定消息",
  );
  assert.match(helper.calls[0]?.prepared.system ?? "", /concise title/);
  assert.equal(helper.calls[0]?.id, "session-title-cutoff");

  // 未提交过的会话 → 全量
  await provider.generate({ session: { id: "s2" }, messages });
  assert.deepEqual(
    helper.calls[1]?.prepared.messageSeqs,
    [1, 2, 3],
    "无提交记录 → 回退全量",
  );
});

test("apply：只提供旧 generate 形态的 helper 视为不可用（告警、不注册）", async () => {
  const legacy = {
    resolveSessionTitleLlmConfig: strictResolveSessionTitleLlmConfig,
    generateSessionTitleWithLlm: async () => ({
      blocks: [{ type: "text", text: "0.2.0" }],
      finish: { kind: "stop" },
      model: {},
    }),
  };
  const fake = fakeCtx();
  await apply(fake.ctx, {}, depsWith(legacy));
  assert.equal(fake.providerOf(), undefined, "不回落旧分支");
  assert.match(fake.warnings.join("\n"), /executeSessionTitleLlm/);

  assert.equal(isUsableTitleLlmHelper(legacy as never), false);
  assert.equal(isUsableTitleLlmHelper(undefined), false);
  assert.equal(isUsableTitleLlmHelper({} as never), false);
});

test("apply：sessionQuery 重建 cutoff（重启场景）与失败降级", async () => {
  const helper = fakeHelper021();
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
    helper.calls[0]?.prepared.messageSeqs,
    [12],
    "重启后按会话事件重建 cutoff",
  );
});

test("apply：helper 缺失 / 服务缺失 / 配置非法时告警且不抛", async () => {
  const fake = fakeCtx();
  await apply(fake.ctx, {}, { loadHelper: async () => undefined });
  assert.equal(fake.providerOf(), undefined, "helper 缺失 → 不注册");
  assert.match(
    fake.warnings.join("\n"),
    /未能加载可用的宿主.*executeSessionTitleLlm.*不注册 provider/,
    "告警走 ctx.logger（TUI 下 stderr 会被重绘覆盖）",
  );

  const serviceMissing = fakeCtx();
  await apply({}, {}, depsWith(fakeHelper021())); // 无 sessionTitle → 直接返回

  const badConfigHelper = {
    resolveSessionTitleLlmConfig: () => {
      throw new Error("bad config");
    },
    executeSessionTitleLlm: async () => ({
      blocks: [{ type: "text", text: "x" }],
      finish: { kind: "stop" },
    }),
  };
  const fake2 = fakeCtx();
  await apply(
    fake2.ctx,
    {},
    { loadHelper: async () => badConfigHelper as never },
  );
  assert.equal(fake2.providerOf(), undefined, "配置非法 → 不注册");
  assert.match(fake2.warnings.join("\n"), /配置非法.*bad config/);
  assert.equal(serviceMissing.providerOf(), undefined);
});

test("apply：措辞目标非法（0 / 非整数 / NaN）→ 告警且不注册", async () => {
  const cases: Array<{ config: Record<string, unknown>; key: string }> = [
    { config: { targetWords: 0 }, key: "targetWords" },
    { config: { targetWords: 1.5 }, key: "targetWords" },
    { config: { targetCjkCharacters: 0 }, key: "targetCjkCharacters" },
    { config: { targetCjkCharacters: Number.NaN }, key: "targetCjkCharacters" },
  ];
  for (const { config, key } of cases) {
    const fake = fakeCtx();
    await apply(fake.ctx, config as never, depsWith(fakeHelper021()));
    assert.equal(fake.providerOf(), undefined, `${key} 非法 → 不注册`);
    assert.match(
      fake.warnings.join("\n"),
      new RegExp(`${key} must be a positive integer`),
    );
  }
  assert.throws(
    () => assertTitleTarget("targetWords", 0),
    /must be a positive integer/,
  );
  assert.throws(
    () => assertTitleTarget("targetCjkCharacters", 2.5),
    /must be a positive integer/,
  );
  assert.equal(assertTitleTarget("targetWords", 5), 5);
});

test("apply：logger.warn 抛错时回落 stderr（诊断不丢）", async () => {
  const fake = fakeCtx({ loggerThrows: true });
  const original = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await apply(fake.ctx, {}, { loadHelper: async () => undefined });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(fake.providerOf(), undefined);
  assert.match(
    chunks.join(""),
    /\[session-title-cutoff\] warn: 未能加载可用的宿主/,
  );
});

test("真实 helper 契约：executionConfigOf 的输出通过本机 0.2.1 键面校验（未安装 skip）", async (t) => {
  const helper = await loadTitleLlmHelper();
  if (helper === undefined) {
    t.skip(
      "本机未安装可用的 @deepseek-ai/dsh-session-title-llm（execute 形态）",
    );
    return;
  }
  const execution = executionConfigOf(
    resolveConfig({
      targetWords: 5,
      targetCjkCharacters: 15,
      maxInputBytes: 32768,
      maxOutputTokens: 512,
      timeoutMs: 60000,
      provider: "tollgate",
      model: "ds4f",
    }),
  );
  const resolved = helper.resolveSessionTitleLlmConfig(execution) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(resolved).sort(), [
    "maxInputBytes",
    "maxOutputTokens",
    "model",
    "provider",
    "timeoutMs",
  ]);
  assert.ok(Object.isFrozen(resolved), "真实 helper 返回冻结对象");

  // 钉住原缺陷：整份 resolveConfig 含措辞键 → 抛 unknown config key
  assert.throws(
    () => helper.resolveSessionTitleLlmConfig(resolveConfig()),
    /unknown config key "targetWords"/,
  );
  assert.throws(
    () => helper.resolveSessionTitleLlmConfig({ ...execution, targetWords: 5 }),
    /unknown config key "targetWords"/,
  );
  assert.throws(
    () => helper.resolveSessionTitleLlmConfig({ maxInputBytes: 32768 }),
    /maxOutputTokens must be a positive integer/,
  );
});

test("titleSystemPrompt / frameTitleMessages / selectReasoningEffort：0.2.1 prepared 组装原件", () => {
  const sys = titleSystemPrompt({ targetWords: 5, targetCjkCharacters: 15 });
  assert.match(sys, /concise title/);
  assert.match(sys, /5 words in non-CJK languages or 15 CJK characters/);
  assert.match(sys, /15 CJK/);

  const frame = frameTitleMessages([{ seq: 3 }]);
  assert.match(frame, /JSON array of human messages/);
  assert.match(frame, /"seq":3/);

  assert.equal(
    selectReasoningEffort({ reasoning: { efforts: [{ id: "high" }] } }),
    "high",
  );
  assert.equal(selectReasoningEffort({}), undefined);
  assert.equal(selectReasoningEffort(undefined), undefined);
});

test("titleFromResponse / normalizeTitleText：取首行、剥整行星号强调、字节截断", () => {
  const stop = (blocks: { type: string; text?: string }[]) => ({
    blocks,
    finish: { kind: "stop" as const },
    model: {},
  });
  assert.equal(
    titleFromResponse(
      stop([{ type: "text", text: "**真机验证标题**\n 附带说明" }]),
      1024,
    ),
    "真机验证标题",
    "剥整行星号强调取首行",
  );
  assert.equal(
    titleFromResponse(stop([{ type: "text", text: " 多   行 标题 " }]), 1024),
    "多 行 标题",
    "折叠空白",
  );
  assert.throws(
    () => titleFromResponse(stop([{ type: "tool-call" }]), 1024),
    /text only/,
  );
  const long = "标题".repeat(100);
  assert.ok(Buffer.byteLength(normalizeTitleText(long, 60), "utf8") <= 60);
});
