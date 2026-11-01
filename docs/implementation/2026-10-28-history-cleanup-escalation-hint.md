# escalation-hint 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 escalation-hint 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `escalation-hint` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 无代码改动, 不建分支.

## 现状

- 单元层: `tests/` 下 2 个 `.test.ts` (`judge.test.ts` / `main.test.ts`); 阶段 1 末 `pnpm -C escalation-hint run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 92.1% (255/277); 分支 79.4% (81/102).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C escalation-hint run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-escalation-hint && mkdir -p ../tmp/cov-escalation-hint && NODE_V8_COVERAGE=../tmp/cov-escalation-hint node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-escalation-hint tmp/cov-escalation-hint/report.json
```

- 专项: -.
- 验收: `pnpm -C escalation-hint run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 escalation-hint 测试锚定`.

### 代码

阶段 3 无代码改动, 不建分支. 本包的整理在阶段 4 (包文档) 完成.

### 包文档

阶段 4 补.

## 实现记录

- 基线: `pnpm -C escalation-hint run check` 通过; `pnpm -C escalation-hint run test` 34 条全绿 (80.9 ms); 单元层覆盖率与阶段 1 末一致 (行 92.1%, 分支 79.4%).
- 单元锚点: 沿用 `tests/main.test.ts` (`resolveConfig` 边界、告警分支、无下游决定、`exec` / `result` 缺失) 与 `tests/judge.test.ts` (`resultText` / `resultErrorCode` / `commandOf` / `normalizeCommand`、层 1 优先于层 2、`value` / `sandbox` 非对象、`denied: true` 兜底); 现有断言未改语义.
- 集成层: 新增 `tests/assemble.ts` (装配器, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts`. 装配器给出三个假面: 假事件面 (`ctx.on` 记 `prepend` 选项与监听器, 按注册序注销), 假工具面 (`tools/post-execute` 的 waterfall, `next` 递归走到下一位再落宿主兜底), 假日志面 (`ctx.logger.warn` 记告警, 另留 stderr 捕获兜底). 断言覆盖沙箱拒绝判定 (`DENIAL_MARKER_PREFIX` / `FS_SANDBOX_DENIED` / 层 3 结构化兜底)、`additionalContexts` 注入内容 (role / source / 文案关键词 / 追加保序)、覆盖的工具类 (缺省 `bash` / `pwsh` / `write` / `edit` / `str_replace_editor` 全线命中, 自定义名单整体替换).
- 本包没有工具注册、`output.render` 与服务面, 4.2 里那三项断言面在本包为空, 集成层只覆盖事件消费者注入链路; 也不落盘, 「写临时目录再断言」不适用.
- 脚本: `package.json` 补 `test:integration` 与 `test:coverage` (覆盖率目录 `../tmp/cov-escalation-hint`, 报告落 `tmp/cov-escalation-hint/report.json`), 与 4.2 / 4.3 的命令逐字一致.
- `src` 未改.

## 偏差

无 (未动 `src`).

## 测试与证据

### 命令实跑

| 命令 | 结果 |
| --- | --- |
| `pnpm -C escalation-hint run check` | ✓ 通过 (`tsc -p tsconfig.json --noEmit` 无输出) |
| `pnpm -C escalation-hint run test` | ✓ 50 条全绿, 失败 0, 跳过 0 |
| `pnpm -C escalation-hint run test:integration` | ✓ 17 条全绿, 失败 0, 跳过 0 |
| `pnpm -C escalation-hint run test:coverage` | ✓ 出表, 见下 |

改前单元层: 34 条; 改后: 50 条单元 + 17 条集成 = 67 条. 删除用例 0 条, `skip` / `todo` 均 0 条.

### 覆盖率 (改前 / 改后)

| 文件 | 改前行 | 改后行 | 改前分支 | 改后分支 | 未覆盖行 (改后) |
| --- | --- | --- | --- | --- | --- |
| `escalation-hint/src/index.ts` | 90.3% (112/124) | 98.4% (122/124) | 76.3% (29/38) | 95.6% (43/45) | 73, 102 |
| `escalation-hint/src/judge.ts` | 93.5% (143/153) | 100.0% (153/153) | 81.3% (52/64) | 96.3% (77/80) | - |
| 整包 | 92.1% (255/277) | 99.3% (275/277) | 79.4% (81/102) | 96.0% (120/125) | - |

分支分母随走到的代码路径变多而变大 (38→45、64→80), 百分比按同一轮统计口径比较, 未见下降.

### 覆盖豁免 (按 4.3)

- `src/index.ts` 未覆盖行 73 / 102: 两处是对象字面量的属性键 (`maxHints` 的 `typeof` 判定与 `{ type: "text" }` 的属性值), V8 把它们记成独立的零命中 branch range, 所在行本身已被更大范围覆盖; 报告按「最小跨度的 range」取行归属, 所以显示成未覆盖行, 没有走不到的语句. 剩余分支同理, 是对象字面量与类型断言产生的块范围, 不是可独立到达的分支.

### 新增用例清单

单元层 `tests/main.test.ts` (6 条): `resolveConfig` 的 `maxHints` 取整与非有限值回退; 名单过滤非字符串与空串; `ctx.on` 缺失时告警走 `logger.warn`; `ctx.on` 不返回注销函数时给空操作; 宿主未给下游决定时自建 `accept`; `exec` / `result` 缺失时原样返回.

单元层 `tests/judge.test.ts` (10 条): `resultText` 的四种输入形状; `resultErrorCode` 的 `code` 与 `error.info.code`; `commandOf` 的非法 `arguments`; `normalizeCommand` 的 `/dev/null` 与 `2>&1`; `familyOf` 自定义名单; 层 1 优先于层 2; 嵌套错误码走文件族文案; `value` / `sandbox` 非对象不命中; `denied: true` 无需拒绝文本; 无 `command` / 裸字符串 `stderr`.

集成层 `tests/integration/plugin.test.ts` (17 条): 装配与 `prepend` 及注销; waterfall 先取下游决定; 命令族注入文案; 文件族注入文案; 缺省与自定义工具名单; 同 `callId` 去重; 下游 `additionalContexts` 追加保序; 宿主已提示 / 下游 block / 无判据三种不注入; 无下游决定时自建 `accept`; 层 3 兜底只对命令类; `maxHints` 淘汰最旧; `enabled: false` 不订阅; `ctx.on` 缺失的两种告警路径; `ctx.on` 不返回注销函数; `hintMessage` 的 id 唯一; `resolveConfig` 结果直接喂 `apply`.

### 人工确认

本阶段只补测试、`src` 未改, 无行为需要人工验收; 真机上的注入效果仍按 4.6 留到 `scripts/install.sh --sync` 之后由合并方确认.
