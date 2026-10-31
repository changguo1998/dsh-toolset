# md-logic 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 md-logic 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `md-logic` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

## 现状

- 单元层: `tests/` 下 4 个 `.test.ts` (`edit.test.ts` / `parse.test.ts` / `query.test.ts` / `tool.test.ts`); 阶段 1 末 `pnpm -C md-logic run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 57.3% (1722/3003); 分支 76.3% (438/574).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 无; 按 4.4 复核本包 `skip` / `todo` / 夹具.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C md-logic run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-md-logic && mkdir -p ../tmp/cov-md-logic && NODE_V8_COVERAGE=../tmp/cov-md-logic node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-md-logic tmp/cov-md-logic/report.json
```

- 专项: -.
- 验收: `pnpm -C md-logic run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 md-logic 测试锚定`.

### 代码

阶段 3 补; 本阶段不动 `src` (为可测性必须动时先在「偏差」记原因).

### 包文档

阶段 4 补.

## 实现记录

- 阶段 2 测试锚定（分支 `history-cleanup/02-tests-md-logic`）:
  - 基线: 单元 58 例全通过, 0 skip; `check` 通过; 覆盖率 行 89.4% (1478/1654), 分支 79.5% (387/487).
  - 单元锚点: 新增 18 例 — `tests/render.test.ts` (11 例: 节树计数 / 缩进 / 层数过滤 / hash 后缀 / 80 条截断, 块与链接各类型的后缀与缺省计数, replace 成功的路径与处数, 失败按 code 分派下一步与 details 投影), `tests/tool.test.ts` +3 (edits 十类非法值一律 `edits_invalid` 且不触盘, `section_hash` 大小写 / 引号归一后放行, `resolveExecCwd` 的四种回落), `tests/edit.test.ts` +2 (目录 / 二进制 / 不存在三例 `read_failed` 且字节不变, 目录不可写回写 `write_failed` 且不留临时文件), `tests/parse.test.ts` +1 (frontmatter 的 `maxLines` 上界与空 frontmatter), `tests/query.test.ts` +1 (空筛选数组 / 空子串不过滤, `limit` 截断).
  - 集成层: 新增 `tests/assemble.ts` (假工具面 / 假事件面 / 假服务面 + 临时工作区, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (10 例): `apply` 注册名与契约面、缺工具面 / 日志面的降级、`structure` / `blocks` / `links` 的 canonical 值与 `output.render` 投影、`replace` 成功落盘与 `edits_invalid` / `section_stale` / `content_invalid` / `read_failed` 失败路径、参数校验与相对路径按会话 cwd 解析.
  - 脚本: `package.json` 加 `test:integration` 与 `test:coverage` (命令与其它包同构).
  - 结果: 单元 76 例 + 集成 10 例全通过; 覆盖率 行 95.2% (1574/1654), 分支 88.5% (460/520).
  - 临时文件: 集成用例全部落在 `os.tmpdir()` 并在 `after` 统一删除; 未新增夹具.

## 偏差

- 无 `src` 改动.
- 覆盖率脚本: `report.mjs` 的两个路径参数按仓库根解析, 故 `test:coverage` 里传 `tmp/cov-md-logic` / `tmp/cov-md-logic/report.json`; `NODE_V8_COVERAGE` 由 node 按包目录解析, 仍用 `../tmp/cov-md-logic`. 两者指向同一目录.

## 测试与证据

- 命令结果 (改后, 本机 Node v24.16.0 / pnpm 11.7.0):
  - `pnpm -C md-logic run check`: 通过 (tsc --noEmit, 0 错误).
  - `pnpm -C md-logic run test`: 76 例, pass 76, fail 0, skip 0, 约 141ms.
  - `pnpm -C md-logic run test:integration`: 10 例, pass 10, fail 0, skip 0, 约 107ms.
  - `pnpm -C md-logic run test:coverage`: 86 例全通过, 报告见下.
- 覆盖率改前 / 改后 (同一命令, 只统 `src`):

| 文件 | 行 (改前) | 分支 (改前) | 行 (改后) | 分支 (改后) |
| --- | --- | --- | --- | --- |
| `src/edit.ts` | 89.5% (503/562) | 85.9% (146/170) | 92.9% (522/562) | 88.1% (155/176) |
| `src/index.ts` | 98.3% (57/58) | 0.0% (0/1) | 100.0% (58/58) | 100.0% (3/3) |
| `src/parse.ts` | 90.7% (320/353) | 77.2% (88/114) | 90.9% (321/353) | 78.3% (90/115) |
| `src/query.ts` | 97.8% (132/135) | 93.5% (29/31) | 99.3% (134/135) | 96.9% (31/32) |
| `src/render.ts` | 75.5% (71/94) | 62.5% (30/48) | 100.0% (94/94) | 100.0% (50/50) |
| `src/tools.ts` | 87.4% (395/452) | 76.4% (94/123) | 98.5% (445/452) | 91.0% (131/144) |
| 合计 | 89.4% (1478/1654) | 79.5% (387/487) | 95.2% (1574/1654) | 88.5% (460/520) |

- 分层贡献: 改后只跑单元层为 行 94.2% (1558/1654), 分支 86.6% (440/508); 单元加集成为 行 95.2%, 分支 88.5% — 集成层贡献 16 行 / 20 分支.
- 分支分母 487 → 520 的变化来自集成层多执行到的函数 (V8 `isBlockCoverage` 统计的范围变多), 不是用例凑数; 行分母 1654 不变.
- 阶段 1 记的基线 57.3% (1722/3003) 与本分支实测 89.4% (1478/1654) 不同, 分母差 1349 行, 疑为阶段 1 的测量口径 / 报告器版本差异; 本阶段只做同命令改前改后对比, 不改写阶段 1 记录.
- `skip` / `todo` 计数: 0 / 0; 本包无旧夹具需清理.
- 豁免台账: `file_changed` (读 → rename 之间的外部改动) 无注入点, 无法在 `test` 里稳定复现 — 缺注入点 / 真实竞态只能靠人工; 同签名判定由 `sameSignature` 纯函数用例锁口径; 触发条件为并发外部改写, 交给人工验收. 另: `write_failed` 用例在 root 下自动 skip (chmod 不阻止写), 属"本机缺该能力"类条件跳过.
