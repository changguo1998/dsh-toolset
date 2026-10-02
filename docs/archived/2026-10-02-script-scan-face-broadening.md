# 差异检查脚本扫描面按包名前缀过滤（接取条目：`docs/BACKLOG.md`「差异检查脚本扫描面按包名前缀过滤」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 背景（前条目审阅实测）

`security-guard/scripts/tool-surface-check.mjs` 只把**包名前缀 `dsh-tool-*`** 的包当候选，导致宿主里同样注册工具、但命名不含 `tool` 的官方包**整体漏扫**：实测 `dsh-plan-mode`（`exit_plan_mode`）、`dsh-schedule`（`schedule_create`/`list`）、`dsh-experimental-tool-agent-team`（`spawn_teammate`/`send_message`/`list_agents`）、`dsh-cordis-host-runner`（`inventory`/`invoke`）在输出中出现 **0 次**；假宿主只放 `dsh-plan-mode` 时脚本直接报「未找到 dsh-tool-\* 工具包」exit 2。

实测规模（真实宿主，前条目审阅给出）：`@deepseek-ai/dsh-*` 候选 **277** 个（276 个有 `lib/index.js`），其中 `defineTool(` + `parameters:` **26** 个、仅 `parameters:` **6** 个（含 **`dsh-mcp-client`** —— 它会引入噪声）、其余 244 个无工具定义。

## 决策

- **D1（候选面放宽 + 内容判定）**：候选包从 `dsh-tool-*` 放宽到**宿主树里的全部 `@deepseek-ai/dsh-*` 包**，并**按内容判定是否登记面**：`lib/index.js` 里出现 `defineTool(`（含 `tools.register(...defineTool({...}))` 两种形态）→ 纳入扫描；**只有 `parameters:` 而无 `defineTool(` 的 6 个包**（含 `dsh-mcp-client`）不纳入（避免噪声与假覆盖），但**在输出里单列一行提示**「另有 N 个包含 `parameters:` 但未见 `defineTool(`，未纳入（含 MCP 客户端）」，让使用者知道边界。
- **D2（输出稳定）**：既有输出结构不变（`宿主目录` / `键集/登记集来源` / `覆盖边界` / `已覆盖` / `需关注` 等行）；**包数/工具数会变大**（真实宿主 21 → 预计 ~40 包级别），故既有断言里写死的数字（如 `21 个 dsh-tool 包`）需按实测更新，并**逐条列出改动**。
- **D3（未找到工具的判定）**：`--root` 下**既没有** `dsh-tool-*` 也**没有**任何含 `defineTool(` 的 `dsh-*` 包时 → 保持 exit 2 与用法提示（措辞从「未找到 dsh-tool-\* 工具包」改为「未找到任何含工具定义的 `@deepseek-ai/dsh-*` 包」，并保留原措辞作为兼容子串或同步改断言）。
- **D4（测试）**：① 假宿主只放**非** `dsh-tool-*` 命名但含 `defineTool(` 的包 → 其工具被计入（覆盖本条目核心）；② 只含 `parameters:` 的包**不**计入工具、但出现在「未纳入」提示行；③ 原 `dsh-tool-*` 行为不回归（既有 13 例）；④ 空宿主 → exit 2 + 新措辞；⑤ `--json` 的 `boundary`/`packages`/`tools` 与新提示字段（如有）形状正确。
- **D5（反向验证）**：把「内容判定」退回「前缀过滤」→ ① 必失败；还原全绿（逐字节）。
- **D6（文档）**：`security-guard/README.md` 的覆盖边界段更新（扫描面 = 含 `defineTool(` 的 `@deepseek-ai/dsh-*` 包；`parameters:`-only 不纳入；MCP 客户端仍不在面内），脚本 `BOUNDARY` 文案同步；用例计数同步。
- **D7（不做）**：不做运行时 MCP 探测；不解析 profile 侧第三方插件；不改判定/键集/退出码语义（除 D3 措辞）；不改其它包。

## 计划改动文件清单

- `security-guard/scripts/tool-surface-check.mjs`、`security-guard/tests/script.test.ts`、`security-guard/README.md`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 实现 + 测试 + 反向验证 + 全仓 `check` / `build` / `test` + 真实宿主跑一次取证。
1. 交子代理审阅（只读）。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02，父会话直接实现）

- `scripts/tool-surface-check.mjs`：候选面放宽 —— **`dsh-tool-*` 无条件纳入**（保持历史行为）+ **其它 `@deepseek-ai/dsh-*` 包按内容判定**（`lib/index.js` 含 `defineTool(`）；仅含 `parameters:` 的包**不纳入**并在摘要**单列一行提示**（`另有 N 个包只见 parameters: 未见 defineTool(，未纳入`）；`--json` 新增 **`parametersOnly: string[]`**；`BOUNDARY` / USAGE / 头部注释 / `BOUNDARY` JSDoc 全量同步新口径；`isScopeLayer` 探测前缀同步放宽。
- `tests/script.test.ts`（+1 例，且既有断言按新文案逐条更新）：假宿主放**非** `dsh-tool-*` 命名但含 `defineTool(` 的包（`dsh-plan-mode` 形态）→ 其工具 `exit_plan_mode` 出现在输出；`parameters:`-only 包（`dsh-noise-client`）不纳入、出现在提示行、`--json.parametersOnly` 精确等于 `["dsh-noise-client"]`、`packages` 仍为 1。
- `README.md`：两处边界段与陈旧措辞同步（含「21 包/33 工具 → 27 包/49 工具、需关注 3 → 8」）。

## 测试与证据（2026-10-02）

- `security-guard`：`check` exit 0、`build` exit 0、**114/114 全绿**（原 113 → +1）。
- **反向验证**：候选退回 `dsh-tool-` 前缀过滤 → **恰 1 例红**（新用例）；还原后 sha256 **逐字节一致** → 114/114。
- **真实宿主（fnm 全局 dsh）**：`--root <dsh 包目录>` → **27 个含工具定义的包 / 49 个工具 / 需关注 8** + 提示行列出 6 个 `parameters:`-only 包（含 `dsh-mcp-client`），**exit 1**；改动前同机 21 包 / 33 工具 / 需关注 3。新增项真实：`schedule_create`（`dsh-schedule` 的 `defineTool` 注册）、`send_message` / `interrupt_agent`（agent-team，本会话工具面确实有）。
- 全仓：`npm run check` exit 0、`npm run test` **20 包全 `fail 0`**、`npm run build` exit 0。

## 审阅（子代理 `c06fb498`）——结论：**有条件通过** → 处置

| 审阅发现 | 处置 |
|---|---|
| **P2 ①**：`--json` 缺 `parametersOnly`（文本通道有、机器通道零痕迹） | 已补字段 + 用例断言 |
| **P2 ②**：README 第二处（:156）与脚本头注释（7-10 行）/ `BOUNDARY` JSDoc（54-63 行）「不在面内」仍旧文案，与新口径矛盾 | 已全部同步（脚本 3 处 + README 2 处 + 测试头注释） |
| P3 ③：新条目「3→8」漏列既有 `workflow` 名称未解析，且 `dsh-tools` 那条实为 `run_code`（已在 `RUN_CODE_TOOLS`，属保守多报） | BACKLOG 条目文本已改写（区分「4 项真实缺口 + 2 项保守多报」） |
| P3 ④：符号链接包目录被 `isDirectory()` 跳过（pnpm 树漏扫，预存在） | 已立项为 P3 残余条目 |
| P3 ⑤：`seenPkgs` 按包名去重，外层 stub 可能遮蔽内层真实包 | 已立项为 P3 残余条目（同一行） |
| 审阅另指出：D1 称「`parameters:`-only 包不注册工具」**不成立**（`dsh-subagent-in-process-driver:53-55` 以纯对象注册真实工具）→ 属**潜在假阴性类**（今日 0 漏报） | 已并入 P3 残余条目 |
| 审阅确认：真实形态都能命中（`tools.register(defineTool({…}))`、`const NAME=…; defineTool({name: NAME})`）；真机 exit code **1**（未被管道吞）；反向验证**恰 1 例红** | 已确认 |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：见 BACKLOG 两条新条目（「新暴露工具裁定」P2、「脚本三条已知边界」P3）。
