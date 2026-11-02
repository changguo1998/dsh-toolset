# security-guard 整理 (所属总追踪: `docs/implementation/2026-10-28-history-cleanup.md`)

状态: 规划
本文件是 security-guard 的分包追踪文档; 主分支写目标 / 现状 / 实现规划, 分支 agent 只追加「实现记录」「偏差」「测试与证据」, 不改实现规划与总追踪.

## 目标

阶段 2 测试锚定: 给 `security-guard` 补单元锚点与集成层, 落地 `test:integration` / `test:coverage`, 记录改前改后覆盖率, 为阶段 3 的代码整理提供回归网.

阶段 3 代码整理: 按总追踪 5.1 的步骤改本包, 行为不变.

## 现状

- 单元层: `tests/` 下 4 个 `.test.ts` (`blacklist.test.ts` / `guard.test.ts` / `script.test.ts` / `sensitive.test.ts`); 阶段 1 末 `pnpm -C security-guard run test` 通过.
- 集成层: 无 `tests/integration/`; `apply` 与宿主接线未验证.
- 覆盖率基线 (阶段 1 末): 行 63.6% (1842/2896); 分支 90.9% (369/406).
- 脚本: 只有 `test`; 缺 `test:integration` / `test:coverage`.
- 专项: 复核 `tests/script.test.ts:509` 条件式 `skip`; `tests/guard.test.ts` 的 `herdr_use` 负断言保留
- 阶段 3 开工前: 全量 `check` / `test` / `test:coverage` 通过, 明细见阶段 2 证据.

## 实现规划

### 测试

- 基线: 在分支上先跑 `pnpm -C security-guard run test`, 记通过数与耗时; 再按现状记录覆盖率基线.
- 单元锚点: 对 `src/index.ts` 的导出与判定分支补锚点, 优先未被现有用例走到的分支与错误路径; 现有断言不改语义.
- 集成层: 新增 `tests/integration/plugin.test.ts` 与 `tests/assemble.ts` (不以 `.test.ts` 结尾, 三个假面形状与 4.2 一致), 装配本包 `apply` 与宿主接线: 工具注册名与 `execute` 的 canonical 值、`output.render` 投影、事件消费者注入内容、服务 provide / get; 落盘写临时目录.
- 脚本: `package.json` 加 `test:integration` = `node --experimental-transform-types --test 'tests/integration/*.test.ts'`; 加 `test:coverage` = 下面的命令.
- 覆盖率: 跑 `test:coverage` 并把改前 / 改后表写「测试与证据」; 只升不降, 删代码除外.

```sh
rm -rf ../tmp/cov-security-guard && mkdir -p ../tmp/cov-security-guard && NODE_V8_COVERAGE=../tmp/cov-security-guard node --experimental-transform-types --test 'tests/*.test.ts' 'tests/integration/*.test.ts' && node ../dev/coverage/report.mjs tmp/cov-security-guard tmp/cov-security-guard/report.json
```

- 专项: 复核 `tests/script.test.ts:509` 条件式 `skip`; `tests/guard.test.ts` 的 `herdr_use` 负断言保留.
- 验收: `pnpm -C security-guard run check` / `test` / `test:integration` / `test:coverage` 全绿; 本文件追加「实现记录」「测试与证据」; 在分支提交, 提交信息 `test: 补 security-guard 测试锚定`.

### 代码

- 分支 `history-cleanup/03-code-security-guard`, worktree `.worktree/03-code/security-guard`; 只改本包源码、本包测试的 import、`package.json` / `pnpm-lock.yaml` 与本文件.
- 开工: 在 worktree 的本包目录跑 `pnpm install --frozen-lockfile`; 有 `link:` 依赖时先在 worktree 里构建被依赖包 (`pnpm -C <被依赖包> run build`), 再跑本包 `check`.
- 顺序: 删失效 → 并定时器族 → 拆长文件 → 收拢判断 → 改注释; 每步跑 `pnpm -C security-guard run check` 与 `pnpm -C security-guard run test`.
- 任务:
  - 拆 `src/index.ts` (1378 行): 规则表 / 命令解析 / 判定分层.
- 验收: `pnpm -C security-guard run check` 与 `pnpm -C security-guard run test` 全绿, 用例断言不因组织改动而改; 行为不变 (工具名、参数面、`output.render` 投影、配置键、注入文案、帧内容都不动).
- 提交: `refactor(security-guard): <动作>`, 一个逻辑一笔; 不改本节实现规划, 不改总追踪与阶段追踪.

### 包文档

- 分支 `history-cleanup/04-package-docs-security-guard`, worktree `.worktree/04-package-docs/security-guard`; 只改本包文档, 不动 `src` / `tests` / 配置文件.
- 文件: `README.md` / `docs/BACKLOG.md`.
- `README.md`: 现有 6 个二级标题按总追踪 3.9 归并为六节 `## 定位` / `## 能力` / `## 配置` / `## 用法` / `## 边界` / `## 测试`; 无配置项可省 `## 配置`; 只改节名、合并重复段落, 不删内容、不新增结论.
- 命令: 正文与示例里的 `npm` 一律改 `pnpm`, 与根 `package.json` 的脚本名一致.
- 术语: 按 `docs/GLOSSARY.md` 与总追踪 6.6 校一遍本包术语、界面名与旧称.
- `docs/BACKLOG.md`: 同文件的命令与术语同步改; 条目内容、状态与顺序不动.
- `README.md` 的「状态栏」改「状态列」.
- 验收: 六节齐 (无配置可省)、正文命令全 `pnpm`、本包非归档断链 0、符号变体 0、术语与 `docs/GLOSSARY.md` 一致; `format` 后自查 diff; 文档改动不跑代码门禁.
- 提交: `docs(security-guard): 归并包文档为六节`; DESIGN / BACKLOG / 专项改动按文件分笔或并入同一笔.

## 实现记录

- 基线 (本分支实测): `pnpm -C security-guard run test` 142 例 (141 通过 / 1 跳过, 跳过的是发布形态用例: `dist` 未构建), `check` 通过; 覆盖率行 97.5% (1538/1578) / 分支 90.9% (369/406)。
- 单元锚点 (只加用例, 既有断言未改语义):
  - `tests/blacklist.test.ts` +7 例: 命令切段 (引号内不切 / 空段丢弃 / 未闭合引号)、rm 的 env 前缀与 `--` 分隔符、chmod 的 env 前缀与选项位、systemctl 的前缀词链、heredoc 三条前置条件各自放行、`eval` / shell `-c` 递归与深度上限、非法规则源在 `scope=command` 与整段正则两条路径都按命中处理。
  - `tests/sensitive.test.ts` +5 例: 家目录三种单独写法与引号 / 尾斜杠保留、`basenameOf` 三种输入、glob 的 `**` 跨目录与 `?` 单字符及 `/**` 目录本身命中、字面条目含 `/` 前缀子树与 basename 两条分支、路径提取空命令与去重。
  - `tests/guard.test.ts` +6 例: `provide` 声明、`resolveGuardConfig` 缺省归一与用户层编号 (`user-rule-N` / `user-path-N` / `allowed-N`)、放行名单非法条目忽略与通配语义、挂载 disposer 的退化形态 (宿主 `on` / `tools.guard` 返回非函数)、`apply` 无 `provide` 面时的防御路径。
- 集成层: 新增 `tests/assemble.ts` (装配器, 不以 `.test.ts` 结尾) 与 `tests/integration/plugin.test.ts` (14 例)。装配器按 4.2 的三假面口径给出工具面 (`register` + `tools.guard`)、事件面 (`on` + waterfall 模拟)、服务面 (`provide` / `get`, 同名重复注册抛错)。用例覆盖: 服务面 `guard` 注册与 `ctx.get` 同一实例、canonical 三方法、单调守卫路径 (字符串 / undefined)、waterfall 降级路径 (`{ kind: "deny", reason }` 与放行下传恰一次)、挂载日志两种形态、拒绝日志取前两行、`inspectCommand` 来源标注与 `recent()`、`policy()` 快照、未登记工具三态、临时目录 fixture 上的读侧 / 写侧 / 命令内路径三种回执措辞、重复挂载的 provide 冲突。
- 专项: `tests/script.test.ts` 的发布形态用例, 探测表达式提到文件顶层 (`DIST_BUILT`), 跳过原因补上补法 (`pnpm -C security-guard run build`); `tests/guard.test.ts` 的 `herdr_use` 负断言保留未动。
- 脚本: `security-guard/package.json` 增加 `test:integration` 与 `test:coverage`, 覆盖率命令与其它包同构 (`report.mjs` 参数 `tmp/cov-security-guard`)。
- 未改 `src`。
- 阶段 3 代码整理: 按「实现规划 / 代码」把 `src/index.ts` (1377 行) 按职责拆开, 对外面仍是 `src/index.ts` 单入口 (拆出的文件只从入口 re-export, 不新增对外入口):
  - `src/tool-registry.ts` (270 行, 规则表): 官方工具集 (`SHELL_TOOLS` / `RUN_CODE_TOOLS` / `FILE_TOOLS` / `FILE_PATH_KEYS` / `WRITE_FILE_TOOLS`)、插件文件与命令登记表及查表、未登记工具三类键集、`UNKNOWN_TOOL_KEY_DEPTH`、遍历资源上限 (`MAX_WALK_*`)、`TOOL_SURFACE`、`toolOperation`。
  - `src/arg-scan.ts` (243 行, 命令解析): 参数遍历与完整键路径、未登记工具键面 / 值面扫描、插件文件与命令参数提取、`firstString` / `asStringRecord`。
  - `src/config.ts` (202 行, 配置): `SecurityGuardConfig` / `Config`、`ResolvedConfig`、`resolveGuardConfig`、未登记工具放行名单的编译与匹配。
  - `src/receipt.ts` (190 行, 原 61 行, 回执文案): 并入未登记工具拦截回执、参数面截断回执、来源标注行、命中键路径列表上限 (`MAX_RECEIPT_*`) 与 `receiptToolName` / `receiptLabelLine`。
  - `src/engine.ts` (450 行, 判定): `GuardEngine`、`GuardRecord` / `PolicySnapshot` / `GuardService`、`MAX_RECORDS`。
  - `src/index.ts` (176 行): bundle 契约 (`name` / `provide` / `inject` / `Config`) + 宿主挂接 (`createSecurityGuard` / `apply`) + 全部 re-export。
- 逐行搬运: 新文件由旧文件的行区间切片生成, 除新增 `export` 关键字与模块头 / import 行外没有改写; 行多重集核对结果见「测试与证据」。
- 两处配套改动 (行为不变): `tests/guard.test.ts` 的「登记表 commandPaths 防呆」读源文件路径由 `../src/index.ts` 改为 `../src/tool-registry.ts` (断言与用例名未动); `scripts/tool-surface-check.mjs` 的仓库形态回退解析改为把 `src/index.ts` + `src/tool-registry.ts` 拼起来喂同一个解析器 (报告的 `surfacePath` 仍是入口, dist 判旧取两文件 mtime 最大值)。
- 阶段 4 包文档 (本分支): 只改 `security-guard/README.md` 与 `security-guard/docs/BACKLOG.md`, 未动 `src` / `tests` / 配置。
  - `README.md` 六节归并: 首段加 `## 定位`; `## 使用示例` 改 `## 用法`; `## 边界与限制` 改 `## 边界`; `## 目录结构` 降为 `## 定位` 下的 `### 目录结构`; `## 能力` / `## 配置` / `## 测试` 节名不变。最终二级标题: 定位 / 能力 / 配置 / 用法 / 边界 / 测试。
  - 重复段落合并: 「拦截面」表里「敏感文件」一行原有两个逐字相同的表格行, 合并为一行。
  - 命令: 测试节四条命令由 `npm` 改 `pnpm`, 并按 `package.json` 补 `test:integration` / `test:coverage` 两行; 引述脚本提示的一处 `npm run build` 同改 `pnpm run build`。
  - 术语: `状态栏 cwd` 改 `状态列 cwd`; `2026-10-02 收口` 改 `收尾`; `不回归` 改 `不退化`; `含本仓 28 插件` 改 `含本仓 33 个插件`。
  - 事实同步 (阶段 3 偏差里移交本阶段的一项): 目录结构表按 `src/` 拆分结果重写 —— `src/index.ts` 只留入口与挂接, 新增 `tool-registry.ts` / `arg-scan.ts` / `config.ts` / `engine.ts` 四行, `DEFAULT_COMMAND_RULES` 由 15 条改 18 条 (源码实测), 用例数由 142 例改 160 例并补集成用例一行; 正文三处「`src/index.ts` 的登记表 / `TOOL_SURFACE`」改指 `src/tool-registry.ts`。
  - 用例数按本分支实测: 单元 160 例 (blacklist 23 / guard 103 / script 22 / sensitive 12, 1 例发布形态用例在无 `dist` 时跳过) + 集成 14 例, 替换原有的 135 例 (9 / 97 / 22 / 7)。
  - `docs/BACKLOG.md`: 模板字段「落点」按 `docs/GLOSSARY.md` 改「改动位置」; 其余不动 (当前无未完成条目)。

## 偏差

- 覆盖率基线口径: 本文件「现状」节记的是行 63.6% (1842/2896), 本分支实测为行 97.5% (1538/1578); 两者统计范围不同, 本阶段以分支实测的「改前 / 改后」两列为准, 未改「现状」节。
- `test:coverage` 的统计范围: `dev/coverage/report.mjs` 的 `isPackageSource` 只排除 `tests` 与 `node_modules`, 不排除 `dist`, 故 `dist` 已构建时会把它一并计入 (实测行 64.4%)。处理办法: 覆盖轮在删除 `dist` 后跑 (发布形态用例因此跳过 1 条, 属 4.4 保留的「`dist` 未构建」类), 单测轮在 `build` 后跑 (skipped 0)。修 `report.mjs` 属跨包工具改动, 本阶段不做。
- 集成层断言面: 本包不注册工具、无 `output.render` 投影、也不订阅除 `tools/pre-execute` 外的事件, 故规划里的「工具注册名与 execute 的 canonical 值 / output.render 投影 / 事件消费者注入内容」落为零值断言 (零工具注册、零多余订阅), 实际断言面是服务面 `guard` 与两条判定挂载路径。
- 拆分粒度: 规划写「规则表 / 命令解析 / 判定」三层, 实际落成五个文件 —— 配置归一 (`config.ts`) 与回执文案 (`receipt.ts`) 各单列。理由: `resolveGuardConfig` 与回执文案在旧文件里各自成块, 并入判定层会让 `engine.ts` 同时承担「读配置 / 拼文案 / 判定」三件事。对外面与行为不变。
- 回执文案进既有的 `src/receipt.ts` 而非新建 `guard-receipt.ts`: 回执只留一个出口, 两个名字相近的文件反而容易分叉。
- 计划外文件: `scripts/tool-surface-check.mjs` 不在「实现规划 / 代码」的文件清单里, 但它是本包键集 (键集单一来源) 的仓库形态读取方; 不改会让未构建 `dist` 的仓库形态直接 exit 2, 故按「保持既有行为」做了最小改动。`tests/guard.test.ts` 只改读路径属「只改路径不改断言」。
- `README.md:133` 仍写 `src/index.ts` 含判定引擎与工具登记表, 拆分后该行已过期; 按规划「包文档」归阶段 4, 本分支未改。
- 5.2 零引用导出复查: 扫 `src` / `tests` / `scripts`, 入口 34 个导出里 8 个在包外无引用 (`CommandHit` / `CompiledSensitiveRule` / `Config` / `PolicySnapshot` / `SensitiveHit` / `formatCommandReceipt` / `formatSensitiveReceipt` / `remotePipeShellHit`), 但都属入口公开面 (类型与服务面 / 诊断用的回执格式化函数), 且总追踪 5.2 的逐包删除表里没有 `security-guard`; 按 5.1「拿不准的留在原处」本轮不删, 只记录。
- 阶段 4 包文档: 测试节里引述脚本提示的一处 `npm run build` 按规划改 `pnpm run build`, 但 `scripts/tool-surface-check.mjs:1113` 的提示文案与 `tests/script.test.ts:505` 的断言仍是 `npm --prefix security-guard run build`; 改脚本与用例不属本阶段文件清单, 故文档与脚本实际提示暂时不一致, 待后续改脚本提示时与用例断言同改。
- 阶段 4 包文档: 目录结构表与用例数超出「只改节名」的字面范围, 但前者是上一节「偏差」里明确移交本阶段的一项 (`src/index.ts` 行在阶段 3 拆分后已过期), 后者与原表并存即自相矛盾 (142 与 160); 两者均按源码与实测更新, 未新增结论。

## 测试与证据

### 四条命令 (本分支最终状态)

| 命令 | 结果 |
| --- | --- |
| `pnpm -C security-guard run check` | 通过 (tsc --noEmit, 无输出) |
| `pnpm -C security-guard run test` | 160 例, 160 通过, 0 失败, 0 跳过 (改前 142 例 / 141 通过 / 1 跳过) |
| `pnpm -C security-guard run test:integration` | 14 例, 14 通过, 0 失败, 0 跳过 |
| `pnpm -C security-guard run test:coverage` | 通过; 行 98.9% (1561/1578) / 分支 94.1% (416/442); 本机无 `dist` 触发 1 条保留类跳过 |

### 用例增减

- 新增: 单元 18 例 (blacklist 7 / sensitive 5 / guard 6), 集成 14 例, 装配器 `tests/assemble.ts` 1 个; 共 32 例。
- 删除: 0; 改写: 发布形态用例的跳过探测提到顶层 (1 处, 断言与条件语义不变)。

### `skip` 计数

- 改前: 1 条 (`dist` 未构建, 本机触发)。
- 改后: `test` 轮 0 条 (`build` 之后跑, 发布形态用例实际通过); `test:coverage` 轮 1 条 (该轮删 `dist` 以排除 dist 统计, 属 4.4 保留类)。豁免台账: 无 (两类均为环境探测, 非补不了)。

### 覆盖率 (只统 `src`)

改前 = 单元层, 未构建 `dist`; 改后 = 单元 + 集成, 未构建 `dist`。

| 文件 | 行 (改前) | 分支 (改前) | 行 (改后) | 分支 (改后) | 未覆盖行 (改后) |
| --- | --- | --- | --- | --- | --- |
| `src/blacklist.ts` | 96.5% (412/427) | 87.0% (120/138) | 98.6% (421/427) | 92.7% (140/151) | 54, 95, 100, 156, 169, 361 |
| `src/index.ts` | 99.0% (912/921) | 96.1% (220/229) | 99.1% (913/921) | 95.0% (230/242) | 328, 430, 431, 441, 460, 627, 958, 1154 |
| `src/receipt.ts` | 94.7% (36/38) | 80.0% (4/5) | 94.7% (36/38) | 80.0% (4/5) | 15, 16 |
| `src/sensitive.ts` | 92.7% (178/192) | 73.5% (25/34) | 99.5% (191/192) | 95.5% (42/44) | 41 |
| 合计 | 97.5% (1538/1578) | 90.9% (369/406) | 98.9% (1561/1578) | 94.1% (416/442) | - |

分层贡献 (两轮取差): 单元层 99.0% (1563/1578) / 95.1% (408/429); 单元 + 集成 98.9% (1561/1578) / 94.1% (416/442)。集成轮行覆盖比单元轮低 2 行、分支分母多 13 个, 是 `report.mjs` 跨进程 range 合并口径带来的抖动 (同一行在不同进程取的 span 不同), 非本次改动引入的退化; 两轮都高于改前基线。未覆盖行里混着 `report.mjs` 偏移映射的老问题 (例如 `index.ts:328` 是常量展开行, 实际每次都在跑), 本阶段不修。

### 契约面

- 导出覆盖率: `src/index.ts` 的导出名以 `tests/` 引用为准, 新增用例补上 `provide` 与 `resolveGuardConfig` 两处此前无用例引用的导出。
- 错误码覆盖率: 本包回执是字符串文案、无 `code` 常量, 不适用。

### 阶段 3 代码整理 (本分支)

| 命令 | 结果 |
| --- | --- |
| `pnpm -C security-guard run check` | 通过 (tsc --noEmit, 无输出) |
| `pnpm -C security-guard run test` | 160 例, 160 通过, 0 失败, 0 跳过 (`build` 之后跑, 发布形态用例实际通过) |
| `pnpm -C security-guard run test:integration` | 14 例, 14 通过, 0 失败 |
| `pnpm -C security-guard run test:coverage` | 通过; 行 99.1% (1622/1637) / 分支 94.1% (416/442) (改前 行 98.9% (1561/1578) / 分支 94.1% (416/442)) |
| `pnpm -C security-guard run smoke` | 本机未跑通: 缺 `DEEPSEEK_API_KEY` (`MISSING_CREDENTIAL`), 与本次改动无关; 真机验收留 profile 刷新后 |

- 覆盖率分母 +59 行、分支数不变: 增量是拆分新增的 import / re-export 语句行 (可执行), 判定分支与用例断言未变。
- 分文件覆盖率: `tool-registry` 行 100.0% (137/137) / 分支 95.8% (23/24); `arg-scan` 行 97.8% (174/178) / 分支 94.7% (72/76); `config` 行 99.3% (139/140) / 分支 96.7% (29/30); `engine` 行 99.7% (321/322) / 分支 93.8% (76/81); `index` 行 100.0% (119/119) / 分支 100.0% (16/16); `receipt` 行 98.4% (120/122) / 分支 90.0% (18/20)。
- 行为对照 (新旧 `dist/src/index.js` 对跑): 入口导出名集合 26 个逐名相同; `TOOL_SURFACE` 与 `DEFAULT_COMMAND_RULES` 的 JSON 逐字节一致; 11 组抽样入参 (shell 命令 / 工作目录 / 官方读写文件 / 插件文件工具 / 插件命令工具含数组键 / 未登记工具 deny 路径 / `run_code`) 的 `inspect` 回执逐字相同, 差异 0; `policy()` 快照与 `inspectCommand` 回执也相同。
- 逐行搬运核对: 拿旧 `src/index.ts` 的行多重集与新六个文件比对, 缺失 34 行全部是删掉的 import 行与加了 `export` 关键字的声明行; 新文件多出的行只有文件头注释与 import 行, 无改写、无重复。

### 阶段 4 包文档 (本分支)

| 项 | 结果 |
| --- | --- |
| 六节 | ✓ 定位 / 能力 / 配置 / 用法 / 边界 / 测试 (顺序与模板一致) |
| 正文 `npm` 命中 | 0 (`grep -nE "(^\|[^p])npm "` 于 `README.md` / `docs/BACKLOG.md`) |
| 术语命中 | 0 (`状态栏` / `落点` / `收口` / `回归` / `插件包` / `返回体` / `评审` 均无) |
| 符号变体命中 | 0 (20 条映射逐条扫两文件) |
| 非归档断链 | 0 (两文件无相对链接) |
| 用例数实测 | 单元 160 例 (23 + 103 + 22 + 12; 159 通过 / 1 跳过) / 集成 14 例 (14 通过) |
| `format` | 两个文档 `format` 后无二次改动 |
| 自查 diff | 37 增 / 29 删; 删除项只有重复的「敏感文件」表格行与搬移的目录结构表 (内容进了 `## 定位`), 无内容丢失, 无新增结论 |
