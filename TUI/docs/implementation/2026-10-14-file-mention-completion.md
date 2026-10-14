# @ 文件提及补全（接取条目：TUI/docs/BACKLOG.md「输入 `@` 时按项目目录补全文件提及」）

状态：规划　　开启：2026-10-14　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

在 TUI 的提示文本（`steer` / `followup`）里输入 `@` 时，于活动区给出项目目录内的文件 / 目录候选：继续输入即筛选，Tab 接受后把光标处的 `@token` 就地替换为规范提及拼写（`@path `、含空格 `@"path"`、目录 `@dir/` 并按需保持引号继续下钻）。

边界（不在目标内）：不附加文件内容（宿主契约：选择候选只插入提示文本，读文件由模型侧工具完成）；不浏览项目目录之外的路径；不改 slash 命令参数与 `$` shell 模式的输入语义。

## 调研

### 1. 宿主面已就绪（来源：官方包源码与 README）

包位置：`~/.npm/_npx/c40503fdf38a82ea/node_modules/@deepseek-ai/dsh-file-reference{,-local}`（0.1.5-rc.2）。

- `ctx.fileReferences`（`dsh-file-reference/lib/types/index.d.ts`）：抽象服务 `FileReferenceService.list(agent, query, signal): Promise<FileReferenceCandidate[]>`——按目标 agent 的工作目录给出**仅路径**的候选，确定性排序；`signal` 用于取消慢补全。
- 候选类型（`.../types/types.d.ts`）：`FileReferenceCandidate = { path: string; kind: 'file' | 'directory' }`——目录带尾随 `/`，用于继续下钻。
- 共享语法（`.../grammar.d.ts`，包 exports 暴露 `./grammar` 且**浏览器安全**）：
  - `activeAtToken(line, cursorCol)` → `{ prefix, query, quoted } | undefined`；`prefix` = 接受补全时要替换的完整 token，`query` = `@` / `@"` 之后的路径文本，`quoted` = 用户是否已显式开引号。`@` 位于**输入开头或空白之后**才触发（邮箱里的 `@` 不触发）。
  - `formatFileMention(candidate, preserveQuote)` → 插入文本；含空白走 `@"path"` 引号形式；**目录候选在尾随 `/` 之后保持引号打开**，以便补全继续下钻；无法安全表示的路径（控制字符 / 内嵌引号）返回 `undefined`。
- 模型侧语义（`FILE_REFERENCE_PROMPT`）：`@` 前缀 = 用户显式引用的工作区路径（相对工作区根）；尾随 `/` = 目录；其余 = 文件，模型需要内容时必须调用 read 工具、不得声称已读过。**即：提及只是提示文本，插入动作不读文件。**
- 本机 provider（`dsh-file-reference-local/lib/types/index.d.ts`）：`LocalFileReferenceService`，配置 `maxResults` / `maxEntries` / `excludedDirectories`，内部为**有界模糊索引** + 缓存 + 失效。
- 挂载状态（来源：`~/.dsh/profiles/fff/cordis.patch.yml:764`、`docs/host/HOST-PACKAGES.md:374`、`:407`）：本 profile 已挂载 `file-reference-local`，服务索引登记 `ctx.fileReferences`。

### 2. TUI 现状（来源：本仓源码）

- **已有命令补全面板全套**：纯函数 `completeCommandInput`（`src/app/commands.ts:394`，只认「首个命令 token」）、状态字段 `state.completion`（`src/app/state.ts:562`）、**唯一重算漏斗** `setInput`（`src/app/state.ts:2613`）、渲染组件 `src/app/components/CommandCompletion.ts`、键位（`tab` 接受 / `esc` 收起 / `↑` `↓` 移动，`src/app/index.ts:2625-2669`）、焦点可见行口径 `completionVisibleRows()`（`src/app/index.ts:5452`）、提示行 `COMPLETION_HINT_LINE`（`src/app/layout/hints.ts:22`）。
- **接受候选目前是整串替换**：`acceptCompletion` 直接把输入文本换成 `/name `（`src/app/index.ts:5468-5472`）——对光标处的 `@token` 不适用，需改为按 `activeAtToken.prefix` 局部替换。
- `@` 在输入路径上**无特殊处理**；输入模式为 `steer | followup | shell | slash`（`src/app/state.ts:85`）。
- `fileReferences` 在 TUI 全仓**零命中**（`grep -rn fileReferences TUI/src TUI/docs` 无结果）。
- **agent 与服务可得**：`main.ts` 持有真实 agent（`rawAgent`）并经 `commandAgent` 传入 adapter（`src/main.ts:610-652`）；`main.ts` 已有「`ctx.get("commands")` 取服务 + 结构面」先例（`src/main.ts:633-636`），`adapter/types.ts` 集中声明各宿主服务结构面（如 `:901` 命令注册表、`:1241` subagents）。
- **依赖面事实**：TUI `package.json` **零运行时依赖**，`src/` 内**无任何 `@deepseek-ai/*` import**（仅注释引用官方包名）；宿主服务一律经结构面 + `ctx.get` 访问。

### 3. 「挂载」与「可 import」是两件事（2026-10-14 审阅期补充实测）

- 官方包的实际位置是**全局安装的 dsh 包内部**：`/home/guochang/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-file-reference/lib/index.js`（`import.meta.resolve` 实测）。
- profile 的 `node_modules/@deepseek-ai/` 只有 3 个条目（外加包 `dsh-session-title-all-prompts-llm` 及其两个依赖），**没有** `dsh-file-reference`；profile 的 `cordis.patch.yml` 只按**名字**声明要挂哪些行，真正的模块解析发生在宿主进程（跑在全局 dsh 树内）。
- 本仓的解析基准是 `repo/TUI/dist`，实测 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-file-reference' imported from /home/guochang/Projects/dsh-toolset/TUI/dist/`。
- 结论：**挂载** = 宿主进程加载该包并把服务挂上 `ctx`（这一半我们已复用，见决策项 1）；**import** = 让我们仓库自己的代码在编译期 / 运行期拿到那个模块对象，需要把包装进本仓。
- `FileReferenceService` 只提供**服务方法** `list`（`dsh-file-reference/lib/index.js:56` 的类里别无他法）；`activeAtToken` / `formatFileMention` 是**与该类并列的模块级导出**（同文件 `:62`）。ctx 里只能放对象（服务），放不了模块函数——这是本项取舍的唯一症结。

### 4. 官方客户端对同一问题的做法（决策项 2 的先例）

- `@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js:12` 与 `@deepseek-ai/dsh-client-ui-reference/lib/client.js` 都带源码标记 `//#region ../../context/file-reference/src/grammar.ts`——官方把 grammar **内联进自己的客户端 bundle**。
- 两者运行时 `require` 的只有 `cordis` / `dsh-client-store` / `react` / `client-ui-primitives`，**不 require** `dsh-file-reference`。
- 即官方对「共享 `@` 语法」的界定是：共享一份**源码片段**（`activeAtToken` 约 20 行 + `formatFileMention` 约 8 行），不是一个运行时依赖。
- 本仓横截面事实：20 个包 `src/` 内 `@deepseek-ai/*` import 数 = 0（全仓 grep 实测），只消费 `ctx` 上的服务与方法——故「按其他插件的操作逻辑」能覆盖候选获取，覆盖不了这两个纯函数。

## 决策

### 决策项 1：候选来源

- (a) 复用宿主播缝 `ctx.fileReferences.list(agent, query, signal)`（本 profile 已挂载 `file-reference-local`）。
- (b) TUI 自己递归 `readdirSync` 扫目录并自写排序。
- (c) 先 (a)，服务缺失时回落 (b)。

**选定 (a)**。理由：宿主 provider 已具备有界索引（`maxEntries` / `maxResults` / `excludedDirectories`）、确定性排序与缓存失效，且与模型侧 `@` 语义同源；自写扫描要重复实现这套口径，(c) 的回落面收益低——服务缺失时模型侧 `@` 语义同样不成立，徒增一条无消费者的代码路径。

### 决策项 2：语法（token 识别 / 提及拼写）的实现方式

- (a) 静态 import `@deepseek-ai/dsh-file-reference/grammar`（纯函数、浏览器安全）。
- (b) 本仓复刻为纯函数模块。
- (c) 启动时动态可选 import，缺失则关闭特性。

**选定 (b)**。理由：TUI `package.json` 零运行时依赖、`src/` 无任何 `@deepseek-ai/*` import，宿主服务一律走结构面 + `ctx.get`；(a) 会让 TUI 在**未挂 file-reference 的 profile 下直接 `ERR_MODULE_NOT_FOUND`**（整包起不来），而该特性本应可降级；(c) 为「已实测挂载」的场景引入动态加载与类型面复杂度，不划算。漂移风险（语法与 provider 预期不一致）由测试兜底：覆盖空白后触发 / 邮箱不触发 / 光标位于 token 中间 / 含空格走引号 / 目录保持引号 / 不可表示路径返回 `undefined`。

官方先例（见调研 §4）：官方 Web 客户端 `dsh-client-ui-input-trigger` 与 `dsh-client-ui-reference` 同样把 grammar 内联进客户端 bundle；本仓 20 个包 `src/` 内 `@deepseek-ai/*` import 数亦为 0——即 (b) 不是本仓的例外做法，而是与官方客户端、本仓既有约定一致的那条路。

### 决策项 3：面板承载

- (a) 把 `state.completion` 泛化为 `{ kind: "command" | "file"; items; index }`，复用既有面板、键位、提示与可见行口径。
- (b) 新增独立 `state.fileCompletion` 字段与独立渲染组件。

**选定 (a)**。理由：`setInput` 已是输入变更的单一漏斗点（候选随文本同步重算），面板渲染 / `tab` / `esc` / `↑↓` / `completionVisibleRows` 全套可原样复用，(b) 会造成两套并行面板与两处键位判定。

### 决策项 4：触发范围

- (a) 仅提示文本（`steer` / `followup`）。
- (b) (a) + slash 命令参数（如 `/playbook @a.md`）。
- (c) 全部模式（含 `$` shell）。

**选定 (a)**。理由：`@` 提及是**模型侧提示语法**（`FILE_REFERENCE_PROMPT`），只在提示文本里有语义；slash 命令的参数由各命令自行解析，shell 模式发给本地 shell，两者插入 `@path` 都无意义。

### 决策项 5：接受候选的编辑语义

- (a) 沿用现有「整串替换」。
- (b) 按 `activeAtToken.prefix` 在光标处局部替换；目录候选保持面板打开并继续列出下一级。

**选定 (b)**。理由：(a) 只适用于「输入框恰好等于一个命令 token」，会抹掉 `@` 前后的正文；目录下钻也需要「接受后不关闭面板」这一分支（`formatFileMention` 的 `preserveQuote` 正是为此）。

**用户裁定（2026-10-14，逐项审阅）**：决策项 1 → (a)；决策项 2 → (b)；决策项 3 → (a)；决策项 4 → (a)；决策项 5 → (b)。五项均与本节选定项一致，**方案定稿**；经「决策完成后」提交检查点后转「实现」。

## 规划

### 任务拆分

1. `file-mention.ts`：复刻语法（活动 token 识别 + 提及拼写）+ 候选归一（含目录尾随 `/`），纯函数。
2. 状态层：`completion` 泛化为 union；`setInput` 按「命令 token → `@` token」顺序重算；新增异步候选回填 action（带**过期丢弃**：回填时校验当前 token 仍与请求时一致）。
3. 接线层：`@` 触发 + 防抖 + `AbortController`（新 token 到来即取消上一次）；Tab 接受按 kind 分派（命令 = 整串替换、文件 = 局部替换 + 目录续开面板）。
4. 渲染层：面板标题与候选行按 kind 渲染（文件候选显示路径，目录带 `/`）；提示行区分两态。
5. 宿主接线：`main.ts` 经 `ctx.get("fileReferences")` 取服务，与 `rawAgent` 一并传给 adapter；adapter 暴露 `listFileCandidates(query, signal)`，服务缺失 / 抛错 → 空数组（静默降级，不弹错）。
6. 测试：语法纯函数用例 + 状态机用例 + 接受候选的局部替换用例 + 异步过期丢弃用例 + 服务缺失降级用例。
7. 真机确认：`dsh --profile fff` 下输入 `@` 走一遍文件 / 目录 / 含空格路径。

### 计划改动文件清单

- `TUI/src/app/file-mention.ts`（新增）
- `TUI/src/app/state.ts`
- `TUI/src/app/index.ts`
- `TUI/src/app/components/CommandCompletion.ts`
- `TUI/src/app/layout.ts`
- `TUI/src/app/layout/hints.ts`
- `TUI/src/app/adapter/types.ts`
- `TUI/src/app/adapter/dsh.ts`
- `TUI/src/main.ts`
- `TUI/tests/file-mention.test.ts`（新增）
- `TUI/tests/completion.test.ts`（仅在泛化改动波及既有断言时同步，尽量不动）
- `TUI/docs/BACKLOG.md`（条目状态）、本追踪文档
- 关闭后按需回写：`TUI/README.md`、`TUI/docs/DESIGN.md`

### 明确不做

- 文件内容附加 / 预览（宿主契约明确「选择候选不读取内容」）。
- 项目目录之外的路径浏览、候选预取与自建缓存（provider 已负责）。
- slash 命令参数与 `$` shell 模式的 `@` 补全。
- `session` 引用（`@` 之外的另一套提及语法）与 TUI 侧新增配置项。
- **做成独立插件**（2026-10-14 审阅期裁定不做）：TUI 对外无任何注册 API（`TUI/src/main.ts` 内无 `register*` / `provide`），跨包协作方向是「别的包 `ctx.provide`，TUI `ctx.get`」，且 `TUI/docs/DESIGN.md:368` 明确「TUI 无跨包依赖、根无 workspaces、`file:` 依赖被项目约定禁止」——本仓新建的包 TUI 也无法 import。做成插件需先给 TUI 造「补全提供者」扩展体系（注册表 + 键位路由 + 渲染注入），成本大于功能本身，属另一件事（如需要另开条目）。宿主半边（候选发现）已由官方 `file-reference-local` 覆盖，无自研空间。

### 途中新增条目（不属本任务范围）

- 2026-10-14（审阅期）：用户要求新增条目「切换顶部面板焦点的快捷键重做（`Tab` 与补全挤在一起, 且从未在提示行暴露）」→ 已登记 `TUI/docs/BACKLOG.md`。缘由：现有焦点切换绑在 `Tab` 且**仅输入框为空时**生效，与补全面板共用同一按键，在别处又已多次占用（审批 / 问答 / 模型选择 / 历史列表），而普通提示行 `HINT_LINE` 从未暴露该键。**不属本任务范围**，按流程交由其他 agent 接取（候选键位、落点与验收已写在条目内）。
- 2026-10-14（同日追加）：用户要求再登记一条「按键提示信息与实际绑定对齐（审计 + 补齐 + 统一格式）」→ 已登记 `TUI/docs/BACKLOG.md`（提示行漏列 `Tab` / `Ctrl+P` `Ctrl+N` / `Ctrl+↑↓` / `Home` `End` `PgUp` `PgDn`，且格式不统一）。**不属本任务范围**，详细调研按用户指示留到该条目接取时进行。

## 实现记录

（待实现后按时间追加，含关键命令与结果）

## 偏差

（待实现后如实填写；没有就写「无」）

## 测试与证据

（待实现后补：命令 + 输出 / 真机现象 / 残留检查）

## 收尾

（待关闭时补：回写了哪些文档、遗留项、是否移入 `archived/`、BACKLOG 已完成条目的清理）
