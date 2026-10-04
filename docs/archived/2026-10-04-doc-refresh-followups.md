# 文档刷新的行为面遗留项（接取条目：6 个模块 `docs/BACKLOG.md` 的对应条目——见下表）

状态：关闭　　开启：2026-10-04　　关闭：2026-10-04
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

处理 2026-10-04「全目录文档与注释刷新」收尾时登记的行为面遗留项（文档刷新只改注释/文档，遇到「用户可见或模型可见字符串 / 模板内容 / 代码行为」与实现不一致时只登记不改）。用户 2026-10-04 选定「全部处理」。

| # | 条目（标题） | 源 BACKLOG | 类型 / 结论 |
|---|--------------|------------|------|
| 1 | 随包模板 `code-review.md` 的 `verify` 步缩进错误 | `command-template/docs/BACKLOG.md` | 模板内容（P2）→ **已修** + 回归用例 |
| 2 | `/collapse` 的命令描述与帮助文案把 on/off 写反 | `TUI/docs/BACKLOG.md` | 用户可见字符串 → **已修** |
| 3 | 工具描述（模型可见文案）与实现口径不一致 | `rule-engine/docs/BACKLOG.md` | 模型可见字符串 → **已修** |
| 4 | `code_map` 工具描述未反映「LSP 缺省不可达」 | `code-map/docs/BACKLOG.md` | 模型可见字符串 → **已修** |
| 5 | `F1` / `F2` / `F3` 悬空引用 | `symbol-normalizer/docs/BACKLOG.md` | 注释 / 文档指路 → **已修** |
| 6 | 同进程并发 `hash_edit` 共用临时文件名 | `hash-edit/docs/BACKLOG.md` | 代码行为（P3）→ **已修**（临时名补唯一后缀）+ 回归用例 |

流程说明：本任务跨模块，故追踪文档与接取记录放项目级 `docs/implementation/`；条目在关闭时从各模块 BACKLOG 移除。

## 决策

- 逐条按「与实现一致」修正文案 / 模板 / 引用；**不改**与实现无关的风格与结构。
- 条目 6 按最小改动修根因：临时文件名补**进程内唯一后缀**（跨进程已有 pid），保持「同目录 tmp + rename」的原子写语义不变。
- 编码侧的两条（1、6）各补一条**回归用例**，并做**反向验证**（临时把缺陷改回去，确认用例变红）。

## 规划

计划改动文件：`command-template/{templates/code-review.md,tests/template.test.ts}`、`TUI/src/app/{commands,index}.ts`、`rule-engine/src/tools.ts`、`code-map/src/index.ts`、`symbol-normalizer/{README.md,docs/DESIGN.md,src/{guide,review,main,symbols}.ts,tests/review.test.ts}`、`hash-edit/{src/fs.ts,tests/fs.test.ts}`，以及 6 个模块 BACKLOG 的条目清理与本追踪文档。

## 实现记录

- 2026-10-04：接取（用户选择「全部处理」）。
- 2026-10-04（条目 1）：`code-review.md` 的 `verify` 步把 `bestOf: 2` / `judge:` 从 `prompt: |` 块标量里提回同级缩进（4 空格），并把被误缩进的收尾 `---` 归位到行首；用包内 `parseTemplate` 实跑核对 → `verify.bestOf = 2`、`verify.judge.prompt` 齐备、prompt 尾部无 `estOf:` / `udge:` / `---` 碎字。补回归用例（扫描随包模板：同级键不得出现在 prompt 块内；并断言 `code-review` 的 verify 步带 bestOf/judge）。
- 2026-10-04（条目 2）：`commands.ts` 命令表与 `index.ts` 的 `/help` 行统一改为「on=紧凑（每条目 1 行 + 行尾省略号）/ off=完整折行」，与 `/collapse` 分支和 `activity-compact` reducer 一致。
- 2026-10-04（条目 3）：`MATCH_SCHEMA.description` 改为「缺省（无有效档位）时：边界类节点（turn-start / turn-end / step-start / step-end / session-start / compaction，文本载荷为空）无条件命中，其余节点永不命中」；`summary` 描述改为「元数据：呈现面用，并作为 `dedupeInRecord` 的计数键」。
- 2026-10-04（条目 4）：`code_map` 描述里的 `callers` 口径改为「宿主 LSP 可用时 findReferences 精确结果 precision=lsp；标准 profile 不挂 LSP 三件套 → 实际恒回落同名候选 precision=structural」。
- 2026-10-04（条目 5）：`symbol-normalizer` 的 6 处 `F1`/`F2`/`F3` 引用改为按标题 / 描述指路（`src/{guide,review,main,symbols}.ts` 注释、`README.md`、`docs/DESIGN.md`、BACKLOG 头部说明，另含测试名里的一处）；`grep -rn "F[123]" symbol-normalizer`（排除 `archived/` 与 `node_modules`）已无残留。
- 2026-10-04（条目 6）：`hash-edit/src/fs.ts` 的临时名由 `.<name>.hashedit-<pid>.tmp` 改为 `.<name>.hashedit-<pid>-<随机后缀>.tmp`；补并发回归用例（同文件 8 路并发锚定写：全部成功、最终内容为某一路的结果、目录无临时文件残留）。

## 测试与证据

- 逐包（改动后）：
  - `npm --prefix command-template test` → **27/27 绿**（原 26 + 新回归用例）；**反向验证**：把缩进错误改回 → `fail 1`（正是新用例），还原后复绿。
  - `npm --prefix hash-edit test` → **53/53 绿**（原 52 + 新并发用例）；**反向验证**：临时改回共用临时名 → 连跑 3 次均 `fail 1`（正是新用例），还原后复绿。
  - `npm --prefix rule-engine test` → 87/87；`npm --prefix code-map test` → 23/23；`npm --prefix symbol-normalizer test` → 39/39；`npm --prefix TUI run test` → 1325/1325。
- 全仓（终态）：`npm run check` → exit 0；`npm run build` → exit 0；`npm run test` → **21 包全绿 / 0 失败**（hash-edit 53、command-template 27，其余同上轮）。
- 条目 1 的解析结论由包内 `parseTemplate` 实跑给出（非人工目测）；条目 6 的并发用例在两个方向都实测过。

## 收尾

- 条目清理：6 条已修条目分别从 `command-template` / `TUI` / `rule-engine` / `symbol-normalizer` / `hash-edit` 模块 BACKLOG 移除（`code-map` 只移除「工具描述」条，保留「`cycles` 不建索引」——那条是行为待定，需用户裁定三选一）。
- 编码侧改动属行为面（模板内容、工具/命令文案、并发临时名），已按仓库要求跑 `check` + `build` + `test`；未 push、未改远端。
- 本追踪文档移入 `docs/archived/2026-10-04-doc-refresh-followups.md`。
- 遗留：`code-map/docs/BACKLOG.md` 的 `cycles` 条目（P3）仍未接取；`docs/STATUS.md` 的旧计数仍由用户择时更新。
