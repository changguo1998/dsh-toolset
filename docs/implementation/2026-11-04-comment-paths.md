# 清理 `.ts` 注释里的简写路径与失效路径（接取条目: `docs/BACKLOG.md`「清理 .ts 注释里的简写路径与失效路径」）

状态: 实现　　开启: 2026-11-04
本文件是本任务唯一的追踪文档与文档改动位置; 计划外的文件不改.

## 目标

把现行 `.ts` / `.mts` 注释里 587 处包内简写路径（`src/...` / `tests/...` / `demo/...`）改成从仓库根算起的完整路径, 60 处失效路径改指现存文件或改成非路径措辞; 清零后把 `comment.path-shorthand` / `comment.path-missing` 两条规则从 `warn` 改为 `error`, 让 `pnpm run check:docs` 可当门禁.

## 调研

### 规则实现（`dev/standard/`）

- `index.mjs:241-299`: `pathToken` 只认带扩展名（`ts` / `mts` / `mjs` / `json` / `md` / `yml` / `sh`）且至少一段 `/` 的 token; 跳过 `dist` / `node_modules` / `~` / `://` / 恰为 `x` 或 `X` 的段 / 含 `<` `>` 的串. 头段不在顶层目录且在 `src|tests|demo|bench|scripts` → `comment.path-shorthand`; 头段是顶层目录但 `existsSync` 失败 → `comment.path-missing`. 两条都硬编码 `"warn"`.
- `ts-comments.mjs`: 注释抽取按词法跳过字符串与模板串, 只回注释文本与起始行.
- `README.md:26-29,46`: 规则表标「警告」, 记 588 / 60 存量.

### 计数（2026-11-04 实测）

- shorthand 587 处 / 472 个文件; missing 60 处 / 55 个文件; 去重后 **500 个文件**.
- 两条规则合计警告 647, 即当前 `check:docs` 的警告总数（其它规则为 0）. 条目与 `dev/standard/README.md` 记 588 / 60, 实测 shorthand 587（少 1, 见偏差 1）.
- shorthand 头段分布: `src` 291 / `tests` 291 / `demo` 5; 其中 579 处按「所属包目录」前缀可解析, 8 处需按语义改写（见决策 1）.
- missing 分类: 项目级 `docs/implementation/` → `docs/archived/` 25 处; 包级 `docs/implementation/` → 包 `docs/archived/` 4 处; 包级 `docs/archived/` 6 处; 包内 `docs/` 3 处; 包内 `scripts/` 11 处; 跨包 `src/main.ts` → `src/index.ts` 2 处; 占位 / 已删除文档改写 9 处.

### 按包分布（文件数 / shorthand / missing）

| 包 | 文件 | shorthand | missing |
| --- | --- | --- | --- |
| `TUI` | 254 | 330 | 17 |
| `task-engine` | 33 | 34 | 0 |
| `coagent` | 23 | 25 | 1 |
| `session-channel` | 15 | 24 | 0 |
| `md-map` | 16 | 17 | 6 |
| `herdr-use` | 18 | 20 | 2 |
| `agent-group` | 7 | 15 | 1 |
| `md-logic` | 14 | 15 | 1 |
| `command-template` | 12 | 14 | 1 |
| `goal-contract` | 12 | 13 | 1 |
| `rule-engine` | 10 | 5 | 5 |
| `security-guard` | 7 | 5 | 5 |
| `herdr-integration` | 9 | 9 | 0 |
| `tool-consult` | 6 | 8 | 1 |
| `background-daemon` | 7 | 2 | 5 |
| `context-report` | 7 | 7 | 0 |
| `script-interpreter` | 5 | 6 | 1 |
| `ast-tools` | 5 | 6 | 0 |
| `md-table-check` | 5 | 3 | 3 |
| `output-compress` | 4 | 6 | 0 |
| `code-map` | 4 | 4 | 0 |
| `memory-base` | 4 | 2 | 2 |
| `metric-loop` | 3 | 3 | 1 |
| `auto-approve` | 3 | 1 | 2 |
| `clock-base` | 3 | 2 | 1 |
| `hash-edit` | 2 | 3 | 0 |
| `ponytail` | 2 | 1 | 1 |
| `session-paths` | 2 | 2 | 0 |
| `session-title-cutoff` | 2 | 1 | 1 |
| `symbol-normalizer` | 2 | 2 | 0 |
| `behavior-correction` | 1 | 1 | 0 |
| `preference-analysis` | 1 | 1 | 0 |
| `escalation-hint` | 1 | 0 | 1 |
| `fs-digest` | 1 | 0 | 1 |

### 基线（2026-11-04 实测）

| 命令 | 结果 |
| --- | --- |
| `node dev/standard/index.mjs` | 错误 0 / 警告 647（shorthand 587 + missing 60） |

## 决策

1. **简写路径改写**: 默认在 token 前补「所属包目录」前缀（文件名首段）, 579 处按此规则且前缀后文件存在; 8 处按语义改写:
   - `TUI/src/app/adapter/types/runtime.ts` 的 `src/types.ts` 是**官方 host 路径后缀**, 改成「官方 `packages/interaction/commands` 的 `types.ts`」（同行去掉 `commands/` 的分行）.
   - `TUI/tests/pipeline-frame.test.ts` 的 `tests/pipeline-equivalence.test.ts` 已随旧六段链删除 → 改成「既定分派口径」.
   - `TUI/tests/status-column-equivalence.test.ts` 同 token → `TUI/docs/archived/2026-10-12-status-column-boxes.md`.
   - `TUI/tests/step.test.ts` 同 token → `TUI/docs/archived/2026-10-10-orphan-step-heads.md`.
   - `behavior-correction/tests/main.test.ts` / `md-table-check/tests/main.test.ts` 的 `src/main.ts` → `rule-engine/src/index.ts`（消费者注册面在该包 index）.
   - `herdr-integration/src/index.ts` 头注释 `src/main.ts` → `herdr-integration/src/index.ts`.
   - `tool-consult/src/tool.ts` 的 `src/main.ts`（`buildMatcher`）→ `tool-consult/src/index.ts`.
2. **失效路径改写**: 按「现存文件」定向映射, 不新建文件、不凭猜测补路径:
   - 项目级 `docs/implementation/X` → `docs/archived/X`（25 处, 目标由脚本 `existsSync` 校验）.
   - 包级 `docs/implementation/X` → `<pkg>/docs/archived/X`（4 处）; 包级 `docs/archived/X` → `<pkg>/docs/archived/X`（6 处）.
   - 包内 `docs/*` → `<pkg>/docs/*`（3 处, `DESIGN.md` / `SPEC.md` 指向所属包）.
   - `scripts/*` → `<pkg>/scripts/*`（11 处）.
   - 跨包 `src/main.ts` → `<pkg>/src/index.ts`（2 处）.
   - 占位 / 已删文档改写 9 处: `TUI/src/x.ts` → `TUI/src/<file>.ts`; `docs/PENDING-FIXES.md` 2 处 → 「历史 PENDING-FIXES」; `md-map` 的 `docs/x.md` / `docs/a.md` / `docs/b.md` / `docs/refs.md` 6 处改成不带 `docs/` 前缀的相对示例（保留「根 vs 源目录」语义）.
3. **只改注释**: 用与 `ts-comments.mjs` 同款词法扫描定位注释区间, 只在区间内替换; 替换按 token 边界匹配, 不碰字符串 / 模板串 / 代码. 改完逐文件比较「去注释后的正文」, 必须与改前一致（token 级比较）.
4. **两条规则改错误档**: 两条 `--rule` 与 `--all` 计数为 0 后, 把 `dev/standard/index.mjs` 的 2 处 `"warn"` 改为 `"error"`, 并更新 `dev/standard/README.md` 的规则表与存量说明（「警告」→「错误」, 清零日期）; 规则判定逻辑不动.
5. **范围**: 只处理这两条规则的命中; 不改 Markdown 里的同类失效引用（`TUI/docs/SPEC.md` 等, 不属本规则, 记入遗留）; 不顺手优化其它注释措辞; 不碰 `dist` / `node_modules` / `tmp` 与第三方依赖.
6. **验证门**: `node dev/standard/index.mjs --rule comment.path-shorthand --all` = 0、`--rule comment.path-missing --all` = 0、`pnpm run check:docs` 错误 0 / 警告 0; 全仓 `pnpm run check` / `build` / `test` 退出 0; `format` 改动文件; 逐文件正文对拍通过.
7. **提交粒度**: ~~按 `docs/WORKFLOW-STANDARD.md` §5 逐点询问~~ 用户 2026-11-04 裁定: 按「分批执行」表分 5 批, 每批测试通过后直接提交, 不再逐点请求授权; 关闭收尾作为最后一批.

## 规划

### 步骤

| 步 | 内容 | 目标文件 | 验证 |
| --- | --- | --- | --- |
| 0 | 记录基线（已完成, 见「调研」） | — | 647 警告 |
| 1 | 写一次性改写脚本: 读两条规则的 `--all` 输出, 生成 500 文件的替换清单（默认前缀 + 特殊映射 + 9 处改写）, 逐条 `existsSync` 校验目标 | `tmp/paths-rewrite.mjs`（临时） | 0 unresolved |
| 2 | 只改注释区间应用替换; 逐文件「去注释正文」对拍 | 500 个 `.ts` / `.mts` | 对拍全等; 规则计数 0 |
| 3 | 两条规则 `warn` → `error`; 更新 `dev/standard/README.md` | `dev/standard/index.mjs` / `README.md` | `check:docs` 0 / 0 |
| 4 | 全量验证: `check` / `build` / `test` + `format` + 规则专项 | — | 见决策 6 |
| 5 | 关闭: 条目「完成」并从 BACKLOG 移除, 追踪文档移入 `docs/archived/`, 删临时脚本 | `docs/BACKLOG.md`; 本文档 | git diff 自查 |

### 分批执行（用户 2026-11-04 裁定）

| 批 | 范围 | 文件 | 命中 | 提交前验证 |
| --- | --- | --- | --- | --- |
| B0 | 本规划文档 + BACKLOG 状态 | 2 | — | `check:docs` 通过 |
| B1 | `TUI` | 254 | 347 | `pnpm run check` + `pnpm run test` + 本批规则计数 0 |
| B2 | 集成类 10 包: `task-engine` / `session-channel` / `coagent` / `agent-group` / `herdr-use` / `herdr-integration` / `tool-consult` / `context-report` / `escalation-hint` / `fs-digest` | 120 | 149 | 同上 |
| B3 | 内容与工具类 18 包: `md-map` / `md-logic` / `md-table-check` / `memory-base` / `output-compress` / `code-map` / `script-interpreter` / `ast-tools` / `hash-edit` / `goal-contract` / `command-template` / `ponytail` / `preference-analysis` / `metric-loop` / `clock-base` / `session-paths` / `session-title-cutoff` / `symbol-normalizer` | 98 | 120 | 同上 |
| B4 | 规则与守卫类 5 包: `rule-engine` / `security-guard` / `auto-approve` / `behavior-correction` / `background-daemon` | 28 | 31 | 同上 |
| B5 | 两条规则改错误档 + `dev/standard/README.md`; 关闭条目、归档本文档、删临时脚本 | — | — | 两条规则全局 0 + `check:docs` 0 / 0 + 全仓 check / build / test |

- 每批: 脚本只改该批包的注释区间; 改后逐文件「去注释正文」与 HEAD 对拍; 跑 `pnpm run check` 与 `pnpm run test`; 规则计数只下降该批命中, 其它包不变; 通过后直接提交.
- `format` 每批改动文件; 提交前 `git diff --stat` 核对只含注释与文档.

### 计划改动文件清单

新增:

- `docs/implementation/2026-11-04-comment-paths.md`（本文档）
- `tmp/paths-rewrite.mjs`（一次性脚本, 关闭前删除）

改动:

- 命中 `comment.path-shorthand` / `comment.path-missing` 的 500 个 `.ts` / `.mts` 文件（按包分布见「调研」表; 精确清单以两条规则的 `--all` 输出为准, 实施时落 `tmp/` 并逐条校验）
- `dev/standard/index.mjs`（2 处 severity）
- `dev/standard/README.md`（规则表与存量说明）
- `docs/BACKLOG.md`（条目「进行中」→「完成」, 关闭时移除）

明确不改（出现需求先请示并补进清单）:

- 任何代码 / 字符串 / 模板串; 测试文件里的断言与数据（测试文件只改注释）; 除 `dev/standard/README.md` 的规则表与存量说明外, 不改其它 Markdown 的失效引用（含 `TUI/docs/SPEC.md` 对已删测试的引用, 记入遗留）
- `dev/standard/` 的规则判定逻辑与其它规则严重度; `dist` / `node_modules` / 第三方依赖
- 不新增依赖; 不重排 / 重写整段注释

### 风险与对策

| 风险 | 对策 |
| --- | --- |
| 替换误改字符串或代码 | 词法扫描只替换注释区间; 改后「去注释正文」逐文件 token 对拍, 不一致即中止 |
| 跨包路径前缀配错 | 579 处默认前缀先 `existsSync`; 8 处跨包 / 官方路径逐条人工映射（决策 1） |
| 归档目标猜错 | 全部映射先校验 `existsSync`; 同 basename 多候选或不存在 → 中止并人工裁定 |
| 改错档后仍有残留 | 先两条 `--rule` 与 `--all` 均为 0, 再改 severity; 残留则回滚 severity 并记录 |
| 500 文件 diff 难以审阅 | 只改注释文本, 脚本报告每文件替换数; 提交前用 `git diff --stat` 与抽样 diff 核对, 不夹带格式变化 |

## 用户裁定记录

1. **分批执行 + 直接提交**（2026-11-04）: 把计划改动分成 4 至 5 批, 每批执行完重新跑测试, 确认无问题后直接提交, 再进下一批; 提交不再逐点请求授权. 本任务拆成 B0 至 B5（见「分批执行」), 其中 B5 为关闭收尾.
2. **检查点 1（决策后）**（2026-11-04）: 先选「先停下, 等检查」; 随后用户给出上述分批执行裁定, 并以「需要提交时直接提交」取代逐点授权.

## 实现记录

（待实现阶段补记）

## 偏差

1. **计数差 1**: 条目与 `dev/standard/README.md` 记 shorthand 588 处, 当前实测 587 处; 可能由 2026-11-03 后的界面名称 / 文档改动顺带消掉一处, 未逐条追溯. 本任务按实测 587 清零, README 的存量说明在收尾时改为「已清零」.

## 测试与证据

拆分前基线见「调研」; 清零后的两条规则计数、正文对拍与全仓命令结果待实现完成后补记.

## 收尾

（待关闭阶段补记）
