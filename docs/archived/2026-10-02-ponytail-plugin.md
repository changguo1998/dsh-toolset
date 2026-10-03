# 以「封装插件」方式接入 ponytail（接取条目：`docs/BACKLOG.md`「以『封装插件』方式接入 ponytail（推荐路径 a）」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本次唯一过程记录与文档变更落点；计划外文件不改。

## 目标

把 ponytail 的「懒资深工程师」决策阶梯（7 级：YAGNI → 本仓复用 → 标准库 → 平台特性 → 已装依赖 → 一行 → 最少代码）做成**本仓的可装载插件**：可开关、可注入、可审计；**不搬** `hooks/*.js`（DSH 无该钩子面），不做 benchmarks。

## 决策

- **D0（前置核对，编码前必做）**：读 `rule-engine/docs/DESIGN.md` 与**最小插件**（`session-title-cutoff/`、`symbol-normalizer/`）确认：① 文本注入的**既有机制**（rule-engine 规则注入 / 会话启动注入 / skill 装载，优先复用现成面，不新造）；② 斜杠命令的注册契约（TUI 侧 or 包内工具）；③ `cordis.patch.yml` + `dsh.bundle` 的最小可用模板。
- **D1（包结构与契约）**：新建 `ponytail/`（`@dsh-toolset/ponytail`），含 `package.json`（`dsh.bundle`）、`cordis.patch.yml`、`src/index.ts`（导出 `name` / `inject` / `Config` / `apply`）、`tests/`、`README.md`、`docs/DESIGN.md`；风格对齐既有 19 包。
- **D2（阶梯文本自带副本 + 归属）**：`ponytail/src/ladder.ts`（或 `skill/`）内置阶梯文本**副本**，头部注明来源（`~/GithubRepos/ponytail` v4.10.3，`AGENTS.md`）与 **MIT 许可**、以及「上游更新需人工同步」。
- **D3（注入方式）**：按 D0 结论二选一并写进 DESIGN：① 经 `rule-engine` 注册一条「ponytail 模式」注入（开启时每回合注入阶梯要点，关闭时不注入）；② 若 rule-engine 不适用 → 用包内 skill/上下文注入面。**默认关闭**（`enabled: false` 或 `/ponytail` 显式开启），避免与 `karpathy-guidelines` 双份注入。
- **D4（命令面，最小化）**：`/ponytail`（on/off/status）+ `/ponytail-audit`（对最近一次改动做「过度工程」审查：列出可删的抽象/依赖/样板）。若命令契约成本高 → **降级**为「仅 `/ponytail` 开关 + 配置项」，并在终报说明降级理由。
- **D5（与 karpathy-guidelines 的去重）**：README/DESIGN 写明二者**重叠**（简单优先/外科手术式改动）与**差异**（ponytail 的阶梯更激进：先问「要不要做」；有 7 级顺序；有 audit/debt/gain 视角），并声明**默认不同时开启**。
- **D6（测试与验证）**：① 注入开关：on → 文本含 7 级关键词；off → 不注入（两态反向验证）；② 命令行为（若 D4 保留）；③ 反向验证（撤注入 → 用例必红）；④ 包与根 `check` / `build` / `test`；⑤ 真机：`npm run build` → 重启 `dsh --profile fff` 目视确认。
- **D7（文档与安装面）**：包 `README.md`；根 `README.md` / `README.zh.md` 插件表加一行（双语同构）；`scripts/install.sh` 的插件清单 **20 → 21**；`docs/STATUS.md` 由用户择时（不动）。
- **D8（不做）**：不搬 `hooks/*.js` / `commands/*.toml` / `gemini-extension.json`；不做 `ponytail-mcp`（MCP 路径另行评估）；不做 benchmarks/宣传物料；不改上游仓。

## 计划改动文件清单

- 新增：`ponytail/package.json`、`ponytail/cordis.patch.yml`、`ponytail/src/index.ts`（+ 必要模块如 `ladder.ts`）、`ponytail/tests/*.test.ts`、`ponytail/README.md`、`ponytail/docs/DESIGN.md`
- 修改：根 `README.md`、`README.zh.md`、`scripts/install.sh`（必要时 `tsconfig`/工作区清单）
- `docs/BACKLOG.md`（标进行中 → 关闭）、本追踪文档

## 待办

1. **D0 前置核对**（读 rule-engine / 最小插件 / 模板），把结论回填本文件。
1. 实现 D1-D4（分阶段落盘，每阶段跑 `check` + 包内 `test`）。
1. 测试与反向验证（D6）→ 文档与安装面（D7）。
1. 交子代理审阅（只读）→ 关闭 → 归档 → 提交（一次提交）。

## 实现记录（2026-10-02，父会话直接实现）

- **新增包 `ponytail/`**（`@dsh-toolset/ponytail`，21 包）：`package.json`（`dsh.bundle.patch`）+ `cordis.patch.yml`（insert 自身，缺省 `enabled: false`）+ `index.ts`（透出 `src/main.ts`）+ `src/main.ts`（`name` / `inject: ["ruleEngine"]` / `Config` / `apply`）+ `src/ladder.ts`（阶梯文本**自带副本**，注明上游 `~/GithubRepos/ponytail` v4.10.3 与 MIT）+ `tests/main.test.ts`（5 例）+ `README.md` + `docs/DESIGN.md` + `.gitignore` + `LICENSE`。
- **注入语义**：`apply` 经 `ruleEngine.registerConsumer({ id: "ponytail", sources, delivery, dedupeInRecord, decide })` 注册；**开启** → 返回阶梯正文 + 摘要；**关闭** → `decide` 返回 `null`；返回 dispose 注销。
- **审阅后的两处硬化（P1）**：① `delivery` 缺省由 `inject` 改为 **`steer`**（真机上 agent 非 live 时 `inject` 会被丢弃且不重试），`sources` 缺省由 `["session-start"]` 改为 **`["session-start", "step-end"]`**（兜底），并开放 `delivery` 配置；② 补 `ponytail/.gitignore`（`node_modules` / `dist` 等，避免 `dist/**` 误入库）与 `LICENSE`（`files` 同步）。
- **接线**：根 `package.json`（check/build 链）、`scripts/test-parallel.sh`（缺省包列表）、`scripts/install.sh`（`canonical_pkgs`）、根 `README.md` / `README.zh.md`（插件表 + 目录树 + 计数 19 → 20）、`AGENTS.md`（首段清单 / 委托列表 / install 说明 / 模块数 20 / 结构与约定清单）。
- **D4 降级并记录**：命令面（`/ponytail`、`/ponytail-audit`）本批**不做**，理由写入 `ponytail/docs/DESIGN.md`（slash 命令注册属 TUI/宿主契约，成本高于本条目核心价值；audit 另开条目评估）。

## 测试与证据（2026-10-02）

- `ponytail`：`check` exit 0、`build` exit 0、`test` **5/5 全绿**（缺省关闭 / 阶梯关键词 / 开关两态 + dispose / rule-engine 缺席告警 / 契约符号）。
- **反向验证**：把 `resolveConfig.enabled` 恒置 true → **2 例红**；还原后 sha256 **逐字节一致**（`a6c43f14…`）→ 5/5。
- **全仓**：`npm run check` exit 0（0 error TS）；`npm test` **21 包全 OK**（`ponytail pass 5 fail 0`）；`npm run build` 通过。
- **审阅探针（`efc0e8e8`）**：真 `RuleEngine` 下 enabled=true → 1 段 `consumer:ponytail`/`delivery:inject`/摘要匹配/0 告警；缺省 → 0 注入；恢复态投影已有 1 条 → 0 注入；dispose 后不再注入。

## 审阅（子代理 `efc0e8e8`）——结论：**有条件通过** → 处置

| 审阅发现 | 处置 |
|---|---|
| 契约同形（`dsh.bundle` / insert / index 透出 / 契约符号）、`inject` 与 rule-engine `provide` 一致 | 已确认 |
| 注入语义匹配（`sources` / `delivery` / `dedupeInRecord` 均真实存在且语义一致） | 已确认 |
| 反向验证 ≥1 例红、还原 5/5 | 已确认 |
| **P1①**：真机风险 —— `session-start` + `delivery: "inject"` 在 agent 非 live 时被丢弃且不重试（先例用 steer + 兜底节点） | 已改 `delivery` 缺省 **`steer`** + `sources` 缺省加 **`step-end`** 兜底，并开放配置；**真机验证仍需重启 `dsh --profile fff`**（见残余） |
| **P1②**：缺 `ponytail/.gitignore` → `dist/**` 会入库 | 已补 `.gitignore`（另补 `LICENSE` 并入 `files`） |
| P2：README/AGENTS 计数 19 → 20 | 已更新（双 README + AGENTS 四处） |
| P2：D4 命令面未实现且理由未落文档 | 已写入 `ponytail/docs/DESIGN.md` |
| P3：apply 返回同步 disposer（其余包多为 void）→ 宿主是否回收未验证 | 记残余（真机重启时观察重注册行为） |

## 关闭记录

- 条目从项目级 `docs/BACKLOG.md` 清理并重编号；追踪文档移入 `docs/archived/`。
- 残余：① **真机验证未做**（需人工重启 `dsh --profile fff` 后发一条消息，看会话记录是否出现 `[ponytail]` 注入段与是否有「非 live」告警）——已按审阅把 delivery/sources 改为 `steer` + `step-end` 兜底；② disposer 回收行为待真机确认；③ `/ponytail-audit` 命令面与「与 `karpathy-guidelines` 的自动互斥」未做（可另开条目）。
