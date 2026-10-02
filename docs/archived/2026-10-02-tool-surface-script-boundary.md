# 差异检查脚本覆盖边界未注明（接取条目：`docs/BACKLOG.md`「差异检查脚本覆盖边界未注明」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

`security-guard/scripts/tool-surface-check.mjs` 只扫描宿主安装树里的 `dsh-tool-*` 包，**不含 MCP / 第三方注册的工具**（而 README 推荐用 `unknownToolAllowlist` 的 `mcp__*` 处理它们）。当前 README 与脚本输出**都没写明这条边界** → 使用者会误以为「报 ok = 全覆盖」。

## 决策

- **D1（不改扫描面）**：**不加** `--include-mcp` 之类开关 —— MCP / 第三方工具名来自运行时注册（宿主不可静态枚举），脚本无从发现；加了开关也只会给出**假覆盖率**。
- **D2（输出注明边界）**：脚本摘要输出**固定一行**覆盖边界说明（与 `--json` 的 `boundary` 字段同名内容）：只扫 `@deepseek-ai/dsh-tool-*`；MCP / 第三方工具**不在面内**，需用 `unknownToolAllowlist`（如 `mcp__*`）或按真实参数面登记；`exit 0` **不等于**全覆盖。
- **D3（README 同步）**：README 的差异检查小节 + 「未登记工具」条各补一句同样边界。
- **D4（测试）**：`tests/script.test.ts` 补两条 —— ① 正常运行输出含边界行；② `--json` 含 `boundary` 字段（内容含 `mcp` 关键词）。
- **D5（反向验证）**：删掉边界行 → ① 必失败；还原全绿。
- **D6（验证）**：`security-guard` check/build/test；根 check/test/build；`format`；真实宿主跑一次脚本贴输出（含边界行）。
- **D7（不做）**：不改键集/深度/退出码语义；不动其它包；不引入运行时 MCP 探测。

## 计划改动文件清单

- `security-guard/scripts/tool-surface-check.mjs`、`security-guard/tests/script.test.ts`、`security-guard/README.md`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 交子代理审阅本文件「决策」。
1. 实现 + 测试 + 反向验证 + 全仓 `check` / `build` / `test`。
1. 关闭条目 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02）

- `scripts/tool-surface-check.mjs`（+105/-4）：新增 `BOUNDARY` 常量（摘要**固定一行**输出 + `--json` 的 `boundary` 字段同串，不分叉）；`--json` 另加**稳定布尔** `coversMcpTools: false` / `exitZeroMeansFullCoverage: false`；USAGE（`--help` 与所有 exit-2 共用）新增两行限定「0 仅指 `dsh-tool-*` 面内无需关注项，不覆盖 MCP / 第三方，也不覆盖宿主内非 `dsh-tool-*` 的其它官方包（如 `dsh-plan-mode`/`dsh-schedule`）」；文件头注释同步。**不加任何扫描开关**（D1）。
- 边界文案（脚本 / README 未登记工具条 / README 差异检查节**三处逐字统一**，仅 Markdown 标记差异）：「只扫 `dsh-tool-*` 包；**其它官方包**（如 `dsh-plan-mode` / `dsh-schedule` / `dsh-experimental-tool-agent-team`）、**MCP 与第三方运行时注册的工具**均不在面内，需用 `unknownToolAllowlist`（如 `mcp__*`）或按真实参数面登记；**`exit 0` 不等于全覆盖**。」
- README：差异检查节另写明「`boundary` 措辞可能变、**勿整串比对**；判稳定语义用布尔字段」；测试计数 104→106（script 11→13）。
- `docs/host/HOST-UPGRADE-0.2.0-rc.2.md` §5 那行（父会话）补同款边界半句。
- 新条目（父会话）：BACKLOG「差异检查脚本扫描面按包名前缀过滤（漏宿主内非 `dsh-tool-*` 命名的工具包）」——含扩面方案与噪声权衡（实测候选：宿主 `@deepseek-ai/dsh-*` 277 个候选包中 26 个含 `defineTool(`、另 6 个仅含 `parameters:`（含 `dsh-mcp-client`，扩面会引入噪声））。

## 测试与证据（2026-10-02）

- `security-guard`：`check` exit 0、`build` exit 0、**106/106 全绿**（用例数不变，2 条边界用例断言升级）。
- **反向验证三态**（每态还原后 sha256 与原件一致）：R1 删摘要边界行 → **2 例红**；R2 删两个布尔字段 → **1 例红**；R3 删 USAGE 限定两行 → **1 例红**；最终 106 pass / 0 fail。
- **真实宿主**（dsh 包目录，21 包 / 33 工具，exit=1 来自既有 3 条「需关注」）：摘要第 3 行即新边界文案；`--json` 片段 `{"boundary":"…","coversMcpTools":false,"exitZeroMeansFullCoverage":false,"packages":21,"tools":33}`；`--help` 尾部两行限定同文案；`packages` 仍 21 → **扫描面未变**（符合决策 ②）。
- 全仓：`npm run check` exit 0、`npm run build` exit 0、`npm run test` **20 包全 `fail 0`**（security-guard 106）；`format` 两代码文件 unchanged；`git diff --name-only | grep src/` 空。

## 审阅（子代理 `8c6dc0ed`）——结论：**有条件通过** → 处置

| 审阅发现 | 处置 |
|---|---|
| **P1（核心残留）**：边界文案排除集不完整 —— 脚本只认包名前缀 `dsh-tool-*`，而 `dsh-plan-mode`（`exit_plan_mode`）/`dsh-schedule`/`dsh-experimental-tool-agent-team`/`dsh-cordis-host-runner` 同样注册工具却**既不在面内也不在排除集**（假宿主只放 `dsh-plan-mode` → 脚本 exit 2） | 选**精确表述**路线：三类排除写进文案与 USAGE；**扩面方案**（前缀过滤 → `lib/index.js` 命中 `tools.register`/`defineTool`，默认关闭开关）已立项为 BACKLOG `#6` |
| P2 D1 理由拆两句（MCP＝运行时注册不可静态枚举；其它＝不在扫描面） | 已按此表述（`dsh-mcp-client` 工具名唯一来源是运行时 `listTools`，且 `publicToolName` 会加 12-hex 后缀） |
| P3 README 与脚本**逐字一致**未达成 | 已统一为同一句（程序化核对三处一致） |
| P4 `boundary` 仅散文串、机器语义不稳 | 已加 `coversMcpTools: false` / `exitZeroMeansFullCoverage: false` + README 说明「勿整串比对」 |
| P5 `--help`/USAGE 未限定 | 已补两行限定 |
| 漏项：`docs/host` §5 未注明边界 | 已补（父会话） |
| 漏项：扫描面前缀过滤需立项 | 已立项 BACKLOG `#6` |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：① **扫描面未扩**（`dsh-plan-mode`/`dsh-schedule`/`dsh-agent-team`/`dsh-cordis-host-runner` 等仍不在面内）→ BACKLOG `#6`；② 未跑 `security-guard` smoke（需模型 API）；③ 真机只跑了脚本（非 dsh 会话内调用）。
