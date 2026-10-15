# @dsh-toolset/md-table-check

DSH（DeepSeek Harness）进程内插件：检查**助手回复正文**里的 markdown 表格列数是否一致。不一致时经
`rule-engine` 消费者面注入一条汇总提示，要求模型更正后重新回复。**只报不改** —— 不改回复正文、
不改任何文件、不碰 TUI 渲染。

## 为什么需要

TUI 只在「表头行 + 分隔行」单元格数**相等**且分隔行每格形如 `:?-+:?` 时才把整块当表格渲染
（`TUI/src/app/layout/table.ts:141-149`）；不等则整表**退回纯文本**，用户看到的是原始竖线文本
（观感即「排版失败」）。即便成对，数据行多格会被静默忽略、缺格会被补空（`parseTableAt:168-176`），
内容丢格却无人报错。仓内原本没有任何自动检查。

## 行为

- 只检查 `assistant-text` 节点（`turn/end` 时派发的整回合助手正文），**只针对回复正文**。
- 表格候选 = 围栏外「表头行 + 分隔行样」；分隔行**不要求**与表头列数相等（这正是要报的情形）。
- 只检查列数不一致：分隔行 / 数据行逐行与表头列数比对。
- 判定与 TUI 同口径重写（`\|` 转义不切、剥除行首尾空单元格、围栏内行跳过），差异仅上面那条放宽。
- 每条回复**汇总一条**提示：表头行号 + 表头摘录 + 期望列数，以及每个不一致行的行号、角色、实际列数。
- 缺省上限：每条最多列 5 张表、每张最多列 3 行；超出以「另有 N 处不一致未列出。」收尾。

注入正文示例（`summary` 恒为 `表格列数提醒`）：

```text
[md-table-check] 上一条回复正文里的 markdown 表格列数不一致（本提示只针对回复正文，与仓库文件无关）：
- 表 1（表头在第 12 行）：`| 包 | 作用 | 状态 |` 期望 3 列
  - 第 13 行（分隔行）：2 列
  - 第 14 行（数据行）：4 列
请修正这些表格后，把上一条回复完整重发一次；不要修改仓库里的任何文件或文档。
```

## 配置

bundle 契约：`name` / `inject: ["ruleEngine"]` / `Config` / `apply`；`ctx.ruleEngine` 不可用时写 stderr
告警并静默降级（不让宿主启动失败）。缺省**开启**（`cordis.patch.yml` 里 `enabled: true`）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否检查；`false` 时仍注册消费者但 `decide` 恒返回 null |
| `sources` | `["assistant-text"]` | 唤醒节点（整回合助手正文） |
| `delivery` | `"followup"` | 注入路径：作为新回合投递给模型 |
| `dedupeInRecord` | `0` | 按记录去重上限；0 = 不限次（每次出现不一致都注入） |
| `maxTables` | `5` | 每条反馈最多列出几个表格 |
| `maxRowsPerTable` | `3` | 每张表最多列出几行不一致 |

`src/checker.ts` 另外导出纯函数 `checkTables` / `renderFeedback` / `splitCells` / `hasCellPipe` 与
`CheckOptions.headerExcerptLimit`（缺省 60）；判定核心无依赖、无 IO，可被展示层单独复用。

## 边界（明确不做）

- **宽度不足**导致的 TUI 退回（属终端与窗口，非回复缺陷）。
- **伪表格**（有竖线但缺分隔行）识别 —— 正文里带竖线的普通行很常见，误报代价高于收益。
- 自动改写回复正文或任何文件；TUI 侧展示 / 命令面。

## 开发

```sh
npm run check   # 类型检查
npm run build   # 编译到 dist/
npm test        # 三份测试：判定 / 与 TUI 源码互证 / 接线
```

`tests/tuiParity.test.ts` 用动态 `import` 加载 `TUI/src/app/layout/table.ts` 做同口径互证（同一文本在
TUI 退回纯文本，本插件同时报出）；TUI 源码不在时（独立分发场景）该文件的用例自动跳过。

接线：根 `package.json` 的 check/build 链、`scripts/test-parallel.sh`、`scripts/install.sh`
（`canonical_pkgs`）与根 `README.md` / `AGENTS.md` 的包清单；条目与追踪文档见项目级
`docs/BACKLOG.md` 与 `docs/implementation/`。
