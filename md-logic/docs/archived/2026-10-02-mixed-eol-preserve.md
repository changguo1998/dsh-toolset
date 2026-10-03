# 混合换行文件会被整体改写（接取条目：`md-logic/docs/BACKLOG.md`「混合换行文件会被整体改写」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 问题

`edit.ts` 的风格判定是「含 `\r\n` 即全文件 `\r\n`」的**二值口径**（`flavorOf` → `rebuild` 用 `joined.replace(/\n/g, "\r\n")` 整体重写）→ 对**混合 EOL** 文件（部分行 LF、部分行 CRLF）执行 `replace` 后，**未改动行的行尾也被翻转**：diff 出现整片无意义变更。

## 决策

- **D1（三分类）**：`flavorOf` 增 `mixed` 与 `dominant`（多数 EOL；并列取 LF）。`crlf` 字段保留（非混合时语义不变）。
- **D2（混合时逐行保留）**：`rebuild(lines, flavor, original)` —— 混合文件按**前缀 / 后缀对齐**原文行：
  - 前缀与后缀（内容未变的行）→ 使用**原文**该行的 EOL（含末行「无 EOL」）；
  - 中间（被替换 / 新增的行）→ 使用 **dominant** EOL；
  - 非混合文件 → 行为与旧版**逐字节一致**（不回归）。
- **D3（最小改动）**：只动 `flavorOf` / `rebuild` 与一处调用点（传入原文），不碰节树 / 锚点 / 漂移校验逻辑。
- **D4（测试）**：① 混合 fixture（CRLF 主导 + 少量 LF）替换中间节 → 未改动行 EOL 逐字节不变；② 纯 LF / 纯 CRLF 文件 → 与旧实现逐字节一致；③ 新增行用 dominant；④ 反向验证（撤逐行保留 → ① 必红）。
- **D5（文档）**：`md-logic/README.md` 或 `docs/DESIGN.md` 写明 EOL 口径。
- **D6（不做）**：不做全文件 EOL 归一；不新增配置项；不动其它包。

## 计划改动文件清单

- `md-logic/src/edit.ts`、`md-logic/tests/*.test.ts`、`md-logic/docs/DESIGN.md`（或 README）
- `md-logic/docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 实现 D1-D3 + 测试 + 反向验证 + 包与根验证。
1. 交子代理审阅（只读）→ 关闭 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02，父会话直接实现）

- `src/edit.ts`：`flavorOf` 增 **`mixed`** 与 **`dominant`**（多数派 EOL，并列取 LF；`crlf` 字段保留、非混合时语义不变）；新增 `splitWithEols()`（按行切分并记录每行原 EOL，末行无 EOL 记 `""`）与 **`rebuildMixed()`**（前缀 / 后缀对齐原文行：未改动行用原 EOL，仅新增/替换行用 dominant）；`rebuild(lines, flavor, original)` 在 `mixed` 时走 `rebuildMixed`，调用点传入原文。节树 / 锚点 / 漂移校验未动。
- `tests/edit.test.ts`：+2 例（① 混合：CRLF 主导 + 未改动 LF 行 + 末尾替换节 → 前缀逐字节不变、LF 行不被翻 CRLF、替换行用 CRLF；② LF 主导新行用 LF + 纯 LF / 纯 CRLF 与旧版**逐字节一致**）。
- `README.md`：追加「换行（EOL）口径（2026-10-02）」节。

## 测试与证据（2026-10-02）

- `md-logic`：`check` exit 0、`build` exit 0、**47/47 全绿**（原 45 → +2）。
- **反向验证**：把 `if (flavor.mixed)` 恒 false（回退整文件风格）→ **恰 2 例红**（两个新用例）；还原后 `src/edit.ts` sha256 **逐字节一致**（`4fc83f9c…`）→ 47/47。
- 全仓：`npm run check` exit 0（0 error TS）、`npm test` 各包 OK（含 md-logic 47/47、ponytail 5/5）。

## 审阅（子代理 `533c52dc`，结论到关闭后才返回）——**不通过** → 处置

| 审阅发现 | 处置 |
|---|---|
| **P1（行粘连回归）**：前缀分支无条件复用 `origEols[i]`，而「末行无 EOL」时为 `""`，被复用到非末行 → 两行粘连（如 `"# H\r\n## S\nbody"` 替换后得 `bodymore`）；随机 291/5977 组破坏行结构，全在「末行无 EOL」子集 | **已修**：`""` 仅在「i 为输出末行」时可用，否则用 dominant（两处：前缀与后缀分支）；新增**回归用例**（审阅确定性反例）；反向验证：撤守卫 → **恰 1 例红**，还原 sha256 逐字节一致 → 48/48 |
| P2：README 计数 45 → 47（实为 48） | 已更新为 48 |
| P2：条目原文点名的「CR-only（单独 `\r`）」残余未记 | README「换行（EOL）口径」已补**已知残项**两条（CR-only 仍整文件归一；多处相同内容行时 EOL 来源歧义——只影响来源不改字节） |
| P3：混合文件内 stray `\r` 处理 | 同上（记入残项） |
| 漏项③（流程倒置）：改动已提交 `ac55ed2`、追踪文档已归档、BACKLOG 已删，而审阅仍在跑 | **如实记录**：本轮审阅与关并行，属流程执行偏差；修复以新提交跟进（本文件为归档补记），后续条目按「审阅返回后再关闭」执行 |

- 修复提交：见同批次 `fix(md-logic): 混合 EOL 末行无换行不再粘连行（审阅 P1）`。

## 关闭记录

- 条目从 `md-logic/docs/BACKLOG.md` 清理并重编号；追踪文档移入 `md-logic/docs/archived/`。
- 残余：① 前缀 / 后缀对齐是**启发式**（多处相同行导致的错位可能让个别行用 dominant 而非原 EOL —— 只会影响 EOL，不改内容）；② 单独 `\r`（老 Mac 风格）仍按现状归一为 LF（既有行为，未变）；③ 审阅结论待补。
