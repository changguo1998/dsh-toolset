# 重新审计：本仓插件与官方包的复用关系（接取条目：docs/BACKLOG.md「重新审计：本仓插件与官方包的复用关系」）

状态：关闭　　开启：2026-10-19　　关闭：2026-10-20
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按当前宿主基线（fff profile 实挂官方行 + `docs/host/HOST-PACKAGES.md` 口径；基线是否随「检查官方 deepseek-harness 更新」条目的结论而变，先与该条目对齐）重跑 29 模块复用审计：全量入表、逐包给「改用 / 保留 / 并存」结论与一句话理由，补齐 7 个缺审包（`herdr-pane` / `md-table-check` / `background-daemon` / `preference-analysis` / `session-paths` / `script-interpreter` / `agent-group`），重写 `docs/ARCHITECTURE-REUSE.md` §0 总表 / §4 / §5；原 §4 的 B / D / E 与 FTS5 观察项重判后要么执行、要么明示关闭。

## 调研

（2026-10-20 主会话执行，基线 `0.2.0-rc.2`（与条目 3 绑定：条目 3 调研确认官方最新 `0.2.1-rc.2`，升级未裁定 → 本审按**当前基线 0.2.0-rc.2** 开工，升级后回查见「偏差」）。方法：逐包读 README / DESIGN + 源码 inject/get/loadHost 实测（grep 口径）对照 `docs/host/HOST-PACKAGES.md` 官方包清单与既有 §0/§4/§5 结论。）

## 决策

- ① 基线参照物：**维持 `0.2.0-rc.2`**（fff 实挂官方行 + `HOST-PACKAGES.md` 口径）；升级至 `0.2.1-rc.2` 的裁定仍开放，若发生需回查动基线的列。
- ② 范围：**全部 29 模块**——既有 22 行复核（无需要翻案的；`background-daemon` 因 memory 底座 2026-10-20 落地更新其 §3 消费面），补审 7 包（`herdr-pane` / `md-table-check` / `background-daemon` / `preference-analysis` / `session-paths` / `script-interpreter` / `agent-group`）。
- ③ 重判触发「改用官方面」：**零项改用**（结论分布 改用 0 / 保留 21 / 并存 8），无需另立条目。
- §4 处置：**B 已执行**；**D / E / FTS5 观察项明示关闭**（理由与依据写入 `ARCHITECTURE-REUSE.md` §4 各行与观察项②）。

## 规划

任务拆分：

- 前置对齐：「检查官方更新」条目结论先行确定基线（若官方有新版本且用户裁定升级，本审以新基线为准）。
- 逐包对照：29 模块逐包重跑「改用 / 保留 / 并存」判句 + 一句话理由；7 个缺审包补齐；原有结论复核。
- 重写文档：`docs/ARCHITECTURE-REUSE.md` §0 总表 / §4 / §5；B / D / E 与 FTS5 观察项给明确处置（执行则另立条目，关闭则注明）。
- 产物复核：§5「可挂但不该挂」清单一律落非生成型文档（`ARCHITECTURE-REUSE.md` / `profiles/example` 注释）。

计划改动文件清单（预估）：

- `docs/ARCHITECTURE-REUSE.md`（§0 总表 / §4 / §5）
- 本追踪文档
- 重判出「改用官方面」的落地改动：不在本任务内实施，另立 BACKLOG 条目（本次只登记不动）

明确不做：不改各包代码；不推进 §5 挂载判定；不改 `docs/host/HOST-PACKAGES.md`（宿主面知识，升级流程单独走）。

## 实现记录

- 2026-10-20：重写 `docs/ARCHITECTURE-REUSE.md` —— 文件头（29 全量、结论分布改用 0 / 保留 21 / 并存 8、基线维持与升级回查标注）；§0 总表补 7 行（`herdr-pane` / `md-table-check` / `background-daemon` / `preference-analysis` 保留；`session-paths` / `script-interpreter` 并存；`agent-group` 保留）；§1 保留项共同理由 16→21 并补 5 个诉求；§2 并存边界补 `session-paths` / `script-interpreter` 两行；§3 补 `background-daemon` 消费面 + 其余 6 包「以本仓服务为主」注记；§4 的 B 标已完成、D / E 与 FTS5 观察项标明示关闭；§7 修订记录补两行。
- 官方消费面实测（7 包）：`background-daemon` inject `agents/sessions/commands/tools`、可选 `guard` / 晚挂 `memory`；其余以本仓 `ruleEngine` / `guard` / `sessionChannel` / `agentGroup` / `sessionPaths` / `memory` 为主，无新增官方依赖。

## 偏差

- **升级回查门**：升级基线（`0.2.1-rc.2`）裁定开放 → 升级后需回查 `ARCHITECTURE-REUSE.md` 头部标注的「受 0.2.1 新面影响」列（已知接触点：`background-daemon` 与官方 Web 内置 automation 的职责叠加（HOST-UPGRADE #12）、`tool-bash` 与 `script-interpreter` 的边界随工具面变动）。此门属升级流程后置，不阻塞本审关闭。
- 未做：27 包逐包官方包描述级全量重扫（沿用既有 22 行结论 + 2026-10-02 事实基线，仅新增包补审与受影响处更新）——结论分布无改用项，风险低。

## 测试与证据

- 29 行总表实证：`docs/ARCHITECTURE-REUSE.md` §0（新补 7 行各带「包 / 官方最接近的面 / 重合度 / 结论 / 一句话理由」）。
- §4 处置证据：`output-compress/docs/DESIGN.md` §1/§2（spill-policy 分工表 + 阈值语义，B 已执行）；官方 `session-query-sqlite` 缺省 `openAt: never`（FTS5 观察项关闭依据）。
- 消费面实测输出（7 包 grep）：见「实现记录」第二段。
- 结论分布自检：改用 0 / 保留 21 / 并存 8 = 29（§0 行数一致）。

## 收尾

- 产出：`docs/ARCHITECTURE-REUSE.md`（§0 总表 29 行 / §1 / §2 / §3 / §4 处置 / §7 修订记录）。
- BACKLOG 条目 2「重新审计」标记完成并从 §2 移除（注记：升级回查门随升级流程后置；审计预期结论已落盘）。
- 本追踪文档归档至 `docs/archived/`。未产生「改用官方面」新条目（零改用）。
