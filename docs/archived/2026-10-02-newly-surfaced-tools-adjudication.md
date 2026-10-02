# 扫描面放宽后新暴露的未登记工具：逐项裁定（接取条目：`docs/BACKLOG.md`「扫描面放宽后新暴露的未登记工具」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 背景

扫描面放宽后真实宿主出现 5 个新增「需关注」项（21 包/33 工具 → 27 包/49 工具、需关注 3 → 8）。本条目**逐项裁定**：登记进表，还是「不登记 + 理由」。

## 逐项裁定（读宿主源码核实参数面）

| 工具 | 宿主包 | 实测参数面 | 裁定 | 理由 |
|---|---|---|---|---|
| `send_message` | `dsh-experimental-tool-agent-team`（`lib/index.js:296`） | `target`（string）、`message`（string） | **不登记** | `target` = **团队成员的标识**（"Member target returned by spawn_teammate or list_agents"），**不是文件路径**；本工具不经 shell、不读写文件 → 属**键名启发误报**（`target` 同时在 `UNKNOWN_TOOL_PATH_KEYS` 里） |
| `interrupt_agent` | 同上（`:354`） | `target`（string） | **不登记** | 同上（`target` 是 agent 标识） |
| `schedule_create` | `dsh-schedule`（`:2120`） | `prompt` / `title` / `after_seconds` + `...SELECTOR_PARAMETERS`（`:2025`）展开的 `every_seconds` / `daily` / `weekly` / `cron` / `at` | **不登记** | **无任何路径/命令参数**（含展开面，审阅逐项核对）；脚本报「参数面含展开」属**保守多报** |
| `schedule_update` | `dsh-schedule`（`:2223`） | `id` / `title` / `prompt` + 同上一组 selector | **不登记** | 同上（审阅补充：update 另有 `id`） |
| `（名称未解析）`（`dsh-tools`，code 面） | `dsh-tools` | `run_code`（**已在 `RUN_CODE_TOOLS`**） | **无需登记** | 工具名走常量（`const RUN_CODE_NAME = "run_code"`）→ 脚本名称解析不出、按「宁可多报」列出；**非新缺口** |

**结论**：5 项新增「需关注」**全部为不登记项**（0 个真实缺口需补登记）——4 项属键名/参数展开导致的保守多报，1 项属名称未解析导致的重复报。**真正的新发现**是扫描面放宽本身把 `dsh-plan-mode` / `dsh-schedule` / `agent-team` 等包纳入可视范围（这是上一批条目的成果）。

## 决策

- **D1（不登记）**：上述 5 项**都不加入** `PLUGIN_FILE_TOOLS` / `PLUGIN_COMMAND_TOOLS`（登记表的语义是「会读写文件 / 会把命令交给 shell」，它们都不满足）。
- **D2（把裁定写进文档，避免每次跑脚本都要重新判断）**：`security-guard/README.md` 的差异检查小节加「**已知多报（无需登记）**」清单（上表 5 项 + 各自一句话理由）。
- **D3（脚本侧不改判定）**：不改键名启发与「宁可多报」口径（保守方向正确）；**仅**在 README 说明「`target` 一类键名在非文件语义下会多报，需人工复核」。
- **D4（残余）**：① 脚本对「参数面用展开」的包只报「参数面含展开」、无法列出具体键 → 建议后续支持一层 `...spread` 解析（另开条目再做）；② 名称未解析（常量名工具）导致的重复报同理。
- **D5（不做）**：不给这 5 个工具加 `unknownToolAllowlist` 示例（它们是宿主官方工具、非本仓配置对象）；不动其它包。

## 计划改动文件清单

- `security-guard/README.md`（已知多报清单）+ `security-guard/scripts/tool-surface-check.mjs`（如需给一行「已知多报」提示，最小改动；否则不动）
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. README 落「已知多报」清单。
1. 交子代理审阅（只读）。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02，父会话直接实现）

- `security-guard/README.md`：差异检查小节的「已知多报（无需登记）」清单 —— 覆盖**全部 8 项**：新增 5 项（agent-team 两工具 / schedule 两工具 / `dsh-tools` 的名称未解析）**+ 既有 3 项重述**（`present` 的 `files[].path`、`str_replace_editor` 的命令面+写面、`dsh-tool-workflow` 的 `script` 代码键）；schedule 的实测参数面按审阅更正（含 `SELECTOR_PARAMETERS` 展开；update 另有 `id`）；agent-team 措辞由「不读写文件」软化为「参数面不含路径/命令键、不经 shell」；并说明「需关注」行里给的是**叶子键名**、完整键路径见引擎回执。
- `docs/BACKLOG.md`：①「脚本已知边界」条目追加第 ④ 条（`dsh-cordis-host-runner` 用 `parameters: normalized.spec` 动态构造 → 包计入面、工具解析 0，动态注册完全不可见）；②新增条目「差异检查脚本：工具『名称误配』会静默假阴性」（`dsh-plan-mode` 真名 `exit_plan_mode` 被报成 `plan`；带前置 `name: "read"` 字面量时甚至 `exit 0` 静默假阴性）。

## 测试与证据（2026-10-02）

- 本条目**不改代码**（裁定 + 文档）：`security-guard` `npm run test` → **114/114 全绿**；根 `npm run check` exit 0（`build` 无产物变化）。
- 证据来源：宿主源码逐项核对（`dsh-experimental-tool-agent-team:296/302/354`、`dsh-schedule:2025/2120/2137/2223`、`dsh-tools:898/1122`）、真实宿主脚本复跑（27 包/49 工具/需关注 8/exit 1）。

## 审阅（子代理 `b7e36c9b`）——结论：**有条件通过** → 处置

| 审阅发现 | 处置 |
|---|---|
| 5 项「不登记」裁定**逐条读宿主源码后全部成立**（agent-team 的 `target` 确为 agent 标识；`dsh-tools` 确为 `run_code`；schedule 无路径/命令面） | 已确认 |
| **P2①**：schedule 证据陈述被证伪（真实面含 `SELECTOR_PARAMETERS` 展开；update 另有 `id`） | 已在 README 与本文档更正（裁定本身不变） |
| **P2②**：「已知多报」清单缺 `present` / `str_replace_editor` / `workflow` 的现状口径（D2 只覆盖 5/8） | 已在 README 补齐 3 项（标注「既有 3 项，历史口径重述」） |
| **P2③**：`docs/BACKLOG.md` 原条目措辞与本裁定矛盾（「4 项为真实缺口」） | 条目关闭时整行删除（措辞不流入提交/摘要） |
| P3④ `...selectorParameters` 大小写不符源码 | 已改为 `...SELECTOR_PARAMETERS` |
| P3⑤ `docs/host/HOST-UPGRADE-0.2.0-rc.2.md:196` 的旧边界句已过期 | **不在本条目范围**（docs/host 不参与变更流程）→ 记残余 |
| P3⑥ `dsh-cordis-host-runner` 动态参数（`parameters: normalized.spec`） | 已并入 BACKLOG「脚本已知边界」条目第 ④ 条 |
| P3⑦「需关注」行给叶子键名（如 `path`）易误读 | README 已说明「叶子键名 + 完整键路径见回执」 |
| **漏项**：脚本「名称误配」缺陷（前置 `name` 字面量会导致取错名字并**静默假阴性**） | 已立项为新 BACKLOG 条目（P2） |
| 残余观察：agent-team「本工具不读写文件」措辞过强 | 已软化为「参数面不含路径/命令键、不经 shell」 |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：① `docs/host/HOST-UPGRADE-0.2.0-rc.2.md:196` 旧边界句过期（docs/host 由升版流程维护）；② `str_replace_editor` 既判「待补登记或裁定」——本条目判为**不登记**（宿主工具、写面由宿主自身策略约束），如后续要登记另开条目。
