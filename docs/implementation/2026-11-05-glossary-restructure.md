# 术语表重构（接取条目：docs/BACKLOG.md「术语表重构」）

状态：调研 / 决策 / 规划 / 实现 / 测试 / 关闭　　开启：2026-11-05　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

将 `docs/GLOSSARY.md` 重排为「推荐术语」+「禁止术语」双主表（+ 保留「保留」节），
并同步改 `dev/standard` 检查源，使规则解析依赖的表结构与文档呈现一致。

## 调研（来源：既有文档）

- `dev/standard/rules.mjs:151-181`：`loadGlossary` 硬解析 `## 需要替换` 表（第一列禁止 / 第二列应当使用 / 第三列条件与例外），表缺失直接 `throw`；`ruleId` 按 `INTERFACE_NAMES` 判定为 `term.interface`，否则 `term.replace`。
- `dev/standard/rules.mjs:72-81`：`INTERFACE_NAMES` 七个唯一名称硬编码（状态列 / 会话区 / 回合区 / 工具区 / 状态行 / 输入区 / 提示行），已在 rules 内，GLOSSARY 只需「禁止术语」表含界面旧称行即可。
- `dev/standard/rules.mjs:87`：`CONDITIONAL_TERMS = ["模块", "工具集", "收口"]` 条件型不自动判定，逻辑在 rules，与表结构无关。
- `dev/standard/README.md:22-23`：规则描述写「`docs/GLOSSARY.md`「需要替换」表的条件型以外旧称」。
- `dev/standard/index.mjs:165`：`isGlossary = file === "docs/GLOSSARY.md"`（GLOSSARY 自身豁免词面检查），与本任务无关。
- `docs/GLOSSARY.md` 现状四节：场景 → 应当使用 / 界面名称 / 需要替换 / 保留。
- 行数预估：现表 4 节共约 77 行；重排后 3 节约 75 行，增删合计 < 50 行边界附近，按标准流程执行（已在 BACKLOG 登记、建本篇）。

## 决策

- 决策项 1 = 新表结构
  - a. 双主表 + 保留节（推荐 / 禁止 / 保留）
  - b. 双主表外另留独立「界面名称」节（界面旧称两处重复维护）
  - c. 双表 + 改规则节标题与解析（改动面扩到 dev/standard 代码）
  - 选定：a（用户已选「双表 + 改规则」方案中的 a 型结构，即推荐 + 禁止双主表 + 保留节；规则仅改读表名「禁止术语」，不改解析逻辑）。
- 决策项 2 = 规则改动范围
  - a. 仅改 `rules.mjs:154` 的 `## 需要替换` → `## 禁止术语`，解析逻辑不动
  - b. 改为同时兼容两个节标题
  - 选定：a。保持解析逻辑（第一列禁止 / 第二列应当使用 / 第三列条件）不变，最小改动。
- 决策项 3 = 界面旧称处理
  - a. 全部并入「禁止术语」表（含界面旧称，`term.interface` 判定靠 rules 的 `INTERFACE_NAMES`，与所在表无关）
  - b. 「界面名称」独立成节，禁止术语表另引界面旧称
  - 选定：a，避免两处重复。
- 决策项 4 = 表列结构（用户 2026-11-05 二次裁定）
  - a. 「推荐术语」两列（术语 + 解释），不加禁用列；「禁止术语」三列（被禁止术语 / 替换术语 / 对应情况）
  - b. 「推荐术语」含禁用列（最初草稿）
  - 选定：a。推荐表只写推荐词与其解释；禁用映射全部集中在「禁止术语」三列表，同时也是 rules 的解析源。

## 规划

任务拆分：

1. 重写 `docs/GLOSSARY.md` 为三节：推荐术语 / 禁止术语 / 保留。
2. 改 `dev/standard/rules.mjs:154` 读 `## 禁止术语`。
3. 改 `dev/standard/README.md:22` 描述。
4. 跑 `pnpm run check:docs` 验证解析与存量不误报。

计划改动文件清单：

- `docs/GLOSSARY.md`（重排三节）
- `dev/standard/rules.mjs`（节标题一行）
- `dev/standard/README.md`（术语规则描述一处）

明确不做：

- 不动 `docs/host/`（不参与本流程）
- 不改 `INTERFACE_NAMES` / `CONDITIONAL_TERMS` / 条件型逻辑
- 不改归档文档与 `docs/STATUS.md`
- 不重排其他 BACKLOG 条目

## 实现记录

- 2026-11-05: 重写 `docs/GLOSSARY.md` 为三节（推荐术语 / 禁止术语 / 保留）, 删除原「场景 → 应当使用」「界面名称」「需要替换」三节。
- 2026-11-05: `dev/standard/rules.mjs:151-156` 的 `loadGlossary` 改读 `## 禁止术语` 表, 解析逻辑（第一列禁止 / 第二列应当使用 / 第三列条件）不变。
- 2026-11-05: `dev/standard/README.md:22` 规则描述改「禁止术语」。
- 2026-11-05: `docs/BACKLOG.md:67` 旧条目「回合预算调整」正文「落点待裁定」→「改动位置待裁定」（存量修复, 用户批准一并修）。

## 偏差

无。

## 测试与证据

- 改动后 `node dev/standard/index.mjs --all`: `✓ check:docs 通过: 112 篇现行 Markdown / 901 个 .ts, 规则 0 项, 错误 0 / 警告 0`。
- 基线对照（`git stash` 后同命令）: 基线同样报 `docs/BACKLOG.md:67 旧称 落点 → 见场景表` 一条, 证明该命中是存量、非本次表改动引入; 修复后全绿。
- 中途（改表未修存量时）: `rules.mjs` 解析「禁止术语」表正常（报出条目换成「见「推荐术语」」）, 说明新表能被 `loadGlossary` 读取。
- `format` 已对改动文件执行, format 后复跑 check:docs 仍全绿。

## 收尾

（待写）
