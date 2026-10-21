# 0.2.1 宿主下标题生成仍落 fallback（接取条目：`session-title-cutoff/docs/BACKLOG.md`「0.2.1 宿主下标题生成真机仍落 fallback（provider 已注册但 `generate` 无产出）」）

状态：已关闭　　开启：2026-10-21　　关闭：2026-10-21

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

> 2026-10-21 更正：条目正文的假设「provider 已注册但 `generate` 无产出」不成立。实测根因是 `resolveSessionTitleLlmConfig` 收到未知键即抛错，`apply` 在注册前就早退，**provider 从未注册**（调研 05 / 06）。

## 目标

定位 0.2.1 宿主下 `session/title` 恒落 `{"kind":"fallback"}` 的真因并修复，使自动标题重新走模型；补一条能钉住该回归的测试；真机四项复验（标题生成 / `session/title-llm-request` 事件带 `provider` 与 `route` / `/rename` 覆盖 / restart 后保留）留主分支与用户重启后执行。

## 调研

01. **本包链路**（`src/main.ts`）：`apply(ctx, config)` 先 `loadTitleLlmHelper()` 动态加载宿主 helper（`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-session-title-llm`），再 `helper.resolveSessionTitleLlmConfig(resolveConfig(config))` 校验配置，最后 `ctx.sessionTitle.register({ id, automatic: "all-prompts", generate })`。任一步失败只告警并 return（`:387-409`）。

02. **宿主 0.2.1 provider 契约**（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-session-title/lib/index.js`）：

    - `register` 只校验 `id` 非空字符串 / `automatic` 为 `first-prompt` 或 `all-prompts` / `generate` 是函数（`:595-602`），随后 `ctx.effect` 发布注册。
    - 无注册（或已 close）时 `onUserMessage` 只走 `ensureFallback`（`:379-403`），`refresh` 同样回落（`:313-337`）——即「没有 provider」= 恒 fallback，且**不产生任何 warn**（告警只覆盖 provider 调用失败，`:442`）。
    - `runProvider` 用 `validateResult` 校验返回：`title` 非空、`messageSeqs` 必须是请求消息的**有序去重子集**、`model` 若给必须是 `{ provider, model }` 两个非空字符串（`:480-527`）。

03. **0.2.1 helper 的配置键面收窄**（同路径 `@deepseek-ai/dsh-session-title-llm/lib/index.js`）：`CONFIG_KEYS = {maxInputBytes, maxOutputTokens, timeoutMs, provider, model}`（`:84-90`），`resolveSessionTitleLlmConfig` 对集合外的键**直接抛** `session-title-llm: unknown config key "<key>"`（`:104`）。措辞（`targetWords` / `targetCjkCharacters`）与系统提示改由 provider 自己持有。

04. **官方 provider 的拆法**（`@deepseek-ai/dsh-session-title-first-prompt-llm/lib/index.js:34-38`）：`const { targetWords, targetCjkCharacters, ...execution } = config` → 只把 `execution` 交 `resolveSessionTitleLlmConfig`，再把两个目标值校验后拼回自己的 resolved。这是 0.2.1 的既定口径。

05. **本包的错**：`resolveConfig`（`src/main.ts:227-242`）把 `DEFAULT_CONFIG`（含两个措辞键，`:45-51`）与用户配置合并成一份扁平对象，原样交给 `resolveSessionTitleLlmConfig`（`:405`）。措辞两键恒在 → 0.2.1 下**每次 apply 都抛 unknown config key**，`apply` 打印 `标题 provider 配置非法` 后 return，provider 不注册。

06. **复现**（本机 0.2.1-rc.2 真实 helper，用 `node --experimental-transform-types` 直接跑 `src/main.ts` + 假 ctx，命令见「测试与证据」）：现状 `registered=false`，stderr 为 `标题 provider 配置非法：Error: session-title-llm: unknown config key "targetWords"`；**即使调用方只传 5 个执行控制键，仍然 false** —— 因为缺省合并无条件补回措辞两键。

07. **回归来源**：0.2.0 时代 helper 的配置含措辞键（`docs/archived/2026-09-29-title-cutoff-provider.md:15, 26` 记录当时的签名与「其余配置 targetWords / targetCjkCharacters / maxInputBytes / … 给缺省值」），故当时的扁平配置合法。0.2.1 把措辞下沉到 provider 后，本包未跟着拆。

08. **「真机没有 warn」的解释**：`apply` 的告警走 `process.stderr.write`（`src/main.ts:387-389`），而 dsh TUI 在 alt-screen 下绘制，裸写 stderr 的内容被重绘覆盖，肉眼看不到；宿主 logger 里也不会有（注册前就退出）。这与实测「无 `session/title-llm-request` 事件、`source` 为 fallback」完全自洽。

09. **返回形状核对（改完不会踩第二个坑）**：`executeSessionTitleLlm` 返回 `model: route`（即 `{provider, model}`，helper `:219`），本包原样透传（`src/main.ts:469-475`）→ 合 `validateResult` 的对象要求；`prepared.messageSeqs` 取自 `request.messages` 的过滤结果，天然有序去重且是子集（`selectSinceCommit`，`:96-103`）。

10. **标题字节上限有两层**：宿主 `session-title` 配置 `maxTitleBytes: 80`（`dsh-base/cordis.patch.yml:60-65`），`validateResult` 会再 `normalizeSessionTitle(title, 80)` 裁一次（`:489`）；本包自带 120 常量（`src/main.ts:469-473`）属多余的第二道，不引发错误但口径不一致。

11. **独立条件（未验证，留真机）**：0.2.1 起标题请求经 `ctx.llm.prepareCall()`，须有已注册 adapter；profile 已把本包路由切到 `tollgate` / `ds4f`（`docs/archived/2026-10-21-host-upgrade-0.2.1-rc.2.md:107`）。若真机修完仍 fallback，下一嫌疑点在此（helper 会抛，宿主 `:442` 记 `automatic title generation failed`），届时才需要 `llm.registerAdapter` 的最小补丁。

## 决策

**决策项 1 = 根因口径**

- (a) provider 未注册（配置校验早退）。
- (b) provider 已注册但 `generate` 抛错。
- **选定 (a)**。依据：调研 05 / 06，现状必抛且未走到 `register`；条目原文的 (b) 假设无证据，已在文首更正。

**决策项 2 = 修法范围**

- (a) 按官方口径拆「执行控制」与「标题措辞」两类配置，只把 5 个执行控制键交 helper。
- (b) 改调用处临时删键（`delete cfg.targetWords`）。
- (c) 自己复刻一份 helper 的校验与生成链路，不再用 helper。
- **选定 (a)**。理由：与官方 provider 同构，语义清楚；`(b)` 把知识散在调用点，任何人再往 resolved 加键又会复发；`(c)` 等于放弃 helper 提供的路由 / 预算 / 事件 / 取消语义，范围失控。

**决策项 3 = 措辞键谁来校验**

- (a) 本包校验（正整数，与官方 `assertTarget` 同口径）。
- (b) 不校验，非整数原样拼进系统提示。
- **选定 (a)**。理由：0.2.1 helper 不再看这两个键，缺校验时 `targetWords: 0` 会静默生成「about 0 words」的提示词；官方 provider 也是自校验。

**决策项 4 = 0.2.0 兼容分支**

- ~~(a) 保留（`generateSessionTitleWithLlm` 分支继续收全量配置）。~~
- (b) 删除旧分支，只认 `execute`。
- **选定 (b)**（2026-10-21 用户裁定「不保留 0.2.0 的分支」）。理由：宿主基线已钉 0.2.1-rc.2，双形态并存让「交给 helper 的配置键面」出现两套口径，而这次缺陷正是键面口径错位造成；且旧分支在 0.2.1 机器上不可测、只能靠假替身维持。落地口径：`loadTitleLlmHelper` 只认 `executeSessionTitleLlm`，只提供旧 `generateSessionTitleWithLlm` 的 helper 视为不可用（告警、不注册）；`TitlePrepared` / `execute` 成为唯一生成路径。代价：回退宿主版本须一并回退本包（记入已知边界）。

**决策项 5 = 标题字节上限**

- (a) 去掉本包 120 常量，传 `Number.MAX_SAFE_INTEGER`，由宿主 `maxTitleBytes` 统一裁剪。
- (b) 保留 120。
- **选定 (a)**。理由：与官方 provider 同口径（它传 `Number.MAX_SAFE_INTEGER`），避免两处上限各自漂移；清洗（控制字符 / 折行 / 星号强调）仍在本包做，宿主再做一次同款清洗无害。

**决策项 6 = 失败可观测性**

- (a) 告警优先走 `ctx.logger?.warn`，不可用时回落 `process.stderr.write`。
- (b) 保持只写 stderr。
- **选定 (a)**。理由：调研 08 证明 stderr 在 TUI 下不可见，这类「注册前早退」会静默一整天；宿主本身也经 `ctx.logger.warn` 报告标题失败（`:401, 442`），走同一出口才查得到。文案保留原始错误串（含键名）。

**决策项 7 = 测试替身口径**

- (a) 假 helper 复刻 0.2.1 严格键面（未知键抛、正整数、provider/model 成对），并补一条「真实安装的 helper 接受本包 execution 子集」的契约测试（helper 不存在则 skip）。
- (b) 维持现在的宽松替身（`resolveSessionTitleLlmConfig: (c) => c`）。
- **选定 (a)**。理由：现状替身把缺陷盖住了 —— 它接受任何键，所以 11 例全绿却真机恒 fallback；契约测试直接用本机 helper，能在不连模型的前提下钉住键面。

**决策项 8 = 明确不做**

- 不注册 `llm.registerAdapter`（等真机复验结果，见调研 11）。
- 不改宿主 fallback 策略、不改窗口裁剪逻辑（`selectSinceCommit` / cutoff 记账不动）。
- 不加命令面（`/title` 之类）、不改 profile 配置、不动其它包。
- 不追溯 0.2.0 helper 的键面差异做运行时嗅探（`CONFIG_KEYS` 未导出，嗅探只能靠 try/catch 猜）。

**决策项 9 = 真机复验归属**

- (a) 留主分支合并后由用户重启执行（四项：标题生成 / `title-llm-request` 事件带 `provider` 与 `route` / `/rename` 覆盖 / restart 后保留）。
- (b) 实现分支里开独立 tab 实例复验。
- **选定 (a)**。理由：标题要真实模型与真实 profile 路由；独立实例需要另起 dsh 会话，且本任务的证据链（真实 helper 契约测试）已足够，真机只作最终确认。

## 规划

1. 拆配置：`resolveConfig` 保持「合并缺省 + 白名单」不变（对外兼容），新增纯函数 `executionConfigOf(resolved)` 只挑 `maxInputBytes` / `maxOutputTokens` / `timeoutMs` / `provider` / `model`；`resolved` 里措辞两键保留。
2. 本地校验措辞两键（正整数），失败时的告警文案与配置非法分支一致（不注册、不抛）。
3. `apply`：加载守卫只认 `executeSessionTitleLlm`；删掉 `generateSessionTitleWithLlm` 兼容面、旧分支与相关注释；配置校验改用 `executionConfigOf(...)` 的结果。
4. 标题字节上限改 `Number.MAX_SAFE_INTEGER`，删掉 120 常量与 `maxTitleBytes` 读取。
5. 诊断出口：`warn` 改为 `ctx.logger?.warn` 优先、stderr 兜底（`warn` 在 apply 内部定义，改为读 `ctx.logger`）。
6. 测试：严格替身 + `executionConfigOf` 键面断言 + 措辞非法用例 + 真实 helper 契约测试（skip 兜底）；删掉 0.2.0 分支用例，改为「只提供旧 `generate` 的 helper 视为不可用（告警、不注册）」。
7. 文档：`README.md` 配置表把 `targetWords` 的「透传官方 helper」改为「本包自用（0.2.1 起 helper 不收措辞键）」；「宿主依赖姿态」补一句「只把执行控制键交 helper」。
8. 验证：`npm --prefix session-title-cutoff run check / test / build`；`format` 改动文件；真机四项按决策 9 留主分支。

## 计划改动文件清单

- `session-title-cutoff/src/main.ts`（配置拆分 / 措辞校验 / 字节上限 / 告警出口）
- `session-title-cutoff/tests/main.test.ts`（严格替身 + 回归与契约用例）
- `session-title-cutoff/README.md`（配置表与依赖姿态两句同步）
- `session-title-cutoff/docs/BACKLOG.md`（条目状态：进行中 → 完成）
- `session-title-cutoff/docs/archived/2026-10-21-title-fallback-config-split.md`（本文件，收尾时由 `docs/implementation/` 归档）

## 测试要点

1. `executionConfigOf`：输出恰好 5 个键；含 `provider` / `model` 时保留，缺省时不含；任何措辞键都不出现。
2. `resolveConfig`：现有语义不变（缺省合并、空串忽略、白名单过滤）。
3. 严格替身下 `apply` 能注册 provider（回归点：改前必失败），且 `executeSessionTitleLlm` 收到的配置不含 `targetWords` / `targetCjkCharacters`。
4. 措辞非法（`targetWords: 0` / `1.5`）→ 告警且不注册。
5. 真实 helper 契约测试：`resolveSessionTitleLlmConfig(executionConfigOf(resolveConfig(profile 同款配置)))` 不抛；helper 缺失时 skip。
6. 旧形态 helper（只导出 `generateSessionTitleWithLlm`）→ 判为不可用：告警且不注册，不回落旧分支。
7. 既有用例（提交判定 / 窗口 / 记账 / 事件重建 / 标题清洗）全部保持通过。
8. `check` / `build` 通过。

## 明确不做的部分

- 不改宿主包、不改 profile（工作区外）。
- 不引入 `@deepseek-ai/*` 依赖（继续运行时解析）。
- 不动 `selectSinceCommit` / `CommitCutoffTracker` / `latestCommitSeq` 的窗口语义。
- 不新增命令、notice、TUI 面。
- 不保留 0.2.0 helper 形态兼容（决策 4；回退宿主须一并回退本包）。
- 不对 0.2.0 / 0.2.1 helper 做运行时键面嗅探。

## 估时

单线程约 **0.5 天**：改动 3 个文件、测试 4 至 6 例；真机四项复验另计（主分支，约 10 min）。

## 实现记录

按「规划」8 步落地（2026-10-21，分支 `dsh/session-title-fix`，代码提交 `b8cbfaf`）。

1. **配置拆分**：`src/main.ts:239` 新增 `EXECUTION_CONFIG_KEYS`（5 个执行控制键）；`src/main.ts:251` 新增 `executionConfigOf(resolved)`，按该白名单从合并结果里挑选。`resolveConfig`（`src/main.ts:221-236`）保持「合并缺省 + 白名单过滤」不变，返回对象仍含措辞两键。
2. **措辞校验**：`src/main.ts:263` 新增 `assertTitleTarget(name, value)`（正整数，文案 `session-title-cutoff: <name> must be a positive integer`）；`apply` 对合并结果的两键各调一次（`src/main.ts:447-451`），抛错与 helper 校验同走「标题 provider 配置非法」告警分支（`:452-455`），只告警、不注册、不向上抛。
3. **只认 execute 形态**：`SessionTitleLlmHelper` 删掉 `generateSessionTitleWithLlm` 与 `SessionTitleLlmConfigFields` 结构面（`src/main.ts:138-150`），`executeSessionTitleLlm` 改为必选；新增 `isUsableTitleLlmHelper`（`:194`），在 `loadTitleLlmHelper`（`:204`）与 `apply`（`:431-437`）两处复用；`generate` 回调删掉 0.2.0 分支，只组装 `prepared` 并调 `helper.executeSessionTitleLlm`（`:487-510`）。
4. **字节上限**：`titleFromResponse(response, Number.MAX_SAFE_INTEGER)`（`src/main.ts:506`），删掉 `maxTitleBytes ?? 120` 与相关读取（本包仍做控制字符 / 折行 / 星号强调清洗）。
5. **诊断出口**：`warn` 的定义移到 ctx 解构之后（`src/main.ts:413-425`），优先 `ctx.logger?.warn`；logger 缺失或自身抛错时回落 `process.stderr.write`。`PluginContext` 补 `logger?: { warn?(message: string): unknown }`（`:180`）。
6. **测试**：`tests/main.test.ts:47` 严格替身复刻 0.2.1 键面（未知键抛 / 三个正整数 / provider 与 model 成对且非空 / 返回冻结对象）；`fakeCtx` 捕获 logger 告警并支持「logger 抛错」（`:122`）。新增 6 例：`executionConfigOf` 键面（`:276`）、严格替身下注册且交给 helper 的配置无措辞键（`:310`）、旧形态 helper 不可用（`:408`）、措辞非法不注册（`:503`）、logger 抛错回落 stderr（`:530`）、真实 helper 契约（`:550`，未安装时 skip）；删掉原 0.2.0 兼容分支用例。
7. **文档**：`README.md:16-17` 配置表注明措辞两键本包自用并校验；`README.md:30-34` 依赖姿态补「只把执行控制键交 helper」与「只认 execute 形态，回退 0.2.0 须一并回退本包」。
8. **验证**：`npm --prefix session-title-cutoff run check / test / build` 全通过（输出见「测试与证据」）；`format src/main.ts tests/main.test.ts README.md` 已跑；原复现脚本改后两条配置均 `registered=true`、零告警。

## 偏差

1. **实现期未改 `docs/BACKLOG.md`**：任务约束 9 把条目状态（进行中 → 完成）与收尾留到主分支合并后，故实现分支未动；收尾提交已把条目移出、留关闭注记，并把文首状态行改为「已关闭」。
2. **`isUsableTitleLlmHelper` 是计划外新增的导出**：计划只写「加载守卫只认 `executeSessionTitleLlm`」；为让测试注入的旧形态 helper 也走同一判定（而非只在 `loadTitleLlmHelper` 内判断），把守卫提成纯函数并在两处复用。
3. **logger 回落条件细化**：决策 6 写「不可用时回落 stderr」；实现把「logger 自身 `warn` 抛错」也纳入回落（否则告警会连带让 `apply` 抛出），并加用例钉住。
4. **`EXECUTION_CONFIG_KEYS` 为新增导出**：让执行键白名单只有一处定义、便于测试与诊断核对；计划只点名 `executionConfigOf`。
5. **未跑真机四项复验**：按任务约束 8 与决策 9 留主分支合并后由用户重启执行；本分支只做真实 helper 契约测试（不连模型、不启 dsh、不动用户会话与 herdr 布局）。
6. **`dist/` 已重建但未入库**（`.gitignore` 忽略）：profile 生效仍需主分支合并后按常规流程构建。

## 测试与证据

### 调研期证据（2026-10-21，本机 0.2.1-rc.2 真实 helper）

复现方式：在 `session-title-cutoff/` 下直跑 `src/main.ts` + 假 ctx（只记录 `register` 是否发生，`ctx.llm` 为空、不连模型、不触真实会话），分别喂「profile 同款配置（含措辞两键）」与「只含 5 个执行控制键的配置」。

```sh
cd session-title-cutoff
node --experimental-transform-types --input-type=module -e '
import { apply } from "./src/main.ts";
function mk() {
  let provider;
  const ctx = { sessionTitle: { register: (p) => { provider = p; return () => {}; } }, llm: {}, on: () => {} };
  return { ctx, has: () => provider !== undefined };
}
const a = mk();
await apply(a.ctx, { targetWords: 5, targetCjkCharacters: 15, maxInputBytes: 32768, maxOutputTokens: 512, timeoutMs: 60000, provider: "tollgate", model: "ds4f" });
process.stdout.write(`现状注册结果 registered=${a.has()}\n`);
const b = mk();
await apply(b.ctx, { maxInputBytes: 32768, maxOutputTokens: 512, timeoutMs: 60000, provider: "tollgate", model: "ds4f" });
process.stdout.write(`仅执行控制键 registered=${b.has()}\n`);
'
```

输出原文：

```
[session-title-cutoff] warn: 标题 provider 配置非法：Error: session-title-llm: unknown config key "targetWords"
现状注册结果 registered=false
[session-title-cutoff] warn: 标题 provider 配置非法：Error: session-title-llm: unknown config key "targetWords"
仅执行控制键 registered=false
```

结论：现状必抛；只改调用点传参也不够（`resolveConfig` 的缺省合并会把措辞键补回），必须改 `resolveConfig` 的产物分层。单条最小验证：`resolveSessionTitleLlmConfig({maxInputBytes: 32768, maxOutputTokens: 512, timeoutMs: 60000})` 返回冻结对象，加 `targetWords: 5` 即抛 `session-title-llm: unknown config key "targetWords"`。

### 实现期证据（2026-10-21，分支 `dsh/session-title-fix` @ `b8cbfaf`，本机 helper 0.2.1-rc.2）

命令均在 `.worktree/session-title-cutoff` 下执行；helper 版本取自 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-session-title-llm/package.json`（`0.2.1-rc.2`）。

```sh
npm --prefix session-title-cutoff run check
```

```text
npm notice run @dsh-toolset/session-title-cutoff@0.1.0 check
npm notice run tsc -p tsconfig.json --noEmit
```

（退出码 0。）

```sh
npm --prefix session-title-cutoff run test
```

```text
npm notice run @dsh-toolset/session-title-cutoff@0.1.0 test
npm notice run node --experimental-transform-types --test 'tests/*.test.ts'
(node:44) ExperimentalWarning: Transform Types is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
[session-title-cutoff] warn: ctx.sessionTitle 不可用，标题窗口裁剪不会生效
✔ commandOf / isCommitCall：命令解析与提交判定 (0.669228ms)
✔ selectSinceCommit：只取 cutoff 之后；空结果回退全量 (0.352107ms)
✔ CommitCutoffTracker：按会话记账 + FIFO 容量上限 (0.091541ms)
✔ latestCommitSeq：从会话事件取最近一次提交 seq (0.090058ms)
✔ resolveConfig：合并缺省、忽略空串、丢弃非白名单字段 (0.10179ms)
✔ executionConfigOf：恰好 5 个执行控制键；措辞键与路由缺省都不出现 (0.090128ms)
✔ apply：严格 0.2.1 替身下注册成功；execute 收到的配置不含措辞键 (0.584981ms)
✔ apply：注册 all-prompts provider；有提交时窗口只含其后的消息（0.2.1 execute 形态） (0.24649ms)
✔ apply：只提供旧 generate 形态的 helper 视为不可用（告警、不注册） (0.116367ms)
✔ apply：sessionQuery 重建 cutoff（重启场景）与失败降级 (0.20353ms)
✔ apply：helper 缺失 / 服务缺失 / 配置非法时告警且不抛 (0.211715ms)
✔ apply：措辞目标非法（0 / 非整数 / NaN）→ 告警且不注册 (0.329143ms)
✔ apply：logger.warn 抛错时回落 stderr（诊断不丢） (0.101058ms)
✔ 真实 helper 契约：executionConfigOf 的输出通过本机 0.2.1 键面校验（未安装 skip） (7.194177ms)
✔ titleSystemPrompt / frameTitleMessages / selectReasoningEffort：0.2.1 prepared 组装原件 (0.078226ms)
✔ titleFromResponse / normalizeTitleText：取首行、剥整行星号强调、字节截断 (0.111539ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 83.56382
```

（退出码 0；`warn: ctx.sessionTitle 不可用` 来自「服务缺失」子用例走 stderr 兜底的预期输出，非失败。）

```sh
npm --prefix session-title-cutoff run build
```

```text
npm notice run @dsh-toolset/session-title-cutoff@0.1.0 build
npm notice run tsc -p tsconfig.json
```

（退出码 0。）

回归复现（同调研 06 的脚本，改后重跑；假 ctx 带 logger 收集告警，不连模型）：

```sh
cd session-title-cutoff
node --experimental-transform-types --input-type=module -e '
import { apply } from "./src/main.ts";
function mk(logger) {
  let provider;
  const ctx = { sessionTitle: { register: (p) => { provider = p; return () => {}; } }, llm: {}, on: () => {}, logger };
  return { ctx, has: () => provider !== undefined };
}
const warns = [];
const a = mk({ warn: (m) => warns.push(m) });
await apply(a.ctx, { targetWords: 5, targetCjkCharacters: 15, maxInputBytes: 32768, maxOutputTokens: 512, timeoutMs: 60000, provider: "tollgate", model: "ds4f" });
process.stdout.write(`profile 同款配置 registered=${a.has()} warns=${warns.length}\n`);
const b = mk({ warn: (m) => warns.push(m) });
await apply(b.ctx, { maxInputBytes: 32768, maxOutputTokens: 512, timeoutMs: 60000, provider: "tollgate", model: "ds4f" });
process.stdout.write(`仅执行控制键 registered=${b.has()} warns=${warns.length}\n`);
'
```

输出原文：

```text
profile 同款配置 registered=true warns=0
仅执行控制键 registered=true warns=0
```

对照调研期证据（改前 `registered=false`，告警 `unknown config key "targetWords"`）：配置拆分后 provider 能注册，回归由用例「`apply：严格 0.2.1 替身下注册成功`」与「`真实 helper 契约`」双重钉住。

格式化：`format src/main.ts tests/main.test.ts README.md`（`src/main.ts 62ms`、`tests/main.test.ts 58ms`；README 无改动输出），随后 `git diff --check` 干净。

## 收尾

- **条目完成并移出**：`docs/BACKLOG.md` 的条目已移出（只留 2026-10-21 关闭注记），文首状态改为「已关闭」。
- **合并**：`dsh/session-title-fix`（`b8cbfaf` 修复 + `100ed66` 文档）已合并，合并提交 `15806bc`；真机验证在合并后的新实例上执行。
- **测试**：包内 `check` / `build` 通过，`npm test` 16 例全绿（原 11 例；新增严格键面替身、旧形态不可用、措辞非法、logger 回落、真实 helper 契约），真实 helper 为 0.2.1-rc.2。
- **真机结论（3 项通过）**：
  - 自动标题生成：`session/title` 的 `source.kind=provider`，`provider=session-title-cutoff`（不再 fallback）。
  - `session/title-llm-request` 事件带 `titleProvider` 与 `route={provider:"tollgate",model:"ds4f"}`。
  - `/rename` 后新增 `source.kind=user` 的标题（手动 pin 语义保持）。
- **真机未验证（1 项）**：restart 后标题保留 —— `/restart` 提示「重启不可用：需由启动器启动（未设置 `DSH_RESTART_FILE`）」，本环境无法触发；留待后续按需由启动器重启确认（不影响本条目关闭：核心链路与事件已实证）。
- **已知边界**：只支持 0.2.1 起的 `executeSessionTitleLlm` 形态；回退 0.2.0 宿主须一并回退本包（旧 `generate` 形态 helper 视为不可用，告警且不注册）。标题字节上限交宿主 `maxTitleBytes`（本包传 `Number.MAX_SAFE_INTEGER`）。
- **文档**：README 配置表与「宿主依赖姿态」已在 `100ed66` 同步（措辞两键本包自用、只交执行控制键、只认 execute 形态），收尾无需再改。
