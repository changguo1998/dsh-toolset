# 术语自动审查插件 term-check（接取条目：docs/BACKLOG.md「术语自动审查插件 `term-check`」）

状态：已关闭　　开启：2026-11-05　　关闭：2026-11-06
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

模型回帖正文里出现「禁止术语」表的旧称时，自动注入更正文字（按表里的「应当使用」），要求模型更正后重发；不误报条件型术语；与 `dev/standard` 的术语表解析同源，不漂移。机制对齐 `symbol-normalizer`（符号规范：回合审查）与 `md-table-check`（只报不改 + `followup` 注入）。

## 调研（来源：本仓代码与文档）

### 1. 术语数据源

- `docs/GLOSSARY.md:41-62` 是「禁止术语」三列表（禁用词 / 应当使用 / 条件与例外），共 24 行；单元格内用 `/` 分隔同一行内的多个旧称。
- 既有解析口径：`dev/standard/rules.mjs:151-181` `loadGlossary(root)` —— 按 `/` 拆旧称、按界面名判 `term.interface`（其余 `term.replace`）、标出条件型术语（`CONDITIONAL_TERMS`：模块 / 工具集 / 收口，`rules.mjs:87`）、行豁免标记（`EXEMPT_MARKERS`：原名 / 旧称 / 历史对照 / 不再使用，`:90`）、已知误配（`FALSE_POSITIVES`：回归 → 夺回归属，`:95`）。
- 现状缺口：该解析只用于**文档静态检查**（`check:docs`），**不覆盖模型回帖正文**；正文误用只在人工阅读时暴露。

### 2. 消费者通道（rule-engine）

- `registerConsumer({id, sources, delivery, dedupeInRecord, decide})`（`rule-engine/src/consumers.ts:41-136`）；`decide` 返回 `{text, summary?}` 或 `null`，注入统一由 rule-engine 按 `delivery` 分组合并（`rule-engine/src/delivery.ts:41-76`）。
- 节点表十个（`rule-engine/src/rules.ts:29`、`engine.ts:13-15`）：`assistant-text` 是**回合结束时**的整回合助手正文（`engine.ts:441`、`:493`），正是本插件要看的文本；边界类节点文本为空。
- `dedupeInRecord` 按注入消息的 `summary` 计数（`consumers.ts:227-236`），防同一条提醒反复注入。
- 先例 `md-table-check`：`src/index.ts:103-133`（结构化类型拿 `ctx.ruleEngine`、缺席只告警不抛错）、`src/checker.ts:141-248`（纯函数判定 + 只报不改文案 + **围栏内跳过**）。本插件照此结构，判定核心换成术语命中。

### 3. 文本清洗（代码段豁免）

- `symbol-normalizer/src/symbols.ts` 的 `maskCodeSpans` 已在回合审查里用于「代码段 / 行内代码内的符号不参与判定」（`src/review.ts:53`）。术语审查面临同类问题（正文里引用的旧称、代码块里的字符串），可复用该函数。
- 跨包依赖在本仓有先例：`md-map/package.json:17` 用 `"@dsh-toolset/md-logic": "link:../md-logic"`。

### 4. 关键约束与风险

- **术语表位置**：插件运行时工作目录是会话 workspace，`docs/GLOSSARY.md` 在仓库内；非本仓项目下该文件不存在 → 需要「读不到就跳过并告警」的降级，或改用随包附带的快照。
- **两处解析会漂移**：`dev/standard` 是 `.mjs`（`node --test` 与 `check:docs` 用），插件是 TS；直接 import 需要迁移或生成中间产物。
- **误报面**：条件型术语（模块 / 工具集 / 收口）与界面旧称带「原名」的对照句必须豁免，否则会把合规写法报成违规。
- **只报不改**：与 `md-table-check` 同理，不改回复正文、不改任何文件。

## 决策

- 决策项 1 = 术语数据源形态（用户 2026-11-05 裁定）: **b** —— 构建期生成 JSON 快照随包发布。理由: 不依赖工作区路径（非本仓项目也能审查），与 `dev/standard` 的 `loadGlossary` 同源; 代价是需生成脚本 + 守成测试（GLOSSARY 变更后要重新生成，测试校验快照与解析结果一致）。
  - a. 运行时读 `docs/GLOSSARY.md`（config 给路径，缺省 `<workspace>/docs/GLOSSARY.md`；读不到则跳过并告警）
  - b. 构建期生成 JSON 快照随包发布（与 `dev/standard` 同源，但需生成脚本与守成测试）
  - c. 抽公共 TS 模块（把 `loadGlossary` 等从 `dev/standard/rules.mjs` 迁出，`check:docs` 与插件共用）
- 决策项 2 = 注入通道（用户 2026-11-05 裁定）: **a** —— rule-engine 消费者 + `followup`，与符号审查共用同一套闸门与去重。
  - a. rule-engine 消费者 + `followup`（同 `md-table-check`，与符号审查同一套闸门与去重）
  - b. 插件自建注入（不经 rule-engine，少一层依赖但要自己实现节流）
- 决策项 3 = 文本清洗与豁免（用户 2026-11-05 裁定）: **不加掩码** —— 代码段与行内代码照常参与命中判定。已知风险（用户接受）: 回复里引用旧称做示例、或在代码 / 引文里出现旧称时会被提示; 缓解靠注入文案写明「若属引用示例可忽略本条」。
  - a. 复用 `symbol-normalizer` 的 `maskCodeSpans`（新增 `link:` 依赖）
  - b. 包内自实现轻量掩码（围栏 + 行内代码，零依赖）
  - c. 不掩码（选定）
  - 配套口径：条件型术语不自动判定、已知误配跳过、`dedupeInRecord` 取 1（同一条提醒每会话只注入一次, 避免引用示例反复触发）
- 决策项 4 = 包名与工具面（用户 2026-11-05 裁定）: **a** —— 定名 `term-check`，不提供模型侧工具，纯后台审查。
  - a. 采纳 `term-check`，不提供模型侧工具，纯后台审查
  - b. 另加只读工具（`term_check`：模型自查一段文本），便于写文档前预检

## 规划（实现计划, 2026-11-05 定稿并复核；**尚未开工**）

### 0. 步骤与验证（每步都可执行、可判定）

| 步骤 | 产物 | 验证命令 | 判据 |
| --- | --- | --- | --- |
| 1 建包骨架 | `package.json` / `cordis.patch.yml` / `tsconfig.json` / `tests/tsconfig.json` | `node -e "const p=require('./term-check/package.json');require('node:fs').accessSync('term-check/'+p.dsh.bundle.patch)"` | 退出码 0（`dsh.bundle.patch` 指向存在的文件）；`check` 从步骤 3 起才有意义（空 `src` 时 tsc 会报无输入） |
| 2 生成快照 | `scripts/gen-glossary.mjs` + `src/glossary.generated.ts` | `pnpm -C term-check run gen:glossary` | stdout 打出 `wrote … (24 rows)`；`grep -c '"from"' src/glossary.generated.ts` 与 GLOSSARY 表行数一致 |
| 3 判定核心 | `src/checker.ts` | `pnpm -C term-check run check` | 类型检查 0 错；`checker.ts` 无 `node:fs` / `node:process` import（纯函数） |
| 4 判定单测 | `tests/checker.test.ts` | `pnpm -C term-check run test` | 测试数 = 计划条数、全绿 |
| 5 接线 | `src/index.ts` | `pnpm -C term-check run test`（`tests/main.test.ts`） | 假 engine 收到的注册项字段与配置一致；缺席 engine 时 stderr 有一条告警 |
| 6 快照守成 | `tests/glossary.test.ts` | `pnpm -C term-check run test` | 改 GLOSSARY 不重跑快照 → 该测试变红（反向验证一次） |
| 7 构建 | `dist/` | `pnpm -C term-check run build` | `dist/src/index.js` 存在；`node -e "import('./dist/src/index.js').then(m=>console.log(Object.keys(m)))"` 打出 `apply` / `name` / `inject` |
| 8 根级接线 | 根 `package.json` / `scripts/*` / `AGENTS.md` / README 双侧 | `pnpm run check:docs` 与 `pnpm run check` | `check:docs` 通过；`pnpm run check` 包含 `pnpm -C term-check` |

### 1. 包结构与文件

```
term-check/
  package.json          # @dsh-toolset/term-check；dsh.bundle.patch = ./cordis.patch.yml
  cordis.patch.yml      # insert: id term-check, 缺省 enabled: true
  tsconfig.json         # 与 md-table-check 同口径（strict + noUncheckedIndexedAccess + verbatimModuleSyntax）
  tests/tsconfig.json
  scripts/gen-glossary.mjs      # 从 docs/GLOSSARY.md 生成快照（import dev/standard/rules.mjs 的 loadGlossary）
  src/glossary.generated.ts     # 生成产物，禁止手改
  src/checker.ts                # 纯函数判定 + 文案（零 IO）
  src/index.ts                  # Config / resolveConfig / apply（注册消费者）
  tests/checker.test.ts
  tests/main.test.ts
  tests/glossary.test.ts        # 快照与实时解析一致性
  README.md
```

已核实：`dev/standard/rules.mjs` 是 ESM 且 `loadGlossary(root)` 已导出（`rules.mjs:151-181`），`.mjs` 生成脚本可直接 `import`；GLOSSARY 表当前 24 行（`docs/GLOSSARY.md:41-62`）。

### 2. 判定核心 `src/checker.ts`（纯函数）

- 输入：`text`（整回合助手正文）、快照行（`GLOSSARY_SNAPSHOT`）、`CheckOptions {maxHits?}`。
- 规则（逐条对齐 `dev/standard` 口径）：
  1. `conditional` 行**整行跳过**（模块 / 工具集 / 收口），不自动判定；
  2. 含豁免标记的行跳过（`原名` / `旧称` / `历史对照` / `不再使用`）；
  3. 已知误配：`回归` 命中且同一行含 `夺回归属` → 跳过该行；
  4. 其余行做**子串命中**（不加掩码, 决策项 3 = 不加掩码；代码段与引文照判）；
  5. 同一旧称每回合只列一次（去重）。
- 输出：`TermHit {line: number; from: string; to: string; note: string; isInterface: boolean}` 列表（受 `maxHits` 截断，缺省 8），以及 `renderFeedback(hits, total)` → `{text, summary}` 或 `null`。
- `summary` 常量 `TERM_FEEDBACK_SUMMARY = "术语提醒"`（供 `dedupeInRecord` 计数）。
- 文案口径（对齐 `md-table-check`）：说明只针对回复正文、按表里「应当使用」更正、更正后完整重发；并写明「若某条属引用示例 / 历史对照可忽略」。

### 3. 接线 `src/index.ts`

- `export const inject = ["ruleEngine"]`；`ctx.ruleEngine` 缺席只写 stderr 告警、不抛错（同 `md-table-check/src/index.ts:114-119`）。
- `registerConsumer({ id: "term-check", sources: ["assistant-text"], delivery: "followup", dedupeInRecord: 1, decide })`；`enabled: false` 时 `decide` 恒返回 `null`（仍注册, 便于运行时开关）。
- Config：`enabled`（缺省 true）/ `sources`（缺省 `["assistant-text"]`）/ `delivery`（缺省 `"followup"`）/ `dedupeInRecord`（缺省 1）/ `maxHits`（缺省 8）。

### 4. 快照生成与守成

- `scripts/gen-glossary.mjs`：`import { loadGlossary } from "../../dev/standard/rules.mjs"`（同一份解析, 不另写一套），写 `src/glossary.generated.ts`（含 `GlossaryRow` 类型与 `GLOSSARY_SNAPSHOT`）。
- `package.json` 加 `gen:glossary` 脚本；`tests/glossary.test.ts` 实时 `loadGlossary(仓库根)` 与快照逐项比对（`from` / `to` / `note` / `conditional` / `isInterface`），不一致即红（GLOSSARY 改动后忘重跑会被抓住）。

### 5. 测试清单

| 用例 | 断言 |
| --- | --- |
| 命中界面旧称（如「活动区」） | 反馈含「回合区」、行号正确 |
| 命中「决策点」 | 反馈含「决策项」 |
| 「模块」「工具集」「收口」 | 零注入（条件型跳过） |
| 「回归」+「夺回归属」同句 | 零注入；单说「回归」 | 注入并要求按语境选「退化 / 守成测试」 |
| 含「原名」的历史对照句 | 零注入 |
| 代码块内出现旧称 | **照判**（不加掩码, 决策项 3），断言确实注入 |
| 无命中 / `enabled: false` | 返回 null |
| 命中数 > `maxHits` | 列出前 N 条 + 「另有 K 处未列出」 |
| 注册项 | `id` / `sources` / `delivery` / `dedupeInRecord` 与配置一致；`ctx.ruleEngine` 缺席 | 只告警、返回空 dispose |
| 快照一致性 | 与 `loadGlossary` 逐项相等 |

### 6. 根级接线（9 处, 与既有新包接线同款）

1. 根 `package.json`：`check` / `build` 链追加 `pnpm -C term-check run …`；`pnpm-workspace.yaml` 若为显式枚举则追加。
2. `scripts/install.sh`：`canonical_pkgs` 追加 `term-check`。
3. `scripts/test-parallel.sh`：`default_pkgs` 追加 `term-check`。
4. `AGENTS.md`：插件计数 33 → 34、包清单两处枚举、插件描述行、`DESIGN.md` 口径的轻量包清单。
5. 根 `README.md` / `README.zh.md`：包表追加一行（English / 中文同步）、目录树追加一行。
6. `profiles/example/*`：按需追加挂载行（与 `fff` profile 一致）。
7. 本包 `README.md`：职责 / 配置 / 口径（含「不加掩码」的已知风险）/ 与 `dev/standard` 同源说明。
8. 追踪文档：实现记录 + 测试与证据。
9. `docs/BACKLOG.md`：关闭时移除条目（收尾阶段）。

### 7. 验证与顺序

1. 生成快照 → 写 `checker.ts` → 写 `index.ts` → 单测 → `pnpm -C term-check run check`。
2. `pnpm -C term-check run build` → `pnpm -C term-check run test`。
3. 根侧：`pnpm run check:docs` → `pnpm run check`（必要时只跑相关包）→ 人工确认（人工确认后才允许提交）。
4. 真机（可选, 需重启会话）：回帖故意用旧称 → 下一回合收到 `[term-check]` 注入。

### 8. 风险与未决点

- **误报面变大**：决策项 3 = 不加掩码，回复里引用旧称做示例会被提示；已靠「同一提醒每会话只注入一次」（`dedupeInRecord: 1`）+ 文案「可忽略」缓解。实现时若真机噪声明显，回退方案是给 checker 加一个 `maskCode` 开关（缺省关，配置可开）。
- **`落点` 行的「应当使用」是「见『推荐术语』」**，不是具体词 → 文案改为「按语境改用具体说法（存储 / 审计 / 实现 / 投递 / 文档 / 条目）」。
- **长回复命中过多** → `maxHits` 截断 + 汇总行。

计划改动文件清单：

- `docs/BACKLOG.md`（条目状态: 已标进行中；关闭时清理）
- 本追踪文档
- `term-check/`（新包：上述 12 个文件）
- 根 `package.json`、`pnpm-workspace.yaml`、`scripts/install.sh`、`scripts/test-parallel.sh`、`AGENTS.md`、根 `README.md` / `README.zh.md`、`profiles/example/*`

明确不做：

- 不改 `dev/standard` 的文档检查行为（只 import 它的 `loadGlossary`, 不改其代码）
- 不改 `md-table-check` / `symbol-normalizer` 的既有职责
- 无数值化的「术语命中率」统计，不做 TUI 面板
- 不动 `STATUS.md`

## 实现记录

按计划第 0 节的 8 步执行，顺序与判据当时即验：

1. **建包骨架**（`term-check/package.json` / `tsconfig.json` / `cordis.patch.yml`）：`dsh.bundle.patch` 指向的 `cordis.patch.yml` 存在，`insert` 条目 id `term-check`、缺省开启；`check` 脚本 `tsc -p tsconfig.json --noEmit`；`gen:glossary` / `check:glossary` / `test` / `test:coverage` 与既有轻量包同款。`LICENSE` 从 `md-table-check/LICENSE` 复制（`check:docs` 的 `pkg.structure` 要求 `files` 列出的 `LICENSE` 存在）。
2. **快照生成**（`term-check/scripts/gen-glossary.mjs` + `term-check/src/glossary.generated.ts`）：脚本 import `dev/standard/rules.mjs` 的 `loadGlossary`，把行压成 `{from,to,note,isInterface,conditional}` 并在 `/* prettier-ignore */` 数组里逐行写 JSON（格式化不会改动该数组, `--check` 才能逐行比对）；`--check` 与 `--root <目录>` 供守成测试用。首次生成输出 `wrote src/glossary.generated.ts (20 rows)`。
3. **判定核心**（`term-check/src/checker.ts`）：纯函数、零 IO（无 `node:fs` / `node:process`）；`checkTerms` 行内扫描、行外跳过（豁免标记 / 条件型 / 已知误配），同一旧称每回合只记首次；`renderFeedback` 产出文案与 `summary`。上限口径沿用 `md-table-check`（`0` = 不限）。
4. **判定单测**（`term-check/tests/checker.test.ts`）：16 例，覆盖计划 §5 的命中 / 条件型 / 误配 / 豁免 / 代码块照判 / 去重 / 空输入 / 上限 / `maxHits: 0` / 「落点」文案 / 注入措辞。
5. **接线**（`term-check/src/index.ts` + `term-check/tests/main.test.ts`）：`inject = ["ruleEngine"]`，`registerConsumer({id: "term-check", sources: ["assistant-text"], delivery: "followup", dedupeInRecord: 1})`；`enabled: false` 仍注册但 `decide` 恒 `null`；`ctx.ruleEngine` 缺席或注册抛错只写 stderr 告警并返回空 dispose。8 例。
6. **快照守成**（`term-check/tests/glossary.test.ts`）：4 例 —— `--check` 通过、反向验证（临时根里给 GLOSSARY 加一行后 `--check` 退出码 1）、豁免标记 / 已知误配与 `rules.mjs` 同口径、快照行数等于表行数。
7. **构建**：`dist/src/{index,checker,glossary.generated}.js` 与 `.d.ts` 齐全；`import('./dist/src/index.js')` 打出 `apply,inject,name,resolveConfig`。
8. **根级接线**：根 `package.json` 的 `check` / `build` 链各追加 `pnpm -C term-check run …`；`scripts/install.sh` 的 `canonical_pkgs` 与 `scripts/test-parallel.sh` 的 `default_pkgs` 追加 `term-check`（两者同序）；`AGENTS.md`（插件计数 33 → 34、两处包清单、插件描述行、`DESIGN.md` 轻量包清单）；根 `README.md` / `README.zh.md`（组成表一行、目录树一行、两处计数）；本包 `README.md`。

**计数基线**：`dev/standard/index.mjs:119-157` 的 `checkCounts` 把「34 个包 / 33 个插件」写死在判定里，新增包后必须同步（只改数字, 不改判定逻辑）；根 `README`、`AGENTS.md`、`docs/ROADMAP.md`、`docs/WORKFLOW-STANDARD.md`、`md-logic/README.md`、`security-guard/README.md` 的同一口径一并改到 35 / 34，否则 `check:docs` 报红。

## 偏差

| 计划 | 实际 | 原因 |
| --- | --- | --- |
| 快照 24 行（`docs/GLOSSARY.md:41-62`） | 20 行 | 该区间实际是 20 个表格行（41 行是表头、42 是分隔行）；`loadGlossary` 逐行返回，断言以运行结果为准 |
| `tests/tsconfig.json` 单独一份 | 不建 | 与 `escalation-hint` 同款：单份 `tsconfig.json` 的 `include: ["src", "tests"]` 已覆盖 `check` 与 `build`，少一份配置少一处漂移 |
| `pnpm-workspace.yaml` 若为显式枚举则追加 | 不改 | 该文件无 `packages:` 字段（子包各自独立 install + lockfile），无需登记 |
| `profiles/example/*` 按需追加挂载行 | 不改 | 示例 profile 只挂子集（且未挂 `rule-engine`）；本包无 `rule-engine` 时不注册，追加挂载只会多一条无效行 |
| 不改 `dev/standard` 的行为 | 仅改 `checkCounts` 的基线数字 34/33 → 35/34 | 基线是写死的数字，新增包必须同步；术语 / 符号 / 注释路径等判定逻辑未动 |
| — | 额外改 `docs/ROADMAP.md`、`docs/WORKFLOW-STANDARD.md`、`md-logic/README.md`、`security-guard/README.md` 的包数 | `check:docs` 的 `count.packages` / `count.plugins` 要求全仓口径一致 |

实现中修掉的两处自身问题：

- `--check` 首次报 `SyntaxError: Unexpected token ']'` —— 快照数组每行行尾带逗号，整段 `JSON.parse` 不合法；改为逐行 `JSON.parse`（去行尾逗号）。
- `check:docs` 报本包测试与 README 的术语命中（旧称本来就是要命中的对象）；测试改为顶部常量（行尾标「旧称」），README 相关句子补「旧称」措辞，判定逻辑不变。

## 测试与证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（本包） | `pnpm -C term-check run check` | 通过（`tsc --noEmit`，0 错） |
| 单元测试（本包） | `pnpm -C term-check run test` | `tests 28 / pass 28 / fail 0` |
| 快照一致性 | `pnpm -C term-check run check:glossary` | `ok: 快照与 GLOSSARY 一致（20 行）` |
| 反向验证 | 测试内临时根加一行后 `--check` | 退出码 1，stderr `快照与 docs/GLOSSARY.md 不一致` |
| 构建（本包） | `pnpm -C term-check run build` | `dist/src/index.js` 等 6 个产物齐全 |
| 产物导出 | `import('./term-check/dist/src/index.js')` | `apply,inject,name,resolveConfig` |
| 全仓类型检查 | `pnpm run check` | 通过（35 个子包） |
| 文档标准 | `pnpm run check:docs` | `✓ check:docs 通过: 113 篇现行 Markdown / 907 个 .ts, 规则 0 项, 错误 0 / 警告 0` |
| 格式化 | `format <改动文件>` | 无残留改动（`glossary.generated.ts` 因 `prettier-ignore` 保持不变） |

**未验证**：真机注入（需重启会话并让插件进 profile）—— 属可选步骤，见计划 §7 第 4 条；本仓无自动化手段覆盖「宿主 rule-engine 实际注入回模型」这一段。

## 收尾

- `docs/BACKLOG.md` 移除「术语自动审查插件 `term-check`」条目（其余条目不动）。
- 本追踪文档移入 `docs/archived/`。
- 未回写 `docs/STATUS.md`（用户择时更新）。
