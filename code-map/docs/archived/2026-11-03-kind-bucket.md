# code-map 修 `kindBucket` 对导出符号的分类

> 接取条目: `code-map/docs/BACKLOG.md` #1（2026-11-03 开工）
> 层级: code-map

## 计划改动文件清单

| 文件 | 作用 |
| --- | --- |
| `code-map/src/types.ts` | `CodeMapSymbol` 增可选 `symbolType`（outline 语义 kind） |
| `code-map/src/indexer/scan.ts` | 扫描时保留 `symbolType` |
| `code-map/src/report/builder.ts` | `kindBucket` 优先按 `symbolType` 归一，缺失时退回 `astKind` 词根匹配 |
| `code-map/tests/report.test.ts` | 覆盖导出声明 / 成员 / 空 astKind 的分类 |
| `code-map/tests/integration/plugin.test.ts` | `kindCounts` 快照按新口径更新 |
| `code-map/docs/DESIGN.md` | 报告聚合口径补 `symbolType` 优先 |
| `code-map/docs/BACKLOG.md` | 条目标进行中、关闭移除 |

## 调研

- ast-grep `outline` 每项同时给 `astKind`（语法节点名）与 `symbolType`（语义 kind）。实测 TypeScript 样本:
  - `export class Foo` / `export interface Bar` / `export enum E` / `export type T` / `export function fn` / `export const v` 的 `astKind` 全是 `export_statement`，`symbolType` 分别是 `class` / `interface` / `enum` / `struct` / `function` / `constant`；
  - 成员: `public_field_definition` + `field`、`method_definition` + `method`、`property_signature` + `field`、`property_identifier` + `enumMember`；
  - 非导出 `const local` 是 `variable_declarator` + `constant`；`namespace N` 是 `internal_module` + `module`。
- 旧 `kindBucket` 只按 `astKind` 子串判类: `export_statement`（导出声明）与 `public_field_definition` / `property_signature` / `property_identifier` / 空 `astKind` 全落 `other`，`report.kindCounts` 因此失真。
- `CodeMapSymbol.kind` 被 `scan.test.ts` 断言「含 export」，保留 `astKind` 原义；语义 kind 另加字段，避免改弱断言与对外符号形态。

## 决策

1. **新增 `symbolType` 而非改 `kind`**: `kind` 继续表示 ast-grep 语法节点名（既有测试与排障口径不变），语义分类由 `symbolType` 承担。
2. **映射表**（`SYMBOL_TYPE_BUCKETS`）: class→class、interface→interface、enum/enumMember→enum、struct/type/typeAlias→type、function/method→function、constant/field/variable→variable、module→other；表外走旧 `astKind` 词根匹配。
3. **缺 `symbolType` 时行为不变**: 旧图、旧夹具与第三方构造的 `CodeMapSymbol` 不受影响。

## 实现记录

- `types.ts`: 增 `symbolType?: string`，注释写清来源与缺失语义。
- `scan.ts`: `toCodeMapSymbol` 在 outline 有 `symbolType` 时写入。
- `builder.ts`: `kindBucket(kind, symbolType?)` 先查映射表，未命中再走旧词根匹配；调用点传 `sym.symbolType`。
- 测试: `report.test.ts` 新增 11 行样例（导出 6 种 + 成员 4 种 + 空语义 1 种）断言 `kindCounts`；集成快照按新口径更新。
- 文档: `DESIGN.md` 报告聚合段落补「优先 `symbolType`」。

## 快照（`tmp/kindsample`，13 个符号）

改前:

```json
{ "other": 11, "function": 1, "variable": 1 }
```

改后:

```json
{
  "class": 1,
  "variable": 4,
  "function": 3,
  "interface": 1,
  "enum": 2,
  "type": 1,
  "other": 1
}
```

逐项说明: `Foo` class、`bar` / `qux` field→variable、`baz` / `fn` / `def` function、`Bar` interface、`E` / `A` enum、`T` struct→type、`v` / `local` constant→variable、`N` module→other；剩余 1 个 `other` 即命名空间。

集成夹具（4 文件 / 6 符号）: `{class: 1, function: 3, other: 2}` → `{class: 1, function: 3, variable: 1, other: 1}`（`lexical_declaration` 的常量归 variable，空 `astKind` 仍 other）。

## 测试与证据

- `pnpm -C code-map run check` / `build` 退出 0。
- `pnpm -C code-map run test` 37 例全过（原 36 + 新增 1）。
- `pnpm -C code-map run test:integration` 15 例全过（快照更新后）。
- 全仓 `pnpm run check` / `pnpm run test` / `pnpm run test:e2e` 退出 0。

## 偏差

- 条目只写「`src/report/builder.ts` 与报告用例」，实际需要 `scan.ts` 保留 `symbolType`（builder 无法从 `astKind` 反推导出内层声明）；改动面 +2 文件（`types.ts` / `scan.ts`），属实现必需。
- `field` 归入 `variable` 是分类取舍（也可单列 field 桶）；保持原有 8 个粗类不变，避免报告消费方改口径。
