# 新插件：检查回复正文中的表格列数是否一致（接取条目：`docs/BACKLOG.md`「新插件：检查回复正文中的表格列数是否一致」）

状态：规划　　开启：2026-10-15　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外文件不改。

## 目标

新增插件 `md-table-check`（`@dsh-toolset/md-table-check`）：在 `assistant-text` 节点检查助手回复正文里的 markdown 表格，表头 / 分隔行 / 数据行逐行比对列数；不一致时经 `rule-engine` 消费者面**注入一条汇总提示**（表头行号 + 表头摘录 + 期望列数 vs 各不一致行实际列数），**要求模型更正后重新回复**。提示**只针对回复正文**（与仓库文件 / 文档无关），插件本身也**只报不改** —— 不自动改写回复正文，不碰 TUI 渲染，也不改任何文件。

## 调研

来源：仓内代码（本 worktree `7aba7ae`）+ `rule-engine` 消费者面源码。

- **TUI 判定口径**（`TUI/src/app/layout/table.ts`）：`isTableStart`（`:141-149`）要求「表头行 + 分隔行」成对且两者单元格数**相等**、分隔行每格匹配 `^:?-+:?$`（`:120`）；不等即整块退回纯文本显示 —— 这就是用户看到的「排版失败」。调用点两处：`TUI/src/app/layout/build-box.ts:700`（**fence 外**才建表，宽度未知时不识别）、`TUI/src/app/layout/pipeline/boxes.ts:299`。
- **切分口径**（`table.ts:72-100` `splitCells`）：`\` 转义吞掉下一个字符（`\|` 不切）、`|` 切分、剥除行首尾空单元格、每格 `trim`；行候选预筛 `hasCellPipe`（`:103-115`）。**数据行容忍**（`parseTableAt:168-176`）：缺格补空、多格忽略 —— 列数不一致不会报错，但内容会丢格 / 串列。
- **围栏**：```` FENCE_RE = /^ {0,3}(```+|~~~+)[ \t]*([\w.+-]*)[ \t]*$/ ````（`TUI/src/app/layout/markdown.ts:775`），闭栅判据 = 同标记前缀（`pipeline/boxes.ts:188-191`、`build-box.ts:696` 的 `inFence` 守卫）。
- **消费者接入面**（`rule-engine/src/types.ts:246-268` `ConsumerRegistration`）：`id` / `sources` / `delivery` / `dedupeInRecord` / `directWrite` / `cooldownTurns` / `cooldownMs` / `decide(context) → { text, summary } | null`；缺省 `sources: ["turn-end"]`、`delivery: "followup"`。
- **挂载节点**（`rule-engine/src/engine.ts:117,555-570`）：`assistant-text` 在 `turn/end` 时以**整回合助手正文缓冲**（多条消息 `\n` 连接）派发一次 —— 与「检查整条回复的表格」需求吻合。
- **现成模板**：`ponytail/src/main.ts`（`inject: ["ruleEngine"]` + `Config`/`resolveConfig` + 防御式告警 + `apply` 返回 disposer）、`symbol-normalizer/src/main.ts`（回合审查消费者 + `FEEDBACK_SUMMARY` 常量 + `decide` 返回 feedback）。
- **新包接线点**（照 ponytail 提交 `20a31fc`）：根 `package.json` 的 check/build 链、`scripts/test-parallel.sh` 的 `default_pkgs`、`scripts/install.sh` 的 `canonical_pkgs`（`scripts/test-install.sh:464-491` 断言三者同序一致）、根 `README.md` / `README.zh.md`（插件表 + 目录树 + 计数）、`AGENTS.md`（清单与计数四处）。
- **互证机制可行性（本 worktree 实测 2026-10-15）**：`node --experimental-transform-types` 下动态 `import(new URL("../../TUI/src/app/layout/table.ts", import.meta.url))` 可用 —— `splitCells` / `isTableStart` 均取到且结果符合预期（`| a | b | c |` → 3 格；`| --- | --- |` 对 3 列表头 → `isTableStart` 为 false），故验收 ② 的「与 TUI 源码互证」不需要新增跨包依赖。
- **工具链约束（实测）**：本 worktree 下 `npm` 缺省写 `~/.npm/_logs` 报 `rofs`，须把缓存指到工作区内（`npm --cache ./tmp/npm-cache …`）。

## 决策

决策项用数字、选项用 abcd，选定项写明字母与理由。

01. **插件名**：a `md-table-guard`（原暂拟）/ b `table-guard` / c `md-table-check` → 选定 **c**（用户 2026-10-15 裁定）：点明「markdown 表格 + 只检查」。
02. **宽度退回是否也算**：a 也算（另报「表格过宽」）/ b 只报列数不一致 → 选定 **b**（用户裁定）：宽度取决于终端与窗口，不是回复内容缺陷，报了会随环境误报。
03. **报出粒度**：a 每个问题表格一条 / b 整条回复汇总一条 → 选定 **b**（用户裁定）：一次注入列全部问题表格，避免多条注入被「同回合注入上限」丢弃。
04. **伪表格（缺分隔行）**：a 顺带识别 / b 不做 → 选定 **b**（用户裁定）：正文里带竖线的普通行很常见，误报代价高于收益，也超出「列数一致性」口径。
05. **切分口径复用**：a 本包独立实现 + 测试与 TUI 源码互证 / b 抽公共模块 → 选定 **a**（用户裁定）：约 30 行纯函数独立落本包（注释互引 `table.ts:72`），插件不引 TUI 内部模块，避免动 TUI 发布面。
06. **真机验证路径**：a 本任务内改本机 profile 指向本 worktree / b 留到合并后由用户执行 → 选定 **b**（用户裁定）：本机 `~/.dsh/profiles/fff` 的 `link:` 指向主仓，改它要越出工作区并重启 dsh。
07. **缺省开关**：a 缺省开启 / b 缺省关闭 → 选定 **a**（agent 判定，依据：纯诊断注入，只在列数不一致时触发，正是需要修的场景；配置 `enabled: false` 可关）。
08. **包文档形态**：a 轻量包（只留 `README.md` + `docs/BACKLOG.md`）/ b 另写 `docs/DESIGN.md` → 选定 **a**（agent 判定，依据 `AGENTS.md` 2026-10-04 口径：单判定函数 + 一个消费者注册，无状态机 / 时序契约，机制变厚再补）。
09. **挂载与投递**：节点 `assistant-text`（内容与 `turn-end` 同源，条目指定）+ `delivery: followup`（照 `symbol-normalizer` 回合审查面）；~~初判 `dedupeInRecord: 1`（防刷屏）~~ → **`dedupeInRecord: 0`**（2026-10-15 用户裁定取代：每次出现不一致都要提示，不因记录里已有旧提示而静默）；不加 `cooldownTurns` / `cooldownMs` —— 检查每回合只在 `assistant-text` 跑一次，且只在真有列数不一致时注入；单回合注入段数仍受 `rule-engine` 的 `maxInjectionsPerTurn`（缺省 3）约束。
10. **提示口径**：a 只说「表格列数不一致」 / b 明确要求**更正后重新回复**，并写明**不要修改仓库里的任何文件 / 文档**、**提示只针对回复正文** → 选定 **b**（2026-10-15 用户裁定）：重发让修正后的正文完整覆盖旧正文（避免只做局部补丁导致上下文里两份不一致的正文并存），写明范围防止模型把「修表格」理解成去改仓库文档。

## 规划

### 1. 任务拆分

1. 判定函数与文案（`src/checker.ts`）：切分 / 候选识别 / 逐行比对 / 汇总渲染。
2. 插件接线（`src/main.ts`）：`name` / `inject` / `Config` / `resolveConfig` / `apply` + disposer。
3. 测试三份：判定单测、与 TUI 源码互证、接线单测。
4. 仓库接线：根清单三处 + 双语 README + `AGENTS.md`。
5. 验证：包内 `check` / `build` / `test` + 根 `check` / `build` / `test` + 接线一致性脚本 + 反向验证。

### 2. 判定口径（`src/checker.ts`）

纯函数、零依赖、无 IO。逐行扫描 `text.split("\n")`：

1. **围栏守卫**：行匹配 ```` FENCE_RE = /^ {0,3}(```+|~~~+)[ \t]*([\w.+-]*)[ \t]*$/ ````（口径同 `TUI/src/app/layout/markdown.ts:775`）→ 开栅；栅内行以同一 marker 前缀开头 → 闭栅；栅内行一律跳过（TUI 只在 fence 外建表）。
2. **表格候选**：fence 外连续两行满足 —— ① 表头行 `splitCells` 非 null 且长度 > 0；② 下一行 `splitCells` 非 null、长度 > 0、**每格**匹配 `^:?-+:?$`（「分隔行样」）。
   - 与 TUI 的**唯一放宽**：TUI 还要求分隔行列数 == 表头列数（`table.ts:147`）才算表格；本检查故意放宽，否则正是要检出的这种不一致永远看不到。
   - 仍要求分隔行每格像分隔格 —— 这是「伪表格不做」（决策 4）的具体边界：带竖线的普通行后跟任意行不会被当表格。
3. **逐行比对**：期望列数 = 表头列数；分隔行与后续数据行逐行比对。数据行收集口径同 `parseTableAt:168-176`：`splitCells` 返回 null 或长度 0 即表结束（无未转义竖线 / 仅 `|` / 空行 / 栅行都终止）。
4. **只收不一致**：该表至少一行列数 ≠ 期望才计入；游标推进到表尾，避免表内行被重复识别成新表。
5. **上限**：结果最多 `maxTables` 个表、每表最多 `maxRowsPerTable` 行，同时记全量计数（`tableTotal` / `mismatchTotal`）供「另有 N 处未列出」文案。

单测覆盖的边界：

- 行首尾空单元格剥除：`| a | b |` 与 `a | b` 同为 2 列（同 `splitCells:97-99`）。
- `\|` 转义不切：`| a \| b | c |` 为 2 列（同 `:78-86`）。
- `| --- | x |` 不是分隔行 → 不构成候选。
- 无竖线文本 / 空文本 / 只有 `|` 的行 → 不报。

### 3. 对外 API（`src/checker.ts` 导出）

```ts
export interface TableLineMismatch {
  line: number;                     // 1 基行号（相对传入文本）
  role: "delim" | "row";            // 分隔行 / 数据行
  actual: number;                   // 实际列数
}
export interface TableColumnIssue {
  headerLine: number;               // 表头行 1 基行号
  headerText: string;               // 表头行原文（渲染时截断）
  expected: number;                 // 期望列数 = 表头列数
  mismatches: TableLineMismatch[];  // 受 maxRowsPerTable 约束
  mismatchTotal: number;            // 该表不一致行总数（全量）
}
export interface CheckOptions {
  maxTables?: number;               // 缺省 5
  maxRowsPerTable?: number;         // 缺省 3
  headerExcerptLimit?: number;      // 缺省 60 字符
}
export interface CheckResult {
  tables: TableColumnIssue[];       // 受 maxTables 约束
  tableTotal: number;               // 问题表格总数（全量）
  lineTotal: number;                // 不一致行总数（全量）
}

export function splitCells(line: string): string[] | null;  // 口径同 table.ts:72
export function hasCellPipe(line: string): boolean;         // 口径同 table.ts:103
export const FEEDBACK_SUMMARY: string;                      // "表格列数提醒"
export function checkTables(text: string, options?: CheckOptions): CheckResult;
export function renderFeedback(
  text: string,
  options?: CheckOptions,
): { text: string; summary: string } | null;                // 无问题 → null
```

### 4. 注入文案（`renderFeedback`）

```text
[md-table-check] 上一条回复正文里的 markdown 表格列数不一致（本提示只针对回复正文，与仓库文件无关）：
- 表 1（表头在第 12 行）：`| 包 | 作用 | 状态 |` 期望 3 列
  - 第 13 行（分隔行）：2 列
  - 第 14 行（数据行）：4 列
  - 第 15 行（数据行）：2 列
另有 N 处不一致未列出。
请修正这些表格后，把上一条回复完整重发一次；不要修改仓库里的任何文件或文档。
```

- 三条硬口径（2026-10-15 用户裁定）：① 明确**要求更正后重新回复**（完整重发修正后的回复正文）；② 明确**不要修改仓库里的任何文件 / 文档**；③ 声明**提示只针对回复正文**。
- 每条回复**汇总一条**（决策 3）；行号相对整回合正文，另配表头摘录作锚点（多条助手消息拼接时行号可能与单条消息对不上）。
- 表头摘录超 `headerExcerptLimit` 截断并加 `…`；`另有 N 处不一致未列出` 仅在 `tableTotal` / `mismatchTotal` 超出上限时出现（无超出则不出现该行）。
- `summary` 恒为 `FEEDBACK_SUMMARY`（即 `source.summary` 元数据，TUI 展示与日志按此识别；`dedupeInRecord` 缺省 0，不做记录去重）。
- 无问题 / 列数一致 / 栅内 / 无竖线 → 返回 null（不注入）。

### 5. 插件接线（`src/main.ts`）

```ts
export const name = "md-table-check";
export const inject = ["ruleEngine"];
export interface Config {
  enabled?: boolean;                            // 缺省 true
  sources?: readonly string[];                   // 缺省 ["assistant-text"]
  delivery?: "steer" | "inject" | "followup";    // 缺省 "followup"
  dedupeInRecord?: number;                       // 缺省 0（不限次：每次不一致都注入）
  maxTables?: number;                            // 缺省 5
  maxRowsPerTable?: number;                      // 缺省 3
}
export function resolveConfig(config?: Config): ResolvedConfig;   // 非法值回退缺省，不抛
export function apply(ctx: unknown, config?: Config): () => void; // 返回注销函数
```

- `ctx.ruleEngine`（或 `ctx.get("ruleEngine")`）缺席 / 无 `registerConsumer` → stderr 告警 `[md-table-check] warn: …` 并返回 no-op（不让宿主启动失败）。
- `decide(context)`：`resolved.enabled` 为假 → null；否则 `renderFeedback(context.text, …)`（无问题自然为 null）。
- `dedupeInRecord` 缺省 **0**（不限次，2026-10-15 用户裁定）：记录里已有旧提示也照常注入；不加 `cooldownTurns` / `cooldownMs` —— 检查每回合只在 `assistant-text` 跑一次，且只在真有列数不一致时注入；单回合注入段数仍受 `rule-engine` 的 `maxInjectionsPerTurn`（缺省 3）约束，本插件每回合最多占 1 段。
- disposer 照 `ponytail/src/main.ts:95` 直接返回 `registerConsumer` 的注销函数（不引入 `ctx.effect` 依赖）。

### 6. 测试用例

`tests/checker.test.ts`（判定，约 14 例）：分隔行少列 / 多列 → 报出且行号与角色正确；数据行多格 / 缺格 → 报出；三行一致 → 不报；`\|` 转义 → 不报；`| a | b |` 与 `a | b` 同判 → 不报；反引号栅与 `~~~` 栅内 → 不报；无竖线文本 → 不报；`| --- | x |` → 不报；两表汇总 → 一条含两表；`maxTables: 1` → 裁剪且「另有」计数正确；`maxRowsPerTable: 1` → 行裁剪 + `mismatchTotal` 全量；前置文本后表头行号正确；`renderFeedback` 无问题 → null、有问题 → 文案含表头摘录 / 期望列数 / 行号，以及三条硬口径的文案守卫（「完整重发」、「不要修改仓库里的任何文件或文档」、「只针对回复正文」）。

`tests/tuiParity.test.ts`（与 TUI 互证，验收 ②；TUI 源码不在时 `skip`）：动态 `import(new URL("../../TUI/src/app/layout/table.ts", import.meta.url))`，断言 —— ① 一组 fixture 行的列数与本包 `splitCells` 逐条一致（含 `\|` 转义 / 首尾空单元格 / 无竖线 null）；② 「同一文本在 TUI 退回纯文本」（`isTableStart(header, delim) === false`）⇔ 本包 `checkTables` 报出；③ 列数一致的两行 → TUI 认表且本包不报。

`tests/main.test.ts`（接线，约 6 例）：注册参数（id / sources / delivery / dedupeInRecord = 0）；`decide` 有问题 → `{ text, summary }`、无问题 → null；`enabled: false` → null；rule-engine 缺席 → 告警不抛；返回的 disposer 被调用；`resolveConfig` 非法值回退缺省。

### 7. 仓库接线（逐文件改点）

| 文件 | 改点 |
|------|------|
| 根 `package.json` | `check` / `build` 链尾加 `npm --prefix md-table-check run check` / `build` |
| `scripts/test-parallel.sh` | `default_pkgs` 尾加 `md-table-check` |
| `scripts/install.sh` | `canonical_pkgs` 尾加 `md-table-check`（与上两者同序，`scripts/test-install.sh:464-491` 校验） |
| `README.md` / `README.zh.md` | 插件表加一行、目录树加一行、计数 20 → 21（双语同构） |
| `AGENTS.md` | 首段插件清单、根命令委托清单、`install.sh` 说明的包数、模块数（20 → 21）、「结构与约定」插件清单、`DESIGN.md` 口径的轻量包枚举（补 `md-table-check`） |
| `docs/BACKLOG.md` | 条目标完成并在收尾清理；§4 规划表行随建包删除 |
| 本追踪文档 | 实现 / 偏差 / 测试与证据 / 收尾各节 |

### 8. 验证与反向验证

1. 包内：`npm install --cache ./tmp/npm-cache`（生成 `package-lock.json`）→ `npm run check` / `build` / `test`。
2. 反向验证：把 `checkTables` 的列数比较短路（恒不报）→ 判定用例必红；还原后比对 sha256 一致。
3. 根：`npm run check`、`npm run build`、`npm test`（21 包）；`sh scripts/test-install.sh`（接线一致性）。
4. 真机：**留残余**（决策 6，合并后由用户执行）——写进「测试与证据」的残余项，不阻塞关闭。
5. 临时文件：`tmp/`（npm 缓存 / 探针脚本）在收尾清理。

### 9. 明确不做

- 宽度不足导致的 TUI 退回（决策 2）；伪表格识别（决策 4）；抽公共模块（决策 5）；真机验证（决策 6）。
- 不自动改写回复正文（条目「只报不改」）；不做 TUI 侧展示 / 命令面；不新增 `docs/DESIGN.md`（决策 8）；不改 `docs/STATUS.md`（用户择时）。

### 计划改动文件清单

新增 `md-table-check/`：`package.json`、`tsconfig.json`、`index.ts`、`cordis.patch.yml`、`.gitignore`、`LICENSE`、`README.md`、`package-lock.json`（`npm install` 生成）、`src/main.ts`、`src/checker.ts`、`tests/checker.test.ts`、`tests/main.test.ts`、`tests/tuiParity.test.ts`、`docs/BACKLOG.md`。

新增 `docs/implementation/2026-10-15-md-table-check.md`（本追踪文档）。

修改：根 `package.json`、`scripts/test-parallel.sh`、`scripts/install.sh`、`README.md`、`README.zh.md`、`AGENTS.md`、`docs/BACKLOG.md`。

## 实现记录

## 偏差

## 测试与证据

## 收尾
