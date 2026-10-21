# 新插件 behavior-correction（接取条目：docs/BACKLOG.md「新插件 behavior-correction（暂定名：该用专用工具却走 shell 时拦截并指路）」）

状态：规划　　开启：2026-10-21　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
与 rule-engine「消费者 guard 面」任务**并行实现**（用户 2026-10-21 指令「分开并行实现」），接口按对方追踪文档 `rule-engine/docs/implementation/2026-10-21-consumer-guard.md` 的决策 2 至 6 钉死。

## 目标

新轻量包 `behavior-correction/`：把「该用专用工具却走 shell」的调用在执行前拦下并指出正确工具。实现方式是向 rule-engine 注册一个 `tools/pre-execute` 的 guard 消费者，按自身 `config` 的规则表判定（工具名 + 参数），命中返回 `{kind:"deny", reason}`；缺省规则为 `bash` 命令含 `herdr` → 拒绝并提示 `herdr_pane`。

## 调研

（来源：`rule-engine/docs/implementation/2026-10-21-consumer-guard.md`、`rule-engine/src/{types,main}.ts`、`timer/` 包模板、`auto-approve/src/gate.ts`、条目原文）

1. **对端契约（并行分支钉死）**：节点 `"tools/pre-execute"` 仅消费者可用；注册面 `registerConsumer({ id, sources: ["tools/pre-execute"], guard })`（`ruleEngine` 服务，经 `ctx.get("ruleEngine")`）；`guard(context)` 收 `ToolGuardContext { name, arguments, callId?, sessionId?, resumed? }`，返回 `ToolGuardDecision { kind: "allow" } | { kind: "deny"; reason: string }` 或 `undefined`（弃权），可同步可 Promise；rule-engine 按注册顺序串行调用、任一 `deny` 胜出、异常按弃权处理（fail-open）。带该节点时**不得**设 `delivery` / `dedupeInRecord` / `directWrite` / 冷却，也不得给 `decide`。
2. **包模板**：`timer/package.json`（`main: dist/src/main.js`、`build` / `check` / `test` 脚本、`files`、`dsh.bundle.patch`）+ `timer/cordis.patch.yml`（`- insert: - id / name`）；`src/main.ts` 导出 `name` / `inject` / `provide`（可选）/ `Config` / `apply`，无 default export（`rule-engine/src/main.ts` 头部注释即契约说明）。
3. **服务读取口径**：插件不把 `ruleEngine` 写进 `inject`（它不是硬依赖，缺了要降级而不是整体不加载），经 `ctx.get("ruleEngine")` 受保护读取（`rule-engine/src/main.ts:234-240` 同口径）。
4. **规则判定素材**：`bash` / `pwsh` 的命令在 `arguments.command`；其它工具的参数只能整体字符串化。`compileMatcher` 是 rule-engine 导出的纯函数，但引入它需要包间依赖（profile 里 `link:` + 安装），对只有 keywords / regex 的需求不划算。
5. **仓库清单位置**：根 `package.json` 的 `check` / `build`（逐包 `npm --prefix …`）、`scripts/install.sh` 的 `canonical_pkgs`、`AGENTS.md` 包列表、根 `README.md` / `README.zh.md` 插件清单；`docs/STATUS.md` 由用户择时更新。
6. **仓库外**：profile `~/.dsh/profiles/fff` 的 `package.json` 依赖与 `cordis.patch.yml` 条目、`pnpm install` 由主线在合并后执行（需用户批准）。

## 决策

01. **匹配器自带**（选项 a 自带 keywords / regex / flags；b 复用 `@dsh-toolset/rule-engine` 的 `compileMatcher`）。**选 a** —— 只需「关键词或正则任一命中」，自带约 20 行，避免给插件加包间依赖与 profile 安装步骤；与 rule-engine 的匹配语义差异（谓词、空条件语义）不适用于本插件。
02. **配置形态**：`Config = { enabled?: boolean; rules?: RuleSpec[] }`；`RuleSpec = { id: string; tool?: string | string[]; match?: { keywords?: string[]; regex?: string[]; flags?: string }; reason: string; description?: string }`。`enabled` 缺省 true；`rules` 缺省 = 内置规则表；给 `rules` 即整体替换（不做合并），空数组 = 不拦任何东西。
03. **缺省规则**：`{ id: "no-herdr-in-bash", tool: "bash", match: { keywords: ["herdr"] }, reason: "bash 里不要跑 herdr 命令: 改用 herdr_pane（pane / tab 操作）或 herdr_integration 工具", description: "herdr CLI 有专用工具，走 bash 会绕过插件面板与状态绑定" }`。
04. **匹配文本**：`tool` 字段限定的工具（缺省 = 任意工具）；文本 = `name + " " + 命令或参数串`，其中 `bash` / `pwsh` 优先取 `arguments.command`（字符串），其余工具用 `JSON.stringify(arguments)`（失败取空串）。正则与关键词都对这段文本判定（大小写不敏感）。
05. **命中口径**：规则表按声明顺序取**第一条**命中的启用规则（`RuleSpec` 无 `enabled`，需要禁用就整条删除或整体关插件）；未命中 → 返回 `undefined`（弃权），不返回 `allow`（避免无谓否决他人）。
06. **降级**：`ctx.get("ruleEngine")` 缺失或没有 `registerConsumer` → `warn` 一行并返回（不拦截、不抛错）；注册返回的注销函数在插件卸载时调用（`ctx.on("dispose")` 若可用，否则交给宿主生命周期）。
07. **可见性**：插件自身只在「服务缺失 / 注册被拒 / 配置非法」时 `warn`；拒绝时的告警由 rule-engine 统一打（「消费者 <id> 拒绝工具 <name>」）。不写审计、不落 memory-base。
08. **测试方式（并行前提）**：用**结构面假服务**（`{ registerConsumer(input) { captured = input; return () => {} } }`）驱动 `apply`，直接调用 `captured.guard(ctx)` 断言返回值；不 import rule-engine 运行时类型、不等框架分支合并即可全绿。另加一条「真包契约」测试：`import("@dsh-toolset/rule-engine")` 存在时校验 `CONSUMER_SOURCES` 含该节点与 `registerConsumer` 接受该注册（不存在时 skip，写法照 `session-title-cutoff` 的 real-helper 契约测试先例）。
09. **清单同步归属**：本任务独占根 `package.json` / `scripts/install.sh` / `AGENTS.md` / 根 `README.md` / `README.zh.md` 的改动（框架任务不动这些文件，避免并行冲突）。
10. **合并与验收顺序**：两支各自合并到 main（先合框架、再合 bc，或反之），`npm run build` 后在 profile 挂载 bc 做真机验收（拒绝 `bash` 里的 `herdr`、放行 `ls`、回执含 `herdr_pane`）；profile 改动属仓库外，由主线获批准后执行。

## 规划

### 计划改动文件清单

01. `behavior-correction/package.json` —— 照 `timer/package.json`：`@dsh-toolset/behavior-correction`、`main: dist/src/main.js`、`build` / `check` / `test` 脚本、`files`、`dsh.bundle.patch`。
02. `behavior-correction/cordis.patch.yml` —— `- insert: - id: behavior-correction / name: '@dsh-toolset/behavior-correction'`，注释写明依赖 `ruleEngine` 服务、缺服务降级。
03. `behavior-correction/tsconfig.json` —— 照同目录轻量包（`module: nodenext` + strict + `noUncheckedIndexedAccess`）。
04. `behavior-correction/src/main.ts` —— bundle 契约（`name` / `inject: []` / `Config` / `apply`）+ 规则表（内置缺省 + 配置替换）+ 匹配（keywords / regex）+ 参数抽取 + `registerConsumer` 注册 + 降级告警。
05. `behavior-correction/tests/main.test.ts` —— 假服务驱动的用例：缺省规则命中 `bash` + `herdr pane list`、放行 `bash` + `ls`、非 `bash` 不命中、`tool` 限定、配置替换与空数组、`enabled: false`、正则非法告警、缺服务降级、注册被拒告警。
06. `behavior-correction/tests/contract.test.ts` —— 真包存在时校验节点与注册形态（否则 skip）。
07. `behavior-correction/README.md` —— 定位、配置、缺省规则、与 rule-engine guard 面的关系、限制（只看 shell 命令文本、不解析参数语义）。
08. 根 `package.json` —— `check` / `build` 各追加 `npm --prefix behavior-correction run …`（放在 `rule-engine` 之后）。
09. `scripts/install.sh` —— `canonical_pkgs` 在 `rule-engine` 之后加 `behavior-correction`。
10. `AGENTS.md` + 根 `README.md` / `README.zh.md` —— 包列表与插件清单各加一条（两 README 逐节同构）。
11. `docs/BACKLOG.md` —— 条目状态与口径；本文件。

**明确不做**：审计；`/bc` 之类的人工命令面；按参数 JSON 的精确语义解析（只做文本匹配）；profile 挂载与 `pnpm install`（仓库外，主线获批准后做）；`docs/STATUS.md`；框架侧文件（`rule-engine/*` 由并行任务负责）。

## 步骤

1. 建包骨架（1-3）+ `src/main.ts`（4），用假服务驱动到测试通过。
2. 测试（5-6）+ 反向验证（把 guard 恒返回 `undefined` → 缺省规则用例转红）。
3. `npm --prefix behavior-correction run check` / `test` / `build`；全仓 `npm run check` 与 `npm run build`（确认清单同步无误）。
4. 清单同步（8-10）+ README（7）。
5. 提交；两条目在合并后由主线关闭（本任务不关条目、不移归档）。

## 验收

- `bash` + `{"command":"herdr pane list"}` → `{ kind: "deny", reason: <含 herdr_pane> }`；`bash` + `{"command":"ls"}` → `undefined`；`read` + 任意参数 → `undefined`。
- 配置替换生效（自定义 `rules` 后内置规则不再生效）；`rules: []` 不拦；`enabled: false` 不拦；`tool` 限定只对指定工具判定。
- 非法正则只告警、该条跳过，其余规则照常。
- 缺 `ruleEngine` 服务 → 告警一次、`apply` 不抛错；`registerConsumer` 返回函数被保存。
- `check` / 包内测试 / `build` / 全仓 `check` 与 `build` 全绿；`AGENTS.md` 与两份 README 的包清单一致（29 → 30 包）。
- 真机（合并 + profile 挂载后）：`bash` 里跑 `herdr` 被拒且回执指向 `herdr_pane`；`ls` 正常。

### 风险与待确认

- **对端契约漂移**：框架分支若改接口（字段名 / 弃权语义），本包测试仍绿但真机不生效；合并后必须做一次端到端，契约测试的第 6 项即为此设的探针。
- **`inject: []` 与 cordis 严格模式**：读服务用 `ctx.get`，不写 `inject`；若真机报「cannot get property」，改为 `inject: ["ruleEngine"]` 并把降级改到 `apply` 内的存在性判断（文档记录）。
- **清单冲突**：两支都改根 `package.json` / `install.sh` 会冲突；本任务独占这几处（见决策 9），框架任务已按此收窄。
- **包数口径**：仓库文档与 `install.sh` 多处写「29 个插件 / 30 个包」，加包后需全量核对（`AGENTS.md`、两份 README、`scripts/install.sh` 注释）。
