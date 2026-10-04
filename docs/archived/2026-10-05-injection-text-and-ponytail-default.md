# 注入正文精简 + ponytail 默认开启（接取条目：`docs/BACKLOG.md`「注入正文精简 + ponytail 默认开启」）

状态：关闭　　开启：2026-10-05　　关闭：2026-10-05
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按用户 2026-10-05 指示改三处注入面：

1. `skill-autoload`（rule-engine 基线规则，写在 profile 用户 patch）正文改为 `用 skill 工具加载 i-have-adhd`——去掉「这个 skill，按其规则工作。只需遵守指令，不要额外思考或声明，不要扩写或追问；加载后直接继续原任务，完成后停下等待。」
1. symbol-normalizer 的会话开局符号指南**只保留命令与要求**：去掉标题行「会话开局指南（按此输出，避免回合末返工）：」与各条括注（几何要求、展示层替换说明、无需改写），并**泛化规则在前、具体清单在后**。
1. `ponytail` **默认开启**（含导入即生效），编码行为由阶梯承担——`karpathy-guidelines` 已从默认注入取消（2026-10-05 前一任务）。

## 调研

- **skill-autoload 正文**活在 profile 用户 patch（`~/.dsh/profiles/fff/cordis.patch.yml`，`- id: rule-engine` → `rules[0]`），仓库内侧只有 `TUI/docs/DESIGN.md` 的「供重建」记录 → 两处都要改（配置 + 供重建文本）。运行期 `rule_list` 可验。
- **符号指南正文**由 `symbol-normalizer/src/guide.ts` 的 `buildSymbolGuide(rules)` 生成（白名单与别名映射来自 config，不硬编码）：现为 5 条 + 标题行；`GUIDE_SUMMARY = "符号规范（会话开局指南）"`（notice 呈现用，不注入正文）。
- **指南测试**：`symbol-normalizer/tests/guide.test.ts`（含 `/^\[符号规范\] 会话开局指南/` 锚定、白名单 / 别名条数 / 行内代码包裹断言）、`tests/main.test.ts:146`（注入内容 summary）。改正文口径必须同步断言。
- **ponytail 默认值**：`ponytail/src/main.ts` `resolveConfig()` 的 `enabled: config?.enabled === true`（缺省 false）+ `Config.enabled` 注释；bundle 层 `ponytail/cordis.patch.yml` `enabled: false`；测试 `ponytail/tests/main.test.ts` 首例断言「缺省必须关闭」；文档 `ponytail/README.md`（默认关闭 + config 示例 `# 缺省 false`）、`ponytail/docs/DESIGN.md`（两处）、根 `README.md` / `README.zh.md`（插件表行 + 目录树行，双档同构）。
- **导入面**：`@dsh-toolset/ponytail` 已在 profile `bundles` 与 `scripts/install.sh` 的 `canonical_pkgs`（21 包）内 → 默认开启只需改缺省与 bundle patch，无需再改安装面。
- **过渡态**：上一任务已在 profile patch 加了一行 `- id: ponytail` + `enabled: true`；本任务让缺省即为 true 后该行冗余 → 删掉（配置少一处、状态由插件缺省承载）。

## 决策

（2026-10-05 决策审阅后修订：代码段豁免移到**最后一条**、补一句「其余正文仍须写推荐符号」；`[符号规范]` 定性由「notice 契约」更正为「约定标签」；清单补 `AGENTS.md` 等，见「规划」）

- **符号指南新正文（泛化 → 具体；豁免放最后，避免与变体清单相邻被读成「映射是豁免示例」）**：
  ```
  [符号规范]
  1. 禁止 emoji 与列宽不定 / 带填色的图形字符；不要自造符号。
  2. 状态 / 方向 / 几何类用推荐符号或文字；装饰性强调用文字。
  3. 推荐符号白名单：<recommended>
  4. 下列变体必须改用推荐符：<aliases>
  5. 行内代码与围栏代码块内的符号不参与审查；其余正文仍须写推荐符号。
  ```
  第 3 条保留「推荐符号白名单」字样（`symbol-normalizer/tests/main.test.ts:145` 的断言依赖它）；第 4 条保留**行内代码包裹**（`guide.test.ts` 的 `maskCodeSpans` 断言 + 不包裹会让指南自身命中审查：实测 20 处 remap + 6 处 emoji）。首行保留 `[符号规范]` 标签——它是**约定标识**（与本包 `review.ts` 的反馈前缀同族、便于识别），**不是**被代码解析的契约（`TUI/src/app/index.ts:1534` 直接渲染 notice 串，其中不含该标签）。`GUIDE_SUMMARY` 不动（非注入正文，仅 notice 摘要）。
- **ponytail 缺省**：`enabled: config?.enabled !== false`（缺省 true，**仅显式 `false` 关闭**；非布尔值按开启，注释写明）；bundle patch 写 `enabled: true`；注释与文档同步「默认开启」。理由：用户要求默认开启；karpathy 已取消，双份注入的顾虑消失。
- **profile patch**：删掉上一任务临时加的 ponytail 块（含其 2 行注释——缺省已开）；`skill-autoload` 正文改为 `用 skill 工具加载 i-have-adhd`，并同步 `description`（原「正文未改（2026-10-01 精简版 107 字符）」口径已失真）。
- 不做：不改 `sources` / `delivery` / `dedupeInRecord` 等行为面；不新增配置项；不动 `GUIDE_SUMMARY`；不改 install.sh（已含 ponytail）；**不顺手订正** ponytail 文档里 sources / delivery 的既有漂移（另开 BACKLOG 条目）。

## 规划

任务拆分：

1. profile patch（用户层，不入库）：`skill-autoload` 正文 → `用 skill 工具加载 i-have-adhd` + description 同步；删除临时 ponytail 块（行 + 2 行注释）。
1. `symbol-normalizer/src/guide.ts`：`buildSymbolGuide` 改 5 条新正文；文件头注释同步口径。
1. `symbol-normalizer/tests/guide.test.ts`：首行断言改**严格首行锚**（`split("\n")[0] === "[符号规范]"`）+ 正文**恰 6 行**；顺序断言改**逐行锚编号**；补「不含解释性括注」断言；别名用例改按内容锚（「下列变体必须改用推荐符」）；**保留** `maskCodeSpans` 包裹断言。（决策审阅后修订，见「实现记录」。）
1. `ponytail/src/main.ts`：缺省开启（逻辑 + 注释，写明仅显式 `false` 关闭）。
1. `ponytail/cordis.patch.yml` + `ponytail/tests/main.test.ts`：缺省/显式两种取值断言。
1. 文档同步：`ponytail/README.md`（含 :4、:26 config 示例、:50「建议只开一个（缺省即关闭本插件）」）、`ponytail/docs/DESIGN.md`、根 `README.md` + `README.zh.md`（双档同构：插件表行 + 目录树行）、`TUI/docs/DESIGN.md`（供重建正文 + 107 字符括注 + 「已在 profile 开启」口径）、`AGENTS.md`（包列表行「缺省关闭」→「缺省开启」）。
1. 新问题登记（BACKLOG 追加）：① 注入段数余量为 0（`maxInjectionsPerTurn` 缺省 3 = 现有 3 段，第 4 段被静默丢弃，见 `rule-engine/src/engine.ts`）；② ponytail 文档 sources / delivery 与代码缺省不一致（`README.md:35`、`docs/DESIGN.md:21-22`）。

计划改动文件清单（**除此之外一律不改**）：

- `~/.dsh/profiles/fff/cordis.patch.yml`（用户层配置，不入库）
- `symbol-normalizer/src/guide.ts`
- `symbol-normalizer/tests/guide.test.ts`
- `ponytail/src/main.ts`
- `ponytail/cordis.patch.yml`
- `ponytail/tests/main.test.ts`
- `ponytail/README.md`
- `ponytail/docs/DESIGN.md`
- `README.md`、`README.zh.md`
- `TUI/docs/DESIGN.md`
- `AGENTS.md`（审阅补入：包列表行写 ponytail「缺省关闭」）
- `docs/BACKLOG.md`（条目状态、清理、两条新条目）
- `docs/implementation/2026-10-05-injection-text-and-ponytail-default.md`（本文件）

## 实现记录

- profile patch（不入库）：`skill-autoload` 正文 → `用 skill 工具加载 i-have-adhd`（description 同步留痕）；删除上一任务临时加的 ponytail 块（含 2 行注释）。
- `symbol-normalizer/src/guide.ts`：`buildSymbolGuide` 改 5 条新正文（首行 `[符号规范]`；泛化在前）；文件头与函数注释同步。
- `symbol-normalizer/tests/guide.test.ts`：首行锚定改 `guide.split("\n")[0] === "[符号规范]"`（原 `/m` 不锚首行）+ 正文**恰 6 行**；顺序断言改**逐行锚编号**（`^1\.`…`^5\.`）；别名上限用例改按内容锚（`4. 下列变体必须改用推荐符`）；保留 `maskCodeSpans` 包裹断言。
- `ponytail/src/main.ts`：`resolveConfig().enabled = config?.enabled !== false`（**仅显式 `false` 关闭**；非布尔值按开启）；文件头与 `Config` 注释同步（含 `step-end` 兜底节点口径）。
- `ponytail/cordis.patch.yml`：`enabled: true` + 注释「缺省开启（2026-10-05 起）」。
- `ponytail/tests/main.test.ts`：缺省开启断言（含显式 true/false 两态）+ `apply({ruleEngine})` **不传 config 即注入**的端到端断言。
- 文档同步：`ponytail/README.md`（默认开启、config 示例、关系段）、`ponytail/docs/DESIGN.md`、根 `README.md` + `README.zh.md`（插件表行 + 目录树行，双档同构）、`TUI/docs/DESIGN.md`（供重建正文 + 旧口径括注）、`AGENTS.md`（包列表行）。
- `docs/BACKLOG.md`：本条目标〔进行中〕；追加两条新条目（注入段数余量、ponytail 文档 sources/delivery 漂移）。

收尾审阅（2026-10-05，只读，结论「需修」，两处必修 + 若干测试强度建议）与处置：

1. 〔重要〕`ponytail/src/main.ts` 文件头注释仍写「缺省关闭」+ 失效的 karpathy 理由 → 已改为「缺省开启（2026-10-05 起；仅显式 `enabled: false` 关闭）」，并把 `session-start` 口径补为「另挂 `step-end` 兜底」。
1. 〔次要〕本追踪文档未过 `mdformat` → 收尾统一 `format`（有序列表会被规范化，属预期）。
1. 〔次要〕非布尔 `enabled` 静默按开启的失败方向变化 → 已在代码注释与 `ponytail/README.md` 写明「仅显式 `false` 关闭；其它取值按开启」。
1. 〔次要〕首行锚定带 `/m` 不锚首行、顺序断言不测编号 → 已改严格断言（见实现记录）。
1. 〔提示〕「无解释性括注」是固定串黑名单 → 已补「正文恰 6 行」结构性断言；换说法的解释仍可能漏网，属可接受缺口。
1. 〔提示〕`ponytail/tests` 缺「不传 config 即注入」端到端断言 → 已补。
1. 〔提示〕BACKLOG 条目 3 原举例（同回合 `turn-end`）计数键不成立 → 已改为真实同键路径（同回合 compaction 2 段 + 步末 ponytail 1 段 → `turn-end` 反馈第 4 段被丢）。
1. 〔提示〕第 5 条可注「（含未闭合围栏）」→ 不加：与「不加解释、只留命令与要求」冲突；未闭合围栏会掩到文末属既有性质，记在此处。
1. 〔提示〕历史调研 `docs/ponytail-investigation.md:37` 仍提「本仓已装 `karpathy-guidelines`」→ **不改**（2026-10-02 的调研记录，非现状文档；`docs/archived/` 之外的唯一残留，已知并接受）。同批旧口径（`ponytail/README.md:8/:27/:35`、`ponytail/docs/DESIGN.md:21-22` 的 `sources` / `delivery`）已登记为 BACKLOG 条目 4，本次不顺手改。

## 测试与证据

- `cd symbol-normalizer && npm run check && npm run test` → `tests 39 / pass 39 / fail 0`。
- `cd ponytail && npm run check && npm run test` → `tests 5 / pass 5 / fail 0`。
- 反向（变异）验证：① 指南标题行改回旧文案 + 删第 5 条 → symbol-normalizer `pass 37 / fail 2`；② ponytail 缺省改回 `enabled === true` → `pass 4 / fail 1`；恢复后两者全绿。
- 根 `npm run check` + `npm run build` → 通过；根 `npm run test` → 21 包全 `fail 0`（TUI 1325、task-engine 136、symbol-normalizer 39、ponytail 5，其余与基线一致）。
- dist 核对：`ponytail/dist/src/main.js` 含 `enabled !== false`；`symbol-normalizer/dist/src/guide.js` 为新 5 条。
- 运行期核对（rule-engine 已重读 profile）：`rule_list` 显示 `skill-autoload.text = 用 skill 工具加载 i-have-adhd`、`origin: config`、无运行时覆盖；`maxInjectionsPerTurn = 3`（余量见 BACKLOG 条目 3）。
- 指南自审口径核对（审阅方实测）：掩码代码段后指南自身 0 违规；未掩码则 20 处 remap + 6 处 emoji 命中 —— 与 `review.ts` 判据一致（inline / fenced / 未闭合围栏放行，散文命中）。
- 双档同构核对：`README.md` 与 `README.zh.md` 标题数 8 = 8、行数 156 = 156，两处改动对称。
- 临时文件：`tmp/guide.ts.bak` / `tmp/main.ts.bak`（变异备份）已删除。

## 收尾

- 回写文档：`AGENTS.md`、根 `README.md` + `README.zh.md`、`ponytail/README.md`、`ponytail/docs/DESIGN.md`、`TUI/docs/DESIGN.md`。
- BACKLOG：条目「注入正文精简 + ponytail 默认开启」清理移除；新增条目 3（注入段数余量）与条目 4（ponytail 文档 sources/delivery 漂移）交后续接取。
- 追踪文档：本文件移入 `docs/archived/`。
- 未做（记此备查）：`docs/STATUS.md`（用户择时）；`docs/ponytail-investigation.md`（历史调研）。
- 真机：profile 正文改动已即时生效（本轮注入即 `用 skill 工具加载 i-have-adhd`）；符号指南正文与 ponytail 缺省改动需**重启 `dsh --profile fff`** 后在新会话/压缩注入点才可见（插件在组合期装载）。
