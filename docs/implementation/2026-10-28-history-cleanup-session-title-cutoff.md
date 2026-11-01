# session-title-cutoff 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 session-title-cutoff 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `session-title-cutoff` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 无代码改动, 不建分支.

## 现状

- 单元层: `tests/` 下 1 个 `.test.ts` (`main.test.ts`); 阶段 1 末 `pnpm -C session-title-cutoff run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 94.7% (373/394); 分支 81.4% (70/86).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: `tests/main.test.ts:553` 的 `skip` 按 4.4 处理
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C session-title-cutoff run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-session-title-cutoff && mkdir -p ../tmp/cov-session-title-cutoff && NODE_V8_COVERAGE=../tmp/cov-session-title-cutoff node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-session-title-cutoff tmp/cov-session-title-cutoff/report.json
```

- 专项: `tests/main.test.ts:553` 的 `skip` 按 4.4 处理.
- 验收: `pnpm -C session-title-cutoff run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 session-title-cutoff 测试锚定`.

### 代码

阶段 3 无代码改动, 不建分支. 本包的整理在阶段 4 (包文档) 完成.

### 包文档

- 分支 `history-cleanup/04-package-docs-session-title-cutoff`, worktree `.worktree/04-package-docs/session-title-cutoff`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/BACKLOG.md`.
- `README.md`: 现有 5 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- `docs/BACKLOG.md`: 同文件的命令与术语同步改; 条目内容、状态与顺序不动.
- 验收: 六节齐 (无配置可省)、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(session-title-cutoff): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

- 脚本: `session-title-cutoff/package.json` 加 `test:integration` 与 `test:coverage`, 命令与 `clock-base` / `rule-engine` 同构; 覆盖率临时目录 `tmp/cov-session-title-cutoff`, 报告 `tmp/cov-session-title-cutoff/report.json`。
- 装配器: `session-title-cutoff/tests/assemble.ts` (不以 `.test.ts` 结尾, 不参与覆盖率统计)。本包无工具注册与落盘, 三个假面按 `src/index.ts` 的结构面拼: 服务面给唯一 provider 槽位 (第二次注册即抛, 与宿主一致) 与 `sessionQuery.readSession` 只读快照 (可注入抛错与畸形快照); 事件面给 `session/event` 派发口并按宿主形状把 `(session, event)` 两个参数拆给监听器; 工具面只记注册数 (零断言)。宿主 helper 经 `ApplyDeps.loadHelper` 注入严格复刻 0.2.1 键面的假实现, 不解析真实宿主包; 假 git 提交面记录读过的会话 id, 告警从 `ctx.logger` 与 stderr 两处抓取。
- 集成层: `tests/integration/plugin.test.ts` 18 条, 覆盖 provider 注册契约 (id / `all-prompts` / 单槽位占位 / 无 `sessionTitle` 降级 / 旧 `generate` 形态不注册)、参考窗口 (无提交回退、只取最近一次 `git commit` 之后、再次提交推进、提交后无新消息回退、文本提及 `git commit` 不算、按会话隔离、重启重建且只读一次、事件不可读与畸形快照回退、缺 session id)、生成契约 (canonical 标题 / 源消息 seq / 模型、helper 收到的 id / 执行控制键 / 原始请求、每次调用都产出标题)、失败路径 (helper 执行失败原样 reject、`tool-calls` 与 `max-tokens` 终止原因拒绝、无 logger 回落 stderr)。
- 单元锚点: `tests/main.test.ts` 补 5 条 —— `titleFromResponse` 两种终止原因与工具块 / 多文本块 / 空块 / 三星号包裹; `normalizeTitleText` 控制字符与多字节字节边界; `latestCommitSeq` 的事件过滤与非有限 seq; `isUsableTitleLlmHelper` 缺单侧的键面与 `commandOf` 参数细节; `resolveConfig` / `executionConfigOf` / `selectReasoningEffort` 的 0 值与空 `efforts` 边界。存量 16 条断言语义未改。
- 专项: `tests/main.test.ts:553` 是「缺宿主包」条件式 `skip` (4.4 保留类), 探测表达式在用例内算一次; 本机 helper 已安装, 当次触发 0 条。
- 未改 `src`; 包 `README.md` 的「测试」节按本包规划归阶段 4。

## 偏差

无实现偏差。两点记录:

- 测试发现 `src/index.ts:352` 的方向控制符正则 `\u202a-\u202e` 写在字符类之外, 实际只匹配 `U+202A` `-` `U+202E` 三字符字面序列, 并不剥 U+202A..U+202E 区间 (实测 `normalizeTitleText("x\u202ay", …)` 原样返回)。本阶段不动 `src`, 用例只锁控制字符与字节截断, 不把该现状写成期望; 修复留阶段 3。后续: 阶段 3 按「无代码改动」处理, 未修; 阶段 3b 已改为 `[\u202a-\u202e]` 字符类, 并在 `tests/main.test.ts:703` 补 U+202A / U+202B / U+202D / U+202E 四个控制符的剥除用例; `check` / `test` (21 例) 通过.
- 覆盖率报告里剩余的未覆盖行 (`100, 115, 139, 323, 335, 362, 370, 381`) 是 V8 range 与声明行取交集的映射残余 (函数签名续行、模板字符串的 `return [` 行), 对应分支均已由用例走到。

## 测试与证据

四条命令 (分支 `history-cleanup/02-tests-session-title-cutoff`, 提交前实跑):

| 入口 | 结果 |
| --- | --- |
| `pnpm -C session-title-cutoff run check` | 通过, 无输出 (exit 0) |
| `pnpm -C session-title-cutoff run test` | 21 条全过, 21 pass / 0 fail / 0 skipped / 0 todo |
| `pnpm -C session-title-cutoff run test:integration` | 18 条全过, 18 pass / 0 fail / 0 skipped / 0 todo |
| `pnpm -C session-title-cutoff run test:coverage` | 通过, 报告 `tmp/cov-session-title-cutoff/report.json` |

覆盖率 (只统 `src`; 改前 = 只跑单元层, 改后 = 单元加集成):

| 阶段 | 行 | 分支 |
| --- | --- | --- |
| 改前 (单元层) | 94.7% (373/394) | 81.4% (70/86) |
| 改后 (单元 + 集成) | 98.0% (386/394) | 89.2% (91/102) |

集成层贡献 +13 行 / +21 分支; 分支分母由 86 变 102 是两轮 V8 range 合并后多出的 range, 占比口径以百分比为准。分层两轮跑: 单元层 `tmp/cov-session-title-cutoff`, 合并层同目录重跑。

改后每文件表:

| 文件 | 行 | 分支 | 未覆盖行 |
| --- | --- | --- | --- |
| `src/index.ts` | 98.0% (386/394) | 89.2% (91/102) | 100, 115, 139, 323, 335, 362, 370, 381 |

新增 / 删除用例: 新增 `tests/integration/plugin.test.ts` 18 条、`tests/assemble.ts` 1 个装配器、`tests/main.test.ts` 补 5 条; 未删除用例; 未删除夹具。`skip` 计数: 0 (本机 helper 已安装, 条件式 `skip` 未触发)。
