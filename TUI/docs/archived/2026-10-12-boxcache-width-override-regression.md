# 盒子缓存失效的回归用例（接取条目：TUI/docs/BACKLOG.md「盒子缓存失效的回归用例」）

状态：完成　　开启：2026-10-12　　关闭：2026-10-12
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

锁住「实测宽度覆盖变化 → 盒子缓存失效」这条契约：`boxes.ts` 的 `boxCache`（键 = 节对象身份）
已注册进 `clearLayoutCaches`（提交 `8a53372`），但**没有用例**保证它不被回退掉——一旦注册被删，
症状是「节对象没变、排版宽度变了却一直按旧静态宽度出帧」（真机踩过：一整行符号把边框挤左）。

## 调研

- `boxCache` = `WeakMap<Section, LayoutBox[]>`（`layout/pipeline/boxes.ts:312`），紧随其后
  `registerCacheReset(() => { boxCache = new WeakMap(); })`（`:313-315`）。注释记着：节对象不可变
  → 按身份缓存安全；**例外** = 终端实测宽度覆盖是「带外输入」——节对象没变但排版宽度变了，
  必须整体失效。
- 触发链：`setWidthOverrides(entries)`（`layout/markdown.ts:418`）**仅在新值与既有不同**时
  调 `clearLayoutCaches()`（`:428`）→ `layout/cache.ts:32` 遍历全部注册的 resetter。
  `clearWidthOverrides()`（测试用）同样清缓存。
- 已有宿主文件：`tests/layout-cache.test.ts`（排版缓存等价性 + 合帧语义，已 import
  `clearLayoutCaches` / `setLayoutCacheEnabled`），本用例并入该文件，不新建文件。

## 决策

断言层次取**缓存身份**（不比较帧形状——帧形状还受宽度校正等多因素影响，会把用例变成脆断言）：

1. 同节重复 `buildBoxes(section)` 命中**同一对象**（缓存生效的基线断言）；
2. `setWidthOverrides` 写入**新值**后，`buildBoxes(section)` 返回**新对象**（失效）；
3. `setWidthOverrides` 写入**同值**后仍命中同一对象（不无谓失效——锁住 `if (changed)` 语义）。

红绿验证：临时删掉 `boxes.ts` 的 `registerCacheReset(...)` 注册 → 用例 2 必须变红 → 还原。

## 规划

- 任务 1：在 `tests/layout-cache.test.ts` 加 1 条用例（含上述 3 断言），节对象用现成
  `sectionsFromBuffer` 造（该文件已 import）。
- 任务 2：红绿验证并留证据（摘注册 → 红 → 还原 → 绿）。

### 计划改动文件清单

- `TUI/tests/layout-cache.test.ts` —— 新增用例（不改产品代码）

## 实现记录

提交：`449902d`（仅测试文件，不改产品代码）。

- 用例落在 `tests/layout-cache.test.ts`（已有排版缓存口径的宿主文件；新增 import
  `buildBoxes` / `setWidthOverrides` / `clearWidthOverrides`），节对象用现成 `sectionsFromBuffer`
  造（`{ history: true }`，取 `sections[0] ?? current`）。
- 三断言按决策落地：① 同节重复取盒命中**同一对象**；② `setWidthOverrides([["●", 2]])` 后返回
  **新对象**；③ 同值再写仍命中同一对象。`finally` 里 `clearWidthOverrides()` 清覆盖与缓存，
  避免污染同文件后续用例（该调用本身也会清 `boxCache`）。

## 测试与证据

- 绿：`npm run test:tui -- layout-cache.test.ts` → 11 / 11 通过（该文件原 10 条 + 新 1 条）。
- 红：临时摘掉 `boxes.ts:313-315` 的 `registerCacheReset(...)` 注册 → **只有新用例失败**
  （10 pass / 1 fail，失败点 = 「宽度覆盖变化后盒子缓存必须失效」）→ `git checkout --` 还原 →
  11 / 11 绿。红绿对照证明该用例确实锁住这条契约（删注册即变红）。
- 全量：`npm run test:tui` → **1480 / 1480 通过**（改造前 1479 + 新增 1 条）。

## 收尾

- 追踪文档移入 `TUI/docs/archived/`；BACKLOG 移除本条目（其余条目按惯例重排编号）。
