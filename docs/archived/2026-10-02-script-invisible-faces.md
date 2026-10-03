# 差异检查脚本的两条「看不见」边界（接取条目：`docs/BACKLOG.md`「差异检查脚本的两条『看不见』边界」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 问题

1. **纯对象注册不可见**：包用 `ctx.tools.register({ name, parameters })`（**无 `defineTool(`**）注册真实工具时，既不在面内、也可能连提示行都不进（旧判定只认 `parameters:` 子串）。
1. **动态参数工厂**：包被计入面内、但工具**解析 0 个**（如 `parameters: normalized.spec`）→ 动态注册的工具完全看不见，输出里没有任何提示。

## 决策

- **D1（第三类：疑似注册面）**：分类由「`defineTool(` → 面内 / `parameters:` → 提示」扩为**三类**：`defineTool(` → **面内**；否则若文本含 **`tools.register(` 或 `parameters:`** → **提示行**（「疑似注册面，无法静态解析工具名」，不纳入面、避免假覆盖率）；两者都无 → 忽略。
- **D2（零工具包提示）**：面内包**解析到 0 个工具**时，摘要**单列一行**「N 个面内包解析到 0 个工具（动态构造）」，`--json` 同步字段 `zeroToolPackages: string[]`。
- **D3（不改判定）**：三分类、键类判定、退出码语义不变；只增加「可见性」两类提示。
- **D4（测试）**：① 纯对象注册包（`tools.register({ name, parameters })`、无 `defineTool(`）→ 进提示行、不进「已覆盖/需关注」，`--json.parametersOnly` 或新字段含它；② 面内包 `parameters: someVar`（动态）→ 出现「解析到 0 个工具」提示 + `--json.zeroToolPackages` 含它；③ 既有 118 例不回归。
- **D5（反向验证）**：撤 D1/D2 → ①② 必失败；各自还原逐字节。
- **D6（文档）**：README 覆盖边界段补两句（第三类提示 / 零工具包提示）。
- **D7（不做）**：不解析对象字面量的变量引用；不做 MCP 运行时探测；不改其它包。

## 计划改动文件清单

- `security-guard/scripts/tool-surface-check.mjs`、`security-guard/tests/script.test.ts`、`security-guard/README.md`
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. 实现 D1/D2 + 测试 + 反向验证 + 包与根验证 + 真实宿主复跑。
1. 交子代理审阅（只读）→ 关闭 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02，父会话直接实现）

- `scripts/tool-surface-check.mjs`：**D1 疑似注册面** —— 分类放宽为「`defineTool(` → 面内；否则含 **`tools.register(` 或 `parameters:`** → 提示行（不纳入面）」；**D2 零工具包** —— 面内包 `parseTools` 返回 0 时，摘要单列「注意：N 个面内包解析到 0 个工具（可能为动态构造（如 `parameters: <变量>`）或非 `defineTool` 注册面（如 `tools/execute` 中间件）—— 其注册的工具看不见）」+ `--json.zeroToolPackages`。`BOUNDARY` 文案、文件头注释、`collectScope` jsdoc 同步第三类；判定/三分类/退出码语义未动。
- `tests/script.test.ts`：+1 例（**真空白形态**：`tools.register({ name, inputSchema })` 整包不含旧判定字面量 → 必须进提示行；`parameters: dynamicSpec` 的面内包 → 进零工具提示 + `--json.zeroToolPackages`）；既有边界断言按新文案同步。
- `README.md`：补「两条『看不见』边界」段（含 `--json.parametersOnly` **语义比字段名宽**的说明与「注释/字符串误纳」提示）。

## 测试与证据（2026-10-02）

- `security-guard`：`check` exit 0、**119/119 全绿**（原 118 → +1）。
- **反向验证（分离两态）**：① **只撤 D1**（两处 `tools.register(` 判定）→ **恰 1 例红**（新用例）；② 撤 D1+D2 → 同样恰 1 例红（失败断言落在零工具提示）；两次还原后 script sha256 **逐字节一致**（`a98d483e…`）→ 119/119。
- **真实宿主**：27 包 / 49 工具 / 已覆盖 8 / 需关注 8 / 未解析 4 / 未覆盖 29 + 提示行 **6**（措辞更新、名单不变）+ **零工具 2**（`dsh-cordis-host-runner` 为真动态构造；`dsh-tool-call-timeout-policy` 实为 `tools/execute` 中间件 → 措辞已软化为「可能为动态构造或非 defineTool 注册面」）；`exit 1` 不变。
- 全仓：`npm run check` exit 0、`npm run test` **20 包全 `fail 0`**。

## 审阅（子代理 `9dd50e41`）——结论：**有条件通过** → 处置

| 审阅发现 | 处置 |
|---|---|
| D1 噪声可控（宿主 276 包中含 `tools.register(` 28 个、无 `defineTool(` 仅 2 个，均已在提示行；提示行 6 → 6 名单不变） | 已确认 |
| D2 真实宿主 2 例中 `dsh-cordis-host-runner` 为真动态构造；`dsh-tool-call-timeout-policy` 实为中间件 → **归因措辞过强** | 提示措辞已软化为「可能为动态构造或非 defineTool 注册面」（P3） |
| **P2：新用例对 D1 无判别力**（其 fixture 注释里含 `parameters:` 字面量 → 旧判定同样命中；只撤 D1 仍全绿） | 已把 fixture 改成**整包不含旧判定字面量**的真空白形态；重做**只撤 D1** 反向验证 → **恰 1 例红** ✓ |
| P4：`BOUNDARY` / 文件头注释 / `collectScope` jsdoc 仍写旧口径（仅 `parameters:`） | 三处已同步第三类（`BOUNDARY` 含「疑似注册面（含 `tools.register(` 或 `parameters:` 但无 `defineTool(`…）」） |
| P4：README「两条」措辞堆叠、未提 `--json.parametersOnly` 语义 | 已补字段语义与误纳说明 |
| 漏项：注释/字符串误纳 + `parametersOnly` 字段名语义拓宽未立项 | 已立项 **BACKLOG 新条目**（P3） |
| 审阅另确认：`--json` 除新增 `zeroToolPackages` 与两处文案外**全字段逐项相等**；真实宿主结论与改动前一致 | 已确认 |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：见 BACKLOG「疑似注册面判定的两条误纳/语义残余」（P3：注释误纳窄类、`parametersOnly` 字段名语义拓宽）。
