# goal 状态符号「不触发」加回归断言（接取条目：`symbol-normalizer/docs/BACKLOG.md`「goal 状态符号「不触发」行为加回归断言（不做豁免档）」）

状态：关闭　　开启：2026-10-07　　关闭：2026-10-07
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把「TUI goal 状态行五符号 `▷` `∥` `△` `✓` `⟳` 不触发符号治理」的**现状锁进回归**：新增用例断言零替换 / 零提醒，并带反例（`⚠` `✔` 仍照常替换）；在治理区注释记明这两个区外符号属**有意放行**。不改行为、不改配置面、不扩白名单。

## 调研（2026-10-07，源码 + 既有测试，零新增探针）

1. 五符号的放行**来源不统一**（`src/symbols.ts`）：
   - `▷`（U+25B7）、`△`（U+25B3）、`✓`（U+2713）：在 `DEFAULT_RECOMMENDED`（`:73-109`）内 → 命中白名单放行；
   - `∥`（U+2225）：落在 `0x2190-0x21ff`（箭头）与 `0x2300-0x23ff`（杂项技术符号）**之间**的空档 → 治理区（`GOVERNED_RANGES`，`:17-24`）外，默认放行；
   - `⟳`（U+27F3）：高于框线/几何段上界 `0x27bf`、又低于 `0x2b00` → 治理区外，默认放行。
1. 别名表无这两个符号（`DEFAULT_ALIASES`，`:112+`）→ 不存在「先替换再提醒」的路径。
1. **既有测试零覆盖**（本包内）：grep `∥` / `⟳` 只命中本包 `docs/`，`tests/symbols.test.ts`（513 行）无这两个符号（TUI 侧另有渲染用途的命中，不在本包审查面）→ 当前「不触发」是**未被锁定的现状**：未来扩张 `GOVERNED_RANGES` 或改别名表会无声改变它，且不会有用例变红。
1. 同域对照（既有用例已覆盖，可直接借用为反例素材）：`⚠→△`、`✔→✓` 走别名替换；白名单外 emoji（如 `🚀`）走 `unrecommended`。

## 决策

**D1｜放行来源不统一，要不要「统一」？** → **不统一**：沿用 2026-10-06 用户裁定（不做豁免档 / 不扩白名单）。理由：把 `∥` `⟳` 塞进 `DEFAULT_RECOMMENDED` 会让它们出现在开局注入的「推荐符号」文案里（`src/guide.ts:36`），等于向模型推荐两个非白名单符号；而「不触发」的目标已由治理区边界达成。手段收敛为**只锁行为**。

**D2｜锁定方式：用例 or 配置？** → **用例 + 注释**，两处都加：

- 用例落 `tests/symbols.test.ts`——该文件是 `normalizeSymbols` 行为断言的既有归属地；
- 注释落 `src/symbols.ts` 的 `GOVERNED_RANGES` 文档块——「边界即行为」正说明在这里，且是未来扩张该表时唯一会读到的位置。

**D3｜要不要断言「不进推荐集合」？** → **要**。只断言「不替换 / 不提醒」防不住「有人为省事把 `∥` `⟳` 加进 `DEFAULT_RECOMMENDED`」：那会让 D1 失效（符号泄漏进开局指南），而症状**仍是「不替换」**，用例不会红。故补 `!recommendedSet.has(...)` 与 `aliases[...] === undefined` 两条否定断言。

**D4｜反例取哪些？** → 替换面 `⚠` + `✔`（条目原文点名这两个）、提醒面 `🚀`，三例并列，避免用例退化成「整段文本零触发」的假绿。

## 规划（计划改动文件清单）

1. `symbol-normalizer/tests/symbols.test.ts`：新增一例「goal 状态符号不触发」——五符号零替换 / 零提醒 / 原文原样 + 两条否定断言 + `⚠` / `✔` / `🚀` 反例；插在既有「推荐符号 / 文字 / 常用标点不触发」用例之后（同主题相邻）。
1. `symbol-normalizer/src/symbols.ts`：`GOVERNED_RANGES` 文档块补一句——区外符号天然放行；`∥`（U+2225）与 `⟳`（U+27F3）为**已知有意放行者**（TUI goal 状态行），扩张本表或改别名表时勿无声纳入。
1. `symbol-normalizer/docs/BACKLOG.md`：条目标〔进行中〕→ 关闭时移除。
1. 本追踪文档：建 → 关闭时移入 `docs/archived/`。

**明确不做**：不改 `normalizeSymbols` / `resolveSymbolRules` 行为；不动 `DEFAULT_RECOMMENDED` / `DEFAULT_ALIASES` / `GOVERNED_RANGES` 内容；不改 `README.md` 与 `DESIGN.md`（规范口径未变，本条目只是把既有边界写进回归与注释）；不动 TUI 侧。

## 实现记录

- 2026-10-07：接取条目并标〔进行中〕；建本追踪文档（目标 / 调研 / 决策 / 规划）。
- 决策阶段交子代理审阅（`4f1833eb`）：**无异议**（依据：`npm run test` 39/39 基线全绿 + 临时探针实测治理区归属与两条失效路径）。两条非阻塞建议**均已采纳**：① 反例补 `✔`（条目原文点名）；② 调研第 3 条措辞由「全仓 grep」收窄为「本包内」。
- `tests/symbols.test.ts`：新增用例 `goal 状态符号不触发：白名单放行与治理区外放行并存，且不扩白名单`（插在「推荐符号 / 文字 / 常用标点不触发」之后，+21 行）——五符号合并正文零替换 / 零提醒 / 原文原样；`!recommendedSet.has("∥" | "⟳")`、`aliases["∥" | "⟳"] === undefined` 四条否定断言；`⚠` `✔` `🚀` 反例。
- `src/symbols.ts`：`GOVERNED_RANGES` 文档块补边界说明（区外码点天然放行；`∥` U+2225 与 `⟳` U+27F3 属有意放行；扩张本表或改别名表时勿无声纳入），并指向回归用例（+5 行）。
- 无其他文件改动：TUI 侧、`README.md`、`DESIGN.md`、插件配置面均未动。

## 测试与证据

- `symbol-normalizer` 实测（2026-10-07，本机）：
  - `npm run check` ✓（`tsc --noEmit` 无输出）
  - `npm run test` ✓ **40/40 通过**（基线 39 例 + 本条目 1 例；`fail 0`）
  - `npm run build` ✓
- 反向验证（子代理用 `tmp/` 打补丁副本实测，两路失效都会红）：
  - ① 把 `∥` `⟳` 加进 `DEFAULT_RECOMMENDED` → 运行时仍 `replacedCount=0` / `unrecommended=[]`（症状不变），只有 `!recommendedSet.has(...)` / `aliases === undefined` 断言变红 → 证明 D3 的两条否定断言**必要**；
  - ② 扩张 `GOVERNED_RANGES` 覆盖 U+2225 / U+27F3 → `unrecommended` 变为 `["⟳", "∥"]`（`replacedCount` 仍 0）→「五符号不进 unrecommended」断言变红。
- 子代理独立实测：合并正文 `Goal ▷ ⟳  Goal ∥  Goal △  Goal ✓` → `replacedCount=0`、`unrecommended=[]`、原文原样；反例 `⚠` `✔` 替换 2 处、`🚀` 进 `unrecommended`。
- 人工确认门禁：本条目为纯测试 + 注释，无运行时行为变化；按用户在 goal 中的指示（跳过中间提交确认点、每条目一次收尾提交），以「`check` / `test` / `build` 全绿 + 子代理审阅无异议」作为验证凭据。

## 收尾

- 条目：按完成清理，已从 `symbol-normalizer/docs/BACKLOG.md` 移除；余下两条按编号口径重编为 1（标点）/ 2（Unicode 符号），交叉引用同步。
- 回写：无（`README.md` / `DESIGN.md` 口径未变——规范行为零变化）。
- 本文件移入 `symbol-normalizer/docs/archived/`。
- 遗留项：无。
- 关闭日期：2026-10-07。
