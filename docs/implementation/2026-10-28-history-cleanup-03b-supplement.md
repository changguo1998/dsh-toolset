# 阶段 3 附加: 复核修正 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划　　开启: 2026-11-01　　关闭:
本文件记录 2026-11-01 对阶段 1 至 3 追踪文档与仓库实际的复核结果, 并规划在阶段 4 之前把这些不一致处理完; 总追踪见 `docs/implementation/2026-10-28-history-cleanup.md`, 计划外的文件不改.

## 目标

让阶段 1 至 3 的追踪文档与仓库实际一致, 并修掉阶段 3 关闭后暴露的集成层失败: 集成层三例失败复跑转绿, 补丁轮改动回写到对应文档, 阶段 2 移交项有归口, 状态与日期自洽. 全部在 `main` 完成, 不建 worktree 与分支, 完成后才进阶段 4.

## 现状

以下为 2026-11-01 在本仓实跑与逐份文档对照的结果. 命令: `pnpm run check` 退出 0, `pnpm run test` 退出 0 (34 包单元层), `pnpm run test:integration` 退出 1 (3 例失败).

### 1. 集成层实跑与文档记录不符

| 包 | 失败用例 | 现象与原因 |
| --- | --- | --- |
| `tool-consult` | `tests/integration/plugin.test.ts:261` 「denylist: 只遮 initialTools, reveal 不改变名单」 | 断言揭示后 `restrictCalls` 加 1, 实际未加; 补丁 `54ac908c` 改 `isVisible` 后, 揭示已可见工具不再重挂遮罩 |
| `md-map` | `tests/integration/plugin.test.ts:105` 「装配: 宿主拒绝注册时只告警, apply 不抛, 仍 provide mdMap」 | 断言 `stderr` 1 条, 实际 0; 补丁把 `warn` 从 `info() ?? stderr` 双写改为二选一, 假 logger 有 `info` 时只写 logger |
| `task-engine` | `tests/integration/plugin.test.ts:416` 「effect 注销: 写最终快照, 事件流含 root-created / node-expanded / step-verdict」 | 读快照时 JSON 不完整 (`Unexpected end of JSON input`); 单包连跑 3 次全绿, 根 `pnpm run test:integration` 并行时连跑 2 次都失败, 属并行负载下的时序竞态; 阶段 2 记为既有 flake 并写「重跑通过, 留阶段 3 加固」, 加固未做 |

- 三份包追踪文档「测试与证据」仍写 `tool-consult` 18/18, `md-map` 15/15, `task-engine` 17/17 全绿.
- 阶段 3 与总追踪的「全量 `test` 退出 0」只覆盖单元层, 未跑集成层; 2026-11-01 补丁轮记的「17 个受影响包逐个 `check` + `test` 通过」同样只跑单元层.

### 2. 补丁轮改动未回写文档

| 文档 | 记录 | 实际 |
| --- | --- | --- |
| `docs/implementation/2026-10-28-history-cleanup-tool-consult.md:40` | 「阶段 3 无代码改动, 不建分支」 | `tool-consult/src/index.ts:166` 的 `isVisible` 已按 `maskMode` 改 |
| 同上, 偏差节 | 「本阶段不改 `src`」 | 同上, 补丁 `54ac908c` 已改 |
| `docs/implementation/2026-10-28-history-cleanup-hash-edit.md:79` | 「补守卫属 `src` 改动, 本阶段不动」 | `hash-edit/src/index.ts:377` 已补非对象 `ctx` 守卫, `hash-edit/docs/BACKLOG.md` 条目已关闭 |
| `docs/implementation/2026-10-28-history-cleanup-md-map.md` 偏差节 | 「无」 | `md-map/src/index.ts:102` 已补守卫, `warn` 改为显式分支 |
| `docs/implementation/2026-10-28-history-cleanup-command-template.md:83` | `exclude` 留阶段 4 或后续条目评估 | 补丁 `25fce711` 已删该 `exclude` |
| `docs/implementation/2026-10-28-history-cleanup-03-code.md:61` | 「24 个 `history-cleanup/03-code-*` 分支」 | 实际 25 个, 多 `history-cleanup/03-code-herdr-use-2` |
| `docs/implementation/2026-10-28-history-cleanup-03-code.md:38` | 「进行中: `TUI` 第二批 ...」 | 该批已合并, 记录未更新; 同节多条非时间序 |
| `docs/implementation/2026-10-28-history-cleanup-code-map.md:98` | 「留阶段 6『注释与代码不一致』处理」 | 本任务只有阶段 1 至 5, 第 6 章属阶段 5 |

### 3. 状态与日期

阶段 1 / 2 / 3 与总追踪都写「开启: 2026-10-28　关闭: 2026-10-28」, 但这四份文档的最后修改都在 2026-11-01 的补丁轮; 关闭日期未重定, 也没有「最近修订」字段.

### 4. 移交项没有归口

| 项 | 现状 | 条目 |
| --- | --- | --- |
| `session-title-cutoff/src/index.ts:352` | 方向控制符正则 `\u202a-\u202e` 写在字符类外, 只匹配 `U+202A` `-` `U+202E` 字面序列; 阶段 2 记「留阶段 3」, 该包按无代码改动处理, 未修 | 无 |
| `code-map/src/report/builder.ts:13` | `kindBucket` 不认 `export_statement` 等, 导出符号的 `astKind` 落 `other`; 阶段 2 记「留阶段 3」, 阶段 3 记「交后续条目」 | 无 |
| `herdr-integration` | 实现规划里的拆长文件 / 收拢判断两步未做, 包追踪文档写「留给后续条目」 | 无 |
| `task-engine` | 集成 flake 未加固, 见本文件第 1 节 | 无 |
| `TUI/src/app/adapter/dsh.ts` | 3604 行, 未拆; `TUI/docs/BACKLOG.md` 的 #1 / #2 只覆盖 `index.ts` 与 `state/reducer.ts` | 无 |
| `herdr-use/src/actions.ts` 1083 行, `session-channel/src/alias-words.ts` 1161 行, `TUI/src/main.ts` 1089 行 | 1000 至 1200 行一组未拆, 也未按 5.5 写「为什么不能再分」 | 无记录 |
| `TUI/src/app/layout/pipeline/sections.ts:641` 起 | `delivery.kind === "user"` 7 处未收进 `state.ts` 的谓词; 5.6 点名过该文件 | 部分未做 |

## 规划

### 任务拆分

#### T1 集成层三例

先逐例定位, 再按「哪一侧是错的」裁定并记录理由; 不用重试或放宽断言掩盖.

| 项 | 处置 | 验收 |
| --- | --- | --- |
| T1.1 `tool-consult` | 以「揭示已可见工具是空操作」为准: 用例改为断 `restrictCalls` 不变, 并补一条揭示被挡工具 (`bash`) 的用例, 断遮罩收缩且重挂; 不改代码 | `pnpm -C tool-consult run test` / `test:integration` 全绿 |
| T1.2 `md-map` | 保留补丁的「有 logger 只写 logger」口径, 用例改断 logger 收到告警 (见 `host.logs`) 且 `stderr` 为 0; 无 logger 形态仍断 `stderr` 1 条 | `pnpm -C md-map run test` / `test:integration` 全绿 |
| T1.3 `task-engine` | 只在根并行跑时复现, 单包不出现: 定位装配器写快照与读快照的先后, 等写入落定或改用内存快照, 不加静止等待 | 根 `pnpm run test:integration` 连跑 3 次全绿, 单包 `check` / `test` / `test:integration` 全绿 |

#### T2 补丁轮回写

- 改 `tool-consult` 包追踪文档的 `### 代码` 与「偏差」: 记补丁轮改动的落点、原因与验证.
- 改 `hash-edit` / `md-map` 的「偏差」: 记 `apply` 守卫与日志分支的后续改动, 指向补丁提交.
- 改 `command-template` 的偏差: `exclude` 已在补丁轮删除, 不再「留待后评」.
- 改阶段 3 文档: 分支数 24 改 25, 删第 38 行的「进行中」残句, 实现记录按时间重排或分段.
- 改 `code-map` 包追踪文档: 「阶段 6」改「阶段 5 (第 6 章)」.

#### T3 状态与日期

- 阶段 1 / 2 / 3 与总追踪的标题下加「最近修订: 2026-11-01」, 保留原关闭日期, 由本文件记载 11-01 的补丁轮与复核.
- 阶段 3 文档保持「完成」, 不回改为「进行中」; 其新增的附加工作由本文件承担.

#### T4 移交项归口

| 项 | 处置 |
| --- | --- |
| `session-title-cutoff` 正则 | 修 `src/index.ts:352`, 把 `\u202a-\u202e` 并入字符类, 补一条剥 `U+202B` / `U+202D` 的用例; 行为修复, 单笔提交 |
| `code-map` `kindBucket` | 立 `code-map/docs/BACKLOG.md` 条目: 会改 `report.kindCounts` 的可见输出, 需单独立项与快照, 本阶段不改 |
| `herdr-integration` 两步 | 在包追踪文档补一句「为什么本阶段不做」, 或立条目; 二者选一, 写清后关闭本项 |
| `task-engine` flake | 由 T1.3 解决, 不再另立条目 |
| `TUI/src/app/adapter/dsh.ts` | 在 `TUI/docs/BACKLOG.md` 立条目 (与 #1 的 `index.ts` 拆分分开, 或明说并入 #1) |
| 1000 至 1200 行三文件 | 在各自包追踪文档补「为什么不能再分」一句, 不拆代码 |
| `TUI` `delivery.kind` 7 处 | 立 `TUI/docs/BACKLOG.md` 条目, 写明与 5.6 的差距 (布局层谓词收拢), 不在本阶段改 |

#### T5 门禁复跑与关档

- 全量 `pnpm run check` / `build` / `test` / `test:integration` 退出 0; `pnpm -C TUI run demo:build -- --smoke` 42 条 `SMOKE_PASS`.
- 三例修复包各自的 `check` / `test` / `test:integration` 全绿; 根 `pnpm run test:integration` 连跑 3 次全绿 (T1.3 的竞态只在并行下出现).
- 文档 `format` 后自查 diff; 交叉引用逐条可达 (本文件与总追踪、阶段 3、包追踪互指).
- 本文件补「实现记录」「偏差」「测试与证据」, 状态改「完成」; 总追踪补一行阶段 3b 完成.

### 计划改动文件清单

| 组 | 文件 | 动作 |
| --- | --- | --- |
| 本文件 | `docs/implementation/2026-10-28-history-cleanup-03b-supplement.md` | 新建 (本笔); 实施时补三节并关档 |
| 总追踪 | `docs/implementation/2026-10-28-history-cleanup.md` | 阶段表与执行顺序补 3b; 计划改动文件清单补本节; 实现记录 / 偏差 / 验收补一句 |
| 阶段 3 | `docs/implementation/2026-10-28-history-cleanup-03-code.md` | 分支数改 25, 删「进行中」残句, 记录按时间分段; 末尾指向本文件 |
| 阶段 1 / 2 | `docs/implementation/2026-10-28-history-cleanup-01-standards.md` / `-02-tests.md` | 标题下加「最近修订: 2026-11-01」 |
| 包文档 | `docs/implementation/2026-10-28-history-cleanup-tool-consult.md` / `-hash-edit.md` / `-md-map.md` / `-command-template.md` / `-code-map.md` / `-herdr-integration.md` / `-session-title-cutoff.md` / `-herdr-use.md` / `-session-channel.md` / `-tui.md` / `-task-engine.md` | 按 T2 / T4 回写偏差、代码节、理由与验证 |
| 集成用例 | `tool-consult/tests/integration/plugin.test.ts` / `md-map/tests/integration/plugin.test.ts` / `task-engine/tests/integration/plugin.test.ts` (及各自的 `tests/assemble.ts`, 如定位到装配器) | 按 T1 裁定修断言或修时序 |
| 源码 | `session-title-cutoff/src/index.ts` 与其用例 | 修方向控制符正则 |
| 条目 | `code-map/docs/BACKLOG.md` / `TUI/docs/BACKLOG.md` | 登记 T4 的 3 条 (code-map, dsh.ts, delivery.kind) |

### 提交批次

| 批次 | 内容 | 前置验证 |
| --- | --- | --- |
| C1 | T2 + T3 文档回写与本文件关档前的骨架 | `format` 后自查 diff |
| C2 | T1.1 `tool-consult` 用例 (含包文档) | 该包 `check` / `test` / `test:integration` |
| C3 | T1.2 `md-map` 用例 (含包文档) | 同上 |
| C4 | T1.3 `task-engine` 时序修复 (含包文档) | 根 `pnpm run test:integration` 连跑 3 次 |
| C5 | T4 正则修复 + 三条 BACKLOG 条目 + 三处「为什么不能再分」 | `check` / `test`; 文档自查 |
| C6 | T5 全量复跑与关档 (本文件、总追踪) | 四条命令退出 0 |

### 验证与门禁

- 根 `pnpm run check` / `build` / `test` / `test:integration` 全部退出 0; 当前 `test:integration` 为 1, 是本阶段唯一必须先转绿的硬门禁.
- `pnpm -C TUI run demo:build -- --smoke` 42 条 `SMOKE_PASS`; `smoke:pty` 仍缺 `TOLLGATE_API_KEY`, 记为既有偏差, 不阻塞.
- 覆盖率: 只有 T1.3 或 T4 改到 `src` 时补该包 `test:coverage` 并与包文档原数字同命令对比; 不重跑全量基线.
- 文档: `format <改动文件>`; 交叉引用逐条打开确认; 记录里的提交号全部用 `git cat-file -e` 校验存在.

### 明确不做

- 不拆 `TUI/src/app/adapter/dsh.ts`, `herdr-use/src/actions.ts`, `session-channel/src/alias-words.ts`, `TUI/src/main.ts`; 只立条目或补理由.
- 不改 `code-map` 的 `report.kindCounts` 输出; 只立条目.
- 不改 `TUI` 的 `delivery.kind` 谓词收拢; 只立条目.
- 不重跑全量覆盖率基线, 不改 `docs/STATUS.md` / `docs/host` / 归档, 不 push.
- 不做阶段 4 的包文档六节 / 四节归并, 不碰根 README.

## 实现记录

## 偏差

## 测试与证据
