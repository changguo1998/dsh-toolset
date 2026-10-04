# 宽度表生成器与检入表不同步 / `⟳` 恒按 1 列（接取条目：`TUI/docs/BACKLOG.md`「宽度表生成器与检入表不同步（`⟳` 等符号恒按 1 列）」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `TUI/scripts/gen-width-table.mts`（`SYMBOL_UNCERTAIN_RANGES` 扩展 + 注释）
- `TUI/src/app/layout/eaw-table.ts`（生成物：按生成器重放）
- `TUI/tests/width-probe.test.ts`（符号候选用例：`⟳` 与同块白名单符号）
- `TUI/docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- `TUI/docs/SPEC.md`（**收尾审阅要求回写**：§15.1 里「`⟳` 按恒 1 列处理…见 BACKLOG」的过时口径 + §宽度表的不确定符号块列举；不写会导致删除条目后引用悬空）
- 本追踪文档

## 调研（已核，含反证）

- 生成链：`scripts/eaw-dump.py`（Python `unicodedata` 的 EAW；本机 `python3` 3.12.3 → `unidata_version` **15.0.0**，与检入表头声明的 Unicode 15.0.0 一致）+ Node `\p{Emoji}` / `\p{Emoji_Presentation}`（emoji 侧）→ `gen-width-table.mts` 写 `src/app/layout/eaw-table.ts`。
- **「生成器与检入表漂移 229 行」不成立**：把生成器**原样**重放（未改任何常量）后与检入表比对 = **零 diff**；`format` 后仍为零 diff。故条目记录的 229 行（108 增 / 122 删）在当前状态下**不可复现**（推测为当时中间态或未格式化产物）。
- `⟳`（U+27F3）恒 1 列的确切成因：`SYMBOL_UNCERTAIN_RANGES` 只有 `[0x2600,0x27bf]`（杂项符号 + Dingbats）与 `[0x2b00,0x2bff]`（杂项符号与箭头），而 U+27F3 属**补充箭头 A**（U+27F0–U+27FF），两块都不覆盖；它 EAW=N 且无 emoji 属性 → 既不进 W/F 表也不进「呈现不确定」表 → 静态判 1 列且**永不自校正**（运行期只实测 `WIDTH_UNCERTAIN_RANGES` 内的字符）。
- 同块白名单符号同样受影响：`⟸` U+27F8、`⟹` U+27F9、`⟺` U+27FA。

## 决策

1. **把「数学符号 A + 补充箭头 A」并入符号块**：`SYMBOL_UNCERTAIN_RANGES` 增 `[0x27c0, 0x27ff]`（覆盖 U+27F3 与同块白名单符号）→ 这些字符进入「呈现不确定」表 → 运行期按需实测并按实测覆盖宽度（自校正路径）。
1. **表仍是纯生成物**：不接受手改检入表；验收方式改为**重放零 diff**（改生成器 → 重生成 → 再重放一次仍零 diff）。扩展后重放得到的实际 diff 为 **36 行**（`WIDTH_UNCERTAIN_RANGES` 一张表内的区间边界重排：新增区间把原本按 1 列落表的散点并入连续区间）。
1. **记录数据源依赖**：表的正确性绑定「Python `unicodedata` 的 Unicode 版本」——表头已写版本（15.0.0）；将来升级 Python / Unicode 会再次改变该表，属**预期**（重生成 + 重跑宽度用例即可，无需视为漂移）。
1. **不做**：不改运行期实测机制（`layout/width-table.ts`）；不动 `CONSERVATIVE_RANGES`（那是 A 类 2 列判断，与本次「呈现不确定筛选」是两张表）；不手工微调检入表的区间边界。

## 实现记录（2026-10-04）

- `gen-width-table.mts`：`SYMBOL_UNCERTAIN_RANGES` 增 `[0x27c0, 0x27ff]`，注释写明「含 U+27F3 ⟳ 等项目 UI 符号；U+27F0–U+27FF 不在 (0x2600,0x27bf) 内，漏掉则 ⟳ 恒按 1 列且无自校正」。
- 重生成 + `format` → `TUI/src/app/layout/eaw-table.ts` 变更 36 行（仅 `WIDTH_UNCERTAIN_RANGES` 表；区间数 241 → 242）。
- `width-probe.test.ts`：「实测候选」清单补 `⟳` 与同块白名单 `⟸` / `⟹` / `⟺` 四个符号。

## 测试与证据（2026-10-04）

- `npm run test:tui`：**1319 例全绿**（扩展后全量复跑）；`width-probe.test.ts` 13 例全绿。
- **重放一致性（验收，口径校正）**：生成物与检入表的比对须在 `format` **之后**进行——生成器只负责数组内容，换行密度由 prettier 统一（raw 重放与检入表会有换行差异，数据一致）。
- **重放一致性（验收）**：改完生成器后重跑 `node TUI/scripts/gen-width-table.mts` + `format` → 与本次检入的新表比对 **0 行 diff**（生成物可重放、确定性；相对改动前的旧表则是上述 36 行）。
- 反向验证（脚本式，未留痕）：`git stash push -- TUI/src/app/layout/eaw-table.ts`（回到未扩展的旧表）→ `width-probe` 用例红（`⟳` 被排除在实测候选外）；恢复后 13 例全绿。

## 子代理审阅

（改动面小（一处常量 + 生成物重放 + 用例），决策后与收尾前**合并一轮**；记录见下）
