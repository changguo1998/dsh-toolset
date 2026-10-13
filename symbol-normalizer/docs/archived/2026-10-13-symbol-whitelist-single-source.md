# 推荐白名单与审查文案去重，并把 `⇆` 加入白名单（接取条目：`symbol-normalizer/docs/BACKLOG.md`「推荐白名单与审查文案去重，并把 `⇆` 加入白名单」）

状态：关闭　　开启：2026-10-13　　关闭：2026-10-13
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

① 审查反馈文案里的推荐白名单改为**由规则面生成**（消除与 `DEFAULT_RECOMMENDED` 的重复硬编码，避免两处漂移）；② 白名单**扩容加入 `⇆`**（U+21C6，TUI 回合分隔线 / step 头的回合号标记 `hh:mm:ss ⇆N`），此后 `⇆` 不再被判「无推荐替代」；③ 会话开局指南随之包含 `⇆`（指南已由 config 生成，预期自动生效，需实测确认）。

## 调研（2026-10-13，源码 + 既有测试 + 全仓检索）

1. 硬编码点**只有一处**：`src/review.ts:112` 的警示文案 `1）状态/方向/几何类符号用推荐符号（✓ ✗ △ … 〜 …）或文字；`，逐字符与 `src/symbols.ts:78-114` 的 `DEFAULT_RECOMMENDED` 相同；全仓检索 `状态/方向/几何类` 仅命中 `src/review.ts` 与构建产物 `dist/src/review.js`（**无第三处**）。指南侧 `src/guide.ts:29,38` 已是 `rules.recommendedSet` 生成，故本条只修 review 一处。
2. `⇆`（U+21C6 LEFTWARDS ARROW OVER RIGHTWARDS ARROW）落在治理区 `0x2190-0x21ff`（`src/symbols.ts:23`）→ 当前必进 `unrecommended` 并触发 `[符号规范]` 反馈（正是条目的实测现象）。它**不在**别名表：既非双向单线族（`↔`）、亦非双线族（`⇒⇐⇔` → `⟹⟸⟺`），更不是明确不纳入的虚线/波浪族（`⇢ ⇝`）；形状身份 = 「两支单线箭头上下叠置」，与既有各族都是不同形状 → 属**独立单列族**，应入白名单而**不建别名**（与 `◦`、空心三角族同款处理：独立形状各成一族、不互相归一）。
3. 裁定锁核对（`tests/symbols.test.ts:276-284`「goal 状态符号不触发」）：该锁只禁止 `∥`/`⟳` 进推荐集合或别名表，**与 `⇆` 无关**；`∥`（U+2225，治理区外）与 `⟳`（U+27F3 > `0x27bf`）仍天然放行。
4. 测试面：`tests/symbols.test.ts:16` 与 `tests/guide.test.ts:19` 均**遍历 `DEFAULT_RECOMMENDED`** 断言放行 / 出现在指南里 → 加入 `⇆` 后两处自动覆盖（无需改断言）；`tests/review.test.ts` 现有 7 例对警示文案只断言片段（`「⭐」无推荐替代`），**未锚白名单串** → 需补「文案含完整白名单」的断言才有回归护栏。
5. 真机 / 会话证据（条目内 2026-10-10 记录）：`⇆` 出现在正文（非行内代码）即被审查判违规并注入 `[符号规范]` 反馈，原文形如「你使用的符号『⇆』无推荐替代…」；本会话（2026-10-13）系统提示内的符号规范指南与 `DEFAULT_RECOMMENDED` 逐字符一致，佐证指南侧确为单一来源。

## 决策

1. **文案白名单取自哪个源？** (a) 模块级常量 `DEFAULT_RECOMMENDED.join(" ")`；(b) 审查器持有的 `rules.recommendedSet`（内置 + 配置追加）。→ 选定 **(b)**：reviewer 已持有 `rules`，取 `[...rules.recommendedSet].join(" ")` 与 `guide.ts` **同一个源**，配置追加的推荐字符（如 `recommended: ["§"]`）在指南与反馈里一致出现；`recommendedSet` 的插入序为「内置在前、配置追加在后」→ 内置白名单完整串仍是其前缀，验收要求的「文案含 `DEFAULT_RECOMMENDED` 完整串」成立。
2. **生成时机？** (a) `review()` 内每次拼接；(b) 构造器内算一次存私有字段。→ 选定 **(b)**：`review()` 在 `session/event` 同步派发窗口内运行，须廉价（`README.md` §依赖与时序），规则在构造后不变。
3. **`⇆` 在 `DEFAULT_RECOMMENDED` 里的位置？** (a) 紧跟 `↔`（同属双向语义）；(b) 追加在箭头块末（`⟺` 之后，`•` 之前）。→ 选定 **(b)**：`⇆` 不是双向单线族的成员，紧贴 `↔` 会误导为同族；放箭头块末并以注释写明「单列族、不与 `↔`/`⟺` 归一」，与「族代表 + 注释」的既有写法一致。
4. **是否给 `⇆` 建别名？** → **不建**：无同族变体可归一（既无尺寸/填充变体，也不与其它箭头共享形状身份），建别名会把不同形状混作一族。
5. **测试改动范围？** (a) 只补 `⇆` 断言；(b) 补 `⇆` 断言 + 补「文案白名单与规则面同源」断言。→ 选定 **(b)**：本条的第一个目标（去重）没有护栏就会再次漂移；同源断言用「配置追加 `§` 后文案含 `§`」证明取自 rules 而非硬编码。

## 规划

任务拆分：① 改 `src/symbols.ts` 白名单 → ② 改 `src/review.ts` 文案取源 → ③ 补两侧断言 → ④ 回写 README / DESIGN → ⑤ 收尾（BACKLOG 清理 + 归档）。

计划改动文件清单：

| 文件 | 改动 |
|------|------|
| `src/symbols.ts` | `DEFAULT_RECOMMENDED` 追加 `⇆`（含注释：单列族、不归一） |
| `src/review.ts` | 构造器存 `#recommendedText = [...rules.recommendedSet].join(" ")`；警示文案改插值（删硬编码串） |
| `tests/symbols.test.ts` | 断言 `⇆` 已推荐、无别名、`normalizeSymbols` 不改写且不进 `unrecommended` |
| `tests/review.test.ts` | 断言警示文案含完整白名单（含配置追加项）；`⇆` 单用不触发审查 |
| `README.md` | 白名单行加入 `⇆`；规则表补「成对箭头」行；不纳入清单口径不变 |
| `docs/DESIGN.md` | `review.ts` 行补「警示文案取自 rules（不硬编码符号表）」，与 `guide.ts` 行同口径 |
| `docs/BACKLOG.md` | 条目标〔进行中〕→ 关闭时清理移除 |
| `docs/implementation/2026-10-13-symbol-whitelist-single-source.md` | 本追踪文档（关闭后移入 `docs/archived/`） |

明确不做：不改治理区段（`GOVERNED_RANGES` / `TEXTUAL_RANGES`）、不改别名表、不改 `guide.ts`（已同源）、不改审查 / 冷却逻辑、不动 TUI 侧的 `⇆` 渲染形制、不为 `⇆` 建别名、不碰 `∥`/`⟳` 的既有裁定。

## 实现记录

- 2026-10-13：接取条目（`docs/BACKLOG.md` 标题行标〔进行中: 2026-10-13 接取〕、状态行改「进行中」）；建本追踪文档并写「计划改动文件清单」。
- 2026-10-13：`src/symbols.ts` —— `DEFAULT_RECOMMENDED` 于 `⟺` 之后追加 `"⇆"`（行内注释「成对箭头族（U+21C6）：单列族、无同族变体，不与 ↔ / ⟺ 归一」，现 `:104`）；白名单块注释补「家族 E」两行（现 `:75-76`）。
- 2026-10-13：`src/review.ts` —— 新增私有字段 `#recommendedText`（构造器内 `[...options.rules.recommendedSet].join(" ")`，现 `:35-36`、`:42`）；警示文案第 1 条的硬编码白名单串改为插值 `（${this.#recommendedText}）`（现 `:115`），输出串逐字符不变（内置白名单是 `recommendedSet` 的前缀）。
- 2026-10-13：测试 —— `tests/symbols.test.ts` 首例补家族 E 断言（`⇆` 已推荐 + 无别名，现 `:29-35`）、新增〈成对箭头 ⇆〉用例（现 `:371-377`）；`tests/review.test.ts` 导入补 `DEFAULT_RECOMMENDED`，新增〈文案同源〉（现 `:92-104`）与〈`⇆` 不触发〉（现 `:106-112`）两例。
- 2026-10-13：文档 —— `README.md`（白名单行加 `⇆`、「成对箭头」表行、§2 反馈文案同源说明）、`docs/DESIGN.md`（`review.ts` 行补「文案白名单取自 rules、构造时算一次」）。
- 2026-10-13：**反向验证**（断言敏感度，排除恒真）—— 同一段 `"回合分隔线 ⇆3"` 分别喂「白名单含 `⇆`」与「白名单剔除 `⇆`」两套 rules：`unrecommended` 由 `["⇆"]` 变 `[]`，即新断言在改前必红、改后转绿。

## 偏差

- `docs/DESIGN.md` 的 diff 除本次 1 处内容改动外，另有 `## 关键取舍` 有序列表被 `format`（mdformat）由 `1.`×8 规范化为 `1.`-`8.`（9 行）——本仓约定改动文件须过 `format`，属格式化器行为、非本次内容改动，未手工回退。
- 计划清单 8 个文件全部改动，无遗漏、无新增计划外文件。工作区内另有 `TUI/docs/BACKLOG.md` 的改动（相位闪烁条目改〔暂停〕并沉表尾 + 重排注记），那是用户同批次的独立文档指示，不属本任务接取范围，故未计入本清单。
- 条目「期望①」原文写「由 `DEFAULT_RECOMMENDED` 生成」，实现取 `rules.recommendedSet`（内置 + 配置追加，见决策 1）——内置白名单完整串仍是子串，验收断言两种取法都成立；差异仅在「配置追加项也进文案」，为更强的同源口径。

## 测试与证据

- `symbol-normalizer/`：`npm run check` 通过（tsc --noEmit，无输出）；`npm test` → **43 例全绿**（改前 40，新增 3）；`npm run build` 通过。
- `npm run demo`（人工确认路径）输出反馈文案已含 `⇆`：`（✓ ✗ △ → ← ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙ ▶ ◀ ▲ ▼ ▷ ◁ ▽ ⟸ ⟹ ⟺ ⇆ • ◦ ○ ● ◯ ■ □ ◇ ◆ ⓘ 〜 …）`。
- 指南侧（验收③）：`tests/guide.test.ts` 遍历 `DEFAULT_RECOMMENDED` 断言指南含每个白名单字符 → `⇆` 已自动纳入且该例通过（本会话系统提示内的指南文本同步印证）。
- 全仓：根 `npm run check` 通过；根 `npm run test` → 21 包全绿（`TUI 1548`、`security-guard 124`、`task-engine 136`、`symbol-normalizer 43`、其余见运行记录，`fail 0` 全包）。
- 反例护栏：`tests/symbols.test.ts`〈箭头家族〉仍断言 D 族 `⇢` 进 `unrecommended`、`▢` 仍提醒——`⇆` 入白名单未放宽其它符号。

## 收尾

- 回写文档：`README.md`（符号规则表 + §2）、`docs/DESIGN.md`（模块结构行）。
- 追踪文档：本文件移入 `symbol-normalizer/docs/archived/`；`docs/BACKLOG.md` 的已完成条目清理移除（该区恢复「当前无未完成项」）。
- 遗留项：无。未提交（本仓默认不主动 commit）；改动的构建产物 `symbol-normalizer/dist/` 随 `npm run build` 一并更新。
