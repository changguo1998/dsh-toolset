# 未登记工具回执缺键路径上下文（接取条目：`docs/BACKLOG.md`「未登记工具回执缺键路径上下文」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

`unknownToolPolicy` 命中**嵌套键**时，回执只报**叶子键名**（如「的 command」），看不出是 `children[].acceptance[].command` 还是别处的 `command`；排查时无法定位。要复用登记表的 `keyPath` 形态（`children[].executor.command`）拼出**完整键路径**。

## 决策

- **D1（遍历产出路径）**：`walkUnknownToolArgs` / `unknownToolSensitiveKeys` 的产出由「键名」升级为「**键路径**」——对象键 `.name`、数组元素 `[]`、嵌套对象继续 `.name`；去重按路径、保序；**深度上限 3 层与步数预算语义不变**（`truncated` 行为不变）。
- **D2（回执与来源标注）**：`formatUnknownToolReceipt` 打印完整路径（如 `命中参数：children[].acceptance[].command`）；`#checkUnknownTool` 的来源标注行同样用路径（如 `未登记工具「X」的 children[].acceptance[].command`）；**路径格式与登记表 `commandPaths` 一致**（`children[].executor.command`）。
- **D3（不回归面）**：回执仍含工具名、规则 id（check 命中时）、原因、放行方式；截断回执（`formatUnknownToolTruncatedReceipt`）不变；顶层键场景的路径就是键名（`path` / `command`），**既有断言若因此需改文本，逐条列出原→新→原因**。
- **D4（测试）**：① deny：`{children:[{acceptance:[{command:<危险命令>}]}]}` 回执含 `children[].acceptance[].command`（不再是裸 `command`）；② check：同上，来源标注行含完整路径 + 规则 id；③ 顶层键与一层数组（`files[].path`、`spec.command`）路径形态正确；④ 去重（同一路径多次出现只报一次）与保序；⑤ 截断回执不受影响。
- **D5（反向验证）**：把路径退回「只报叶子键名」→ ①③ 必失败（两态）。
- **D6（文档）**：`security-guard/README.md` 回执示例补「命中参数给完整键路径（与登记表 `commandPaths` 同形）」。
- **D7（不做）**：不改判定逻辑与深度/预算；bastle 不加配置项；不动其它包。

## 计划改动文件清单

- `security-guard/src/index.ts`、`security-guard/tests/guard.test.ts`、`security-guard/README.md`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 交子代理审阅本文件「决策」。
1. 实现 + 测试 + 反向验证 + 全仓 `check` / `build` / `test`。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02）

- `src/index.ts`（+67/-36）：`walkUnknownToolArgs` 增 `keyPath` 产出（对象 `.name`、数组 `[]`、顶层即键名；`prefix=undefined` 表根以区分空键名）；`unknownToolSensitiveKeys` 返回**路径**（去重保序）；`UnknownToolScan` 与两个来源标注函数改用 `keyPath` → deny 回执 `（children[].acceptance[].command）`、check 来源行同路径。**判定逻辑 / 键深 3 层 / 4096 节点 / 64 层 / 配置 / 截断回执均未动**。
- `tests/guard.test.ts`：**既有断言改 3 处**（① `present` 用例 `的 path。`→`的 files[].path。`；② 深度 3 层用例 deny 期望按形状拼路径 + 新增 `keyPathRegExp()` 转义助手；③ 无害填充用例 `（command）`→`（children[].executor.command）`）；**新增 5 例**（deny 完整路径 + 反向锁、check 来源行 + 规则 id、形态矩阵〔顶层 / 一层数组 / 一层对象 / watched 键自身为数组〕、去重保序、截断回执不受影响）。顶层键用例与 check 的规则 id/敏感层/allowPatterns 断言**逐字未动**。
- `README.md`（+7/-6）：回执示例补「完整键路径（与 `commandPaths` 同形）」4 处，并同步用例计数 99→104、guard 72→77。
- 口径选择（父会话认可）：D2 的「命中参数：」按**既有形态** `携带潜在路径/命令参数（<路径>）` 落实，不新增字面前缀（D3「回执其余要素不变」）。

## 测试与证据（2026-10-02）

- `security-guard`：`check` ok、`build` ok、**104/104 全绿**（原 99 → +5）。
- **反向验证两态**：把 `keyPath` 退回「只报叶子键名」→ **70 pass / 7 fail**（失败集恰为 4 个新路径用例 + 3 个更新过的既有断言；实测 deny 回执退化为 `（command）`）；还原后 `src/index.ts` **sha256 逐字节一致** → 104/104。
- 第 5 个新用例（截断）在变异态**仍通过** → 证明它锁「不回退」而非路径内容（鉴别力分层的自检）。
- 全仓：`npm run check` exit 0、`npm run build` ok、`npm run test` **20 包全 `fail 0`**（security-guard 104）；`format` 幂等无残留；`git diff --name-only | grep src/` 仅本包 `src/index.ts`。

## 审阅（子代理 `435181d8`，进行中）——已回部分的结论

| 已核验项 | 结果 |
|---|---|
| 路径与登记表 `commandPaths` 同形 | ✓（`children[].acceptance[].command`）；**嵌套数组 `a[][].path`** 能生成但登记表 `commandPathValues` **解析不了**（既存、非本条引入，见残余） |
| 改动是否只换文案、不动判定 | ✓ 46 组（deny/check）HEAD vs 工作区 **verdict 0 处不一致**；`WeakSet` / 4096 节点 / 64 层语义未变 |
| 既有断言必红清单 | 实测 3 例（`guard.test.ts:1434`、`1605+1609`、`1741`）与实现者所列**一致** |
| **新发现（既存缺陷，old==new）** | check 模式「**截断 + 已收集无害值**」→ **静默放行**（5000 元素数组仅末元素带危险 command 实测 `null`、0 告警），与 README「截断绝不静默放行」矛盾 → 已立项 **BACKLOG `#5`**（P2） |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：① **嵌套数组路径**（`a[][].path`）与登记表 `commandPathValues` 的解析口径不一致（既存；影响 `task_decompose` 对嵌套数组命令路径的登记）；② **check 截断静默放行** → BACKLOG `#5`；③ 审阅终报在关闭时未回（已回部分见上表，与实现一致）；④ 真机未验（无 dsh 会话）。

## 补记：既有断言的「原 → 新 → 原因」清单（2026-10-02，审阅要求）

| 位置（当时行号） | 原断言 | 新断言 | 原因 |
|---|---|---|---|
| `tests/guard.test.ts:1434` | `/路径复查来源：未登记工具「present」的 path。/` | `…的 files[].path。` | 来源标注行升级为完整键路径（该用例参数是 `files:[{path}]`） |
| `:1605` | `/携带潜在路径\/命令参数（command）/` | `（children[].executor.command）`（按形状拼、`keyPathRegExp` 转义） | deny 回执按路径展示，三种两层形状不再同形 |
| `:1609` | `（path）` | `（files[].meta.path）` | 同上 |
| `:1741` | `/携带潜在路径\/命令参数（command）/` | `（children[].executor.command）` | 同上（遍历上限用例的参数即该路径） |

- 未动的既有断言：全部**顶层键**用例（`command`/`measureCmd`/`cmd`、`script`/`code`/`program`、`to`、`filePath` —— 顶层键路径 == 键名）、check 的规则 id / 敏感层标签 / `allowPatterns` / `allowedPaths` 断言。
- 审阅补记结论：**截断回执不必给已收集路径**（`index.ts:1039` / `:1111` 已核实：其只在**零命中**时可达）；`docs/host`、根 README/zh、STATUS 均不需同步；`scripts/tool-surface-check.mjs` 仅消费键集/`keyDepth`，本次未动（其报告仍打叶子键名，追求口径一致时可选做 → 已并入 BACKLOG）。
