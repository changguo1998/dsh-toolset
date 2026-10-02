# `unknownToolPolicy` 两处缺口（接取条目：`docs/BACKLOG.md`「`unknownToolPolicy` 两处缺口」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标（两处，均来自 `2c0991c` 的核验/审阅）

① **键名启发只到两层**（顶层键 + 数组元素一层 + 嵌套对象一层）→ `{children:[{executor:{command}}]}`、`{children:[{acceptance:[{command}]}]}`、`{files:[{meta:{path}}]}` 三类**两层嵌套**在 `deny`/`check` 下**漏拦**（实测 ALLOW）。
② **等价对照用例无区分度**：`tests/guard.test.ts` 的「已登记与官方在两种策略下判定一致」四个 case 全是普通参数（两模式都 allow，退化为 `null === null`）→ 改为**含敏感参数**的等价对照，断言两模式**同判且同规则 id**。

## 决策

- **D1（递归深度）**：`unknownToolSensitiveKeys` 改为**按深度递归**（上限 **3** 层：顶层 → 数组元素 → 其对象成员 → 再一层数组元素；带环检测），保持「命中键名去重保序」与既有返回值语义；**不改**键集本身。
- **D2（脚本一致性）**：`scripts/tool-surface-check.mjs` 的参数发现深度与引擎一致（3 层），避免「脚本说需关注、引擎不拦」或反之。
- **D3（对照用例重写）**：四个 case 换成含敏感参数的等价对照 —— `hash_read{path:<临时目录敏感名>}`、`metric_loop{action:"start",measureCmd:<拼接构造的黑名单命中命令>}`、`read{file_path:<敏感名>}`、`bash{command:<同上>}`；断言 `strict.inspect() === loose.inspect()` **且**回执含同一规则 id（`env-file` / `ssh-rsa-key` / `sudo` 等），并单独断言「缺省模式确实拦」（避免再退化为 `null === null`）。
- **D4（测试）**：补两层嵌套用例 —— `{children:[{executor:{command:<危险命令>}}]}` 在 `check` 与 `deny` 下都拦；`{children:[{acceptance:[{command:<危险命令>}]}]}` 同；`{files:[{meta:{path:<敏感名>}}]}` 拦；再加「深度 4 不误伤」（更深同形结构保持放行，锁定上限语义）。
- **D5（不做）**：不改默认行为（`allow` 逐字不变）；不引入按 schema 类型判定；不做无限深度递归。
- **D6（验证）**：`security-guard` check/build/test；**反向验证**：深度退回 2 层 → 新增嵌套用例必失败（两态）；根 check/test/build；`format`；变异残留自查。
- **D7（文档）**：README 补一句「键发现深度上限 3 层」。

## 计划改动文件清单

- `security-guard/src/index.ts`（D1）、`security-guard/scripts/tool-surface-check.mjs`（D2）、`security-guard/tests/guard.test.ts`（D3/D4）、`security-guard/README.md`（D7）
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 交子代理审阅本文件「决策」。
1. 实现 + 测试 + 反向验证 + 全仓 `check` / `build` / `test`。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02）

- `src/index.ts`：新增 `walkUnknownToolArgs`（对象层计深、数组透明、`WeakSet` 环检测）+ `UNKNOWN_TOOL_KEY_DEPTH = 3`；`unknownToolSensitiveKeys`（deny 键名启发）与 `scanUnknownToolArgs`（check 值面扫描）**共用同一遍历器**（两态深度不分叉）。**P1 修复**：步数**只对容器计**、节点预算提到 4096 级，**耗尽时保守**（`deny` → 拦；`check` → 不静默放行，告警 + 按拦处理）。深度常量并入 `TOOL_SURFACE` 单一来源。
- `scripts/tool-surface-check.mjs`：`nestedKeys` 改递归、深度上限从 `TOOL_SURFACE` 取（读不到 → exit 2），`items` 与数组同层不消费深度；输出行标注深度。
- `tests/guard.test.ts`：D3 对照用例重写（含敏感参数 + 同判 + 同规则 id + 缺省确实拦）；D4 三类两层形态 × check/deny、第 4 层不误伤 × check/deny、环引用两例；**P1 填充不规避用例**（35/200 个无害填充 + 后续危险键 → 两态都拦）、深数组用例；与既有 :1546 重复的三态用例**去重**。
- `tests/script.test.ts`：补脚本**深度语义**两例（3 层形态被发现、第 4 层不被发现）。
- `README.md`：深度说明（**数组层不计数**、节点预算与「耗尽时保守」语义、键名大小写不敏感）、用例数更新。

## 测试与证据（2026-10-02）

- `security-guard`：`check` exit 0、`build` exit 0、**99/99 全绿**（改前 91 → +8）。
- **反向验证两态**：深度退回 2 → 嵌套用例失败（68 pass / 1 fail，引擎探针三类形态 6/6 ALLOW＝缺口原状）；还原 → 探针 6/6 DENY、99/99。P1 修复后另验「撤容器级步数/预算 → 填充规避用例必失败」。
- 全仓：`npm run check` exit 0、`npm run test` **20 包全 `fail 0`**、`npm run build` exit 0（父会话复跑）。
- 脚本侧探针：第 3 层形态报「需关注」、第 4 层不报；真实宿主仍「需关注 3 / exit 1」。

## 审阅（子代理 `88ba5a1a`）——结论：**有条件通过** → 处置

| 审阅发现 | 处置 |
|---|---|
| **P1（必修）** `MAX_WALK_STEPS=64` 按每帧（含标量）扣 → 无害填充 35 个即可让危险键**完全不复查**（deny/check 双放行） | 已修：步数只对容器计 + 节点预算 4096 + **耗尽时保守**（deny 拦 / check 不静默放行）+ 填充不规避用例 + README 语义 |
| P2 深度常量两处硬编码 | 已修：并入 `TOOL_SURFACE`，脚本读不到 → exit 2 |
| P2 脚本新深度无语义测试 | 已补 `script.test.ts` 两例 |
| P2 D3 与既有 :1546 用例重复 | 已去重（保留区分度更强的一条） |
| P3 README 未说明数组层不计数与步数截断 | 已补 |
| P3 嵌套命中回执只报叶子键名（缺 `children[].acceptance[].command` 上下文） | **未做** → 记为新条目候选（回执上下文用登记表 `keyPath` 形态） |
| P3 脚本扫描面只含 `dsh-tool-*` 包，MCP 工具不在面内 | **未做** → README/输出未注明覆盖边界，记为新条目候选 |
| 漏项：`#2`（task-engine 执行期复查）不需同步深度口径（走 `commandPaths`） | 已在 `#2` 描述中写明，避免后来者误改 |

- 审阅确认的事实：真实两层嵌套只有 `task_decompose{children[].executor/acceptance.command}`（已登记）与 `goal_contract_draft{clauses[].command}`；**未发现 4 层真实形态**（即本条目属口径补齐，真实增益≈0）；`allow` 逐字不变、已登记工具三态同判；D3 重写后的用例**确有区分度**（变异后失败，旧版不失败）。

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余（记为新条目候选，关闭后另开）：① 嵌套命中回执缺键路径上下文；② 脚本覆盖边界（不含 MCP 工具）未在 README/输出注明；③ 真机未验（`deny`/`check` 在 profile 里实跑 `present`/`workflow`）。
