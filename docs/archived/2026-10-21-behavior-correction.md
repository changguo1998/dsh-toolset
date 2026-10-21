# 新插件 behavior-correction（接取条目：docs/BACKLOG.md「新插件 behavior-correction（暂定名：该用专用工具却走 shell 时拦截并指路）」）

状态：关闭　　开启：2026-10-21　　关闭：2026-10-22
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
12. `scripts/test-parallel.sh` —— `default_pkgs` 在 `rule-engine` 之后加 `behavior-correction`（实施时补充：`scripts/test-install.sh:469` 要求它与 `install.sh` 的 `canonical_pkgs` 同序，只改 `install.sh` 会让该检查失败）。

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
- **`inject: []` 与激活顺序（已发生的真实缺陷，2026-10-22）**：原设计不写 `inject`、只读 `ctx.get`，真机
  实测本包 apply 早于 rule-engine 的 `provide`（stderr：`[behavior-correction] warn: ctx.ruleEngine 不可用，工具拦截不会触发`），插件加载了却从未注册消费者；已改为 `inject: ["ruleEngine"]`（硬依赖，
  与 `md-table-check` / `ponytail` / `symbol-normalizer` 同口径），运行期保留存在性判断。
- **清单冲突**：两支都改根 `package.json` / `install.sh` 会冲突；本任务独占这几处（见决策 9），框架任务已按此收窄。
- **包数口径**：仓库文档与 `install.sh` 多处写「29 个插件 / 30 个包」，加包后需全量核对（`AGENTS.md`、两份 README、`scripts/install.sh` 注释）。

## 实现记录

（2026-10-22，worktree `.worktree/behavior-correction`，分支 `dsh/behavior-correction`）

1. **包骨架**：`package.json`（`main: dist/src/main.js`；`check` = 主 tsconfig + tests 两个 program；`test` =
   `node --experimental-transform-types --test 'tests/*.test.ts'`）、`cordis.patch.yml`（`enabled: true`，注释
   写明依赖降级与 `rules` 整体替换）、`tsconfig.json` + `tests/tsconfig.json`（照 `timer`）、`.gitignore`、
   `LICENSE`（复制 `timer`）。
2. **`src/main.ts`**：`name` / `inject: []` / `GUARD_SOURCE` / `Config` / `RuleSpec` / `ToolGuardContext` /
   `ToolGuardDecision` / `DEFAULT_RULES` / `resolveConfig` / `compileRules` / `toolText` / `matchRule` / `apply`。
   判定文本按决策 04 抽取（`bash` / `pwsh` 取 `arguments.command`，其余 `JSON.stringify`，序列化失败按空串）；
   规则编译期逐条校验，非法条目 / 非法正则各告警一行并跳过（非法正则跳过**整条**规则），其余照常；命中第一条
   规则即返回 `deny`，未命中返回 `undefined`（不返回 `allow`）；没有任何匹配条件的规则永不命中。
   服务读取走 `readEngine`：直接属性（`try` 包住，严格模式下未注入服务直读会抛）→ `ctx.get`；`enabled: false`
   不注册；服务缺席 / 注册被拒各告警一行并降级；注销函数包 `once`，同时挂 `ctx.on("dispose")`（订阅抛错只告警）。
3. **`tests/main.test.ts`** 24 例：契约符号 / 缺省规则命中与放行 / 工具限定 / 大小写与 flags / 规则顺序 /
   配置替换与空数组 / `enabled: false` / 非法规则与非法正则 / `config.rules` 非数组 / 服务缺席与 `ctx.get` 抛错 /
   注册被拒 / dispose 幂等 / `toolText` 抽取（含循环引用与非字符串 `command`）。
4. **`tests/contract.test.ts`**：变量说明符 `import("@dsh-toolset/rule-engine")`；可解析时校验
   `CONSUMER_SOURCES` 含 `tools/pre-execute`、`isConsumerSource` 为真、`RuleEngine` 实例的 `registerConsumer`
   接受「`sources` + `guard`、不带 `decide`」的注册；不可解析时 skip。本分支（`c1b91e0`）尚无框架 guard 面，
   故实际 skip。
5. **清单同步**：根 `package.json` 的 check/build 链、`scripts/install.sh` 的 `canonical_pkgs`、
   `scripts/test-parallel.sh` 的 `default_pkgs`、`AGENTS.md`（插件清单 3 处 + 包数 2 处 + 轻量包清单）、
   根 `README.md` / `README.zh.md`（组成表一行 + 目录树一行 + 包数 + 复用审计覆盖口径 22/30、未入表 8 个）。
6. **环境**：本 worktree 无 `node_modules`，`~/.npm` 在沙箱下只读，故用
   `npm install --cache ../tmp/npm-cache` 装本包依赖；其余 30 包软链主 worktree（同一提交 `c1b91e0`）的
   `node_modules` 后跑全仓 check / build / test（软链在 `node_modules`，已被 gitignore；验证后已删除软链，避免后续 `npm install` 跟随软链写进主 worktree）。

## 测试与证据

以上命令均在 `.worktree/behavior-correction` 执行（2026-10-22）。

| 命令 | 结果 |
| --- | --- |
| `npm --prefix behavior-correction run check` | 通过（两个 program 均无输出） |
| `npm --prefix behavior-correction test` | tests 25 / pass 24 / fail 0 / skipped 1（skip = 真包契约探针，本分支解析不到 `@dsh-toolset/rule-engine`） |
| 反向验证：guard 恒返回 `undefined` | 8 例转红（含「缺省规则：bash 里跑 herdr → 拒绝并指向 herdr_pane」）；恢复后 24 例全绿 |
| `npm --prefix behavior-correction run build` | 通过（产出 `dist/src/main.js`） |
| 根 `npm run check` | exit 0（31 个包） |
| 根 `npm run build` | exit 0 |
| 根 `npm test` | 首次运行 `timer` 1 例失败（`tests/timers.test.ts:189` 的 55 ms 间隔断言，并行负载下计时抖动），重跑全绿：31 包 0 失败，`behavior-correction` pass 24 |
| `sh scripts/test-install.sh` | 全部 84 项通过（含 `canonical_pkgs` ↔ `default_pkgs` 同序、↔ 根 check/build 链一致） |
| 对端契约探针（一次性脚本，直接 import 并行 worktree `.worktree/rule-engine-guard` 的 `rule-engine/src/main.ts`） | `CONSUMER_SOURCES` 含 `tools/pre-execute`、`isConsumerSource` 为 true、`RuleEngine.registerConsumer` 无告警接受本注册形态、`guardTool` 对 `bash` + `herdr` 返回本包的 `deny`、对 `ls` / `read` 返回 `undefined` |
| 端到端探针（同上，把框架 `RuleEngine` 实例作为 `ruleEngine` 服务交给本包 `apply`） | 注册零告警；`bash` + `herdr pane list` → deny（理由含 `herdr_pane`）；`ls -la` → `undefined`；`read` + herdr 路径 → `undefined`；调用返回的注销函数后再问同一调用 → `undefined`（确认注销生效） |

**未验证（如实记录）**：真机拦截效果。本分支没有 rule-engine 的 guard 面，端到端要等两支合并并在 profile
挂载 `behavior-correction` 后执行（决策 10；profile 属仓库外，需用户批准）。

## 偏差

1. **`scripts/test-parallel.sh` 属计划外改动**（清单第 12 条，计划补记）：`scripts/test-install.sh:469`
   要求 `canonical_pkgs` 与 `default_pkgs` 同序，只改 `install.sh` 会让该检查失败；属机械同步，无行为影响。
2. **`docs/ARCHITECTURE-REUSE.md` 未改**：其中「本仓 29 个模块」「已审计 29 个全量」等口径因新增包而少 1，
   但该文件不在本次清单内（计划只列 `AGENTS.md` 与两份 README）。已在 `docs/BACKLOG.md` 追加条目交后续
   整理；两份 README 只把模块总数改成 30、覆盖数 22 不变、未入表数 7 → 8。
3. **真机验收未做**：依赖并行任务的框架合并与 profile 挂载（仓库外，需用户批准），按决策 10 由主线在合并后执行。

## 收尾

本任务按计划第 5 步**不关闭条目、不归档本文件**：两支合并（先框架、后本包）后由主线关闭条目、把本文件移入
`docs/archived/`，并在 profile 挂载后做真机验收。`docs/STATUS.md` 未改（用户择时更新）；profile 依赖与
`pnpm install` 属仓库外，待用户批准。

## 真机验收（2026-10-22，合并后另起新会话，profile fff）

- 环境：main 合并 `73af605`（本包）+ `907e066`（ruleEngine 硬依赖修正，`inject: ["ruleEngine"]`）；
  profile `fff` 以 `- insert:` 挂载本包，位于 `rule-engine` 之后。
- 结果：`bash` + `herdr pane list` → 调用失败，回执「bash 里不要跑 herdr 命令: 改用 herdr_pane 工具
  （pane / tab 操作）或 herdr_integration 工具」；`bash` + `echo herdr` → 同样被拒；
  `bash` + `ls -la` → 正常执行并列出目录。
- 告警：活动区两条 `[rule-engine] warn: 消费者 "behavior-correction" 拒绝工具 bash`。
- 真机发现并修正的缺陷（已记入「风险」节）：原设计不写 `inject`、只读 `ctx.get`，真机 stderr 为
  `[behavior-correction] warn: ctx.ruleEngine 不可用，工具拦截不会触发` —— 本包 apply 早于 rule-engine
  的 `provide`，插件加载但从未注册；修正为 `inject: ["ruleEngine"]` 后真机通过。
