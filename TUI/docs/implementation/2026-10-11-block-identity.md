# 块身份（`index`）多来源不一致等四条同源问题（接取条目：`TUI/docs/BACKLOG.md` 第 22 条）

状态：进行中（②③ 完成，④⑤ 待续）　　开启：2026-10-11　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标（条目验收）

1. 同一逻辑块无论走实时线 / 结算 / 回放 / 缓冲尾巴都只出一条正文框；
1. 两次 `deliverBufferTail` 的辅助行各自成段；
1. `/copy` 不重复文本；
1. 同节两批各自成批（或明确锁定「并成一批」的现状）。

## 子项与状态

| 子项 | 内容 | 状态 |
| --- | --- | --- |
| ① | `index` 三四套来源（实时宿主号 / 结算恒 -1 / `deliverBufferTail` 每次从 0 / 回放按 scope 聚合） | 部分：②③ 修掉其中两处后果，① 本身待 ④ 一起裁 |
| ② | `deliverBufferTail` 的 index 每次调用从 0 起 → 两次调用的辅助行都拿 block 0 → 粘成「辅助甲辅助乙」 | **已修** |
| ③ | `joinedLastTextBySource`（`/copy`）节内不去重 → 拼成「甲乙甲乙」 | **已修** |
| ④ | `toolAt` 收紧后同节**多个工具批仍并成一个** → 需批身份（节内批序号 / 按 callId 分组） | 待续 |
| ⑤ | 两处口径脆点：`applyText` 的续写判据用 `sections.find(...)` 取第一个同 scope 非 standalone 节，而回写目标由 `target()` 的 `findIndex` 决定（不同源）；`pendingOpen` 之后同块的迟到增量另起新节 | 待续 |

## 实现记录

### ②（`TUI/src/app/index.ts`）

- 新增字段 `bufferTailIndex` / `bufferTailScope`；`deliverBufferTail` 取号改为**同一 (turn, step) 内跨调用累加**，scope 变化才归零；循环结束把游标写回。

### ③（`TUI/src/app/layout/pipeline/sections.ts`）

- `joinedLastTextBySource` 拼接前按 `(source, block)` 去重（同块 = 同一逻辑块，只取第一次出现）；
  `block` 缺省的旧交付 / 结算路径保持原样按序拼接。

## 测试与证据

- ③ 用例：`tests/pipeline-panes.test.ts`〈joinedLastTextBySource 同块重复入账不放大〉——
  手造同节四项（甲0 乙1 甲0 乙1）→ 结果 `"甲乙"` ✓。
- ② 的行为由 App 级路径覆盖（`deliverBufferTail` 无独立单测，验收第 2 条待补 App 级帧断言）。
- 全量 `npm test` **1455 / 1455 通过**；`npm run check` 干净；`npm run build` 通过。

## 待续（下一轮）

- ④：给工具批引入节内身份（批序号或按 `callId` 分组），使同节多批各自成批；补帧断言。
- ⑤：`applyText` 的续写判据与 `target()` 同源（都用 `target()` 的定位结果）；`pendingOpen` 后迟到增量并入同节。
- ① 收口：把 `deliverBufferTail` / 回放 / 结算的 index 口径写入 SPEC 或注释，明确「块身份 = 交付 `index`，节内唯一」。
