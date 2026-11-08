# 核查各工具执行路径, 确认是否需要走官方围栏（接取条目：docs/BACKLOG.md「核查各工具执行路径, 确认是否需要走官方围栏」）

状态：进行中　　开启：2026-11-08　　关闭：
本文件是本任务在项目级的唯一追踪文档；各包内的编辑另在各包建追踪文档（见「落地计划」）。

## 目标

1. 核查本仓全部写盘面 / 工具的执行路径, 逐条标注是否走官方 `ctx.fs`（围栏 / 版本守卫 / 审批瀑布）, 产出「工具写路径 × 是否走围栏」核对表。
2. 按判定口径给结论: ① 写用户 / 项目工作文件（模型可指定路径）→ 需要走围栏; ② 写插件自有数据目录或临时区 → 可不走, 写明边界与越界风险; ③ 有安全敏感的越界写 → 需要走。
3. 把判定为「需要改走」的三个文件编辑工具改成调用 `ctx.fs` 的方法: `hash-edit` / `ast-tools` 的 `ast_replace` / `md-logic` 的 `replace`。
4. 不属本任务的两个写面问题（`script-interpreter` 临时脚本、`output-compress` 会话目录）只登记条目, 不在本任务实现。

## 调研口径

三类判定 (条目原文) 之外再加两条事实列, 因为真正的风险差异在「路径从哪来」而不是「哪个包在写」:

- **路径来源**: ① 模型可指定 (工具参数) → 是否能把路径指到工作区外完全由模型决定; ② 服务 / 配置注入 (会话目录、数据目录、profile 目录) → 模型改不了; ③ 系统临时区。
- **落盘方式**: 直写 / 临时文件 + rename 原子替换 / append。原子替换解决半写, 不解决越界。

范围: 各包 `src/` 下的写盘调用 (排除 `tests` / `demo` / `examples`), 共 20 个包、约 30 处调用点。只读包 (`fs-digest` / `md-map` / `code-map` / `command-template` / `herdr-use` 的只读面) 不列表。

## 核对表: 工具写路径 × 是否走围栏

| 序 | 位置 | 写的对象 | 路径来源 | 落盘方式 | 模型可指定路径 | 走 `ctx.fs` | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `hash-edit/src/fs.ts:56-61,118-171` | 用户任意文件 | 工具参数 `path`, 绝对路径直接放行; 相对路径按调用会话 cwd | 同目录临时文件 + `rename` 原子替换, 保留权限位 | 是 | ✗ | **需要改走** |
| 2 | `ast-tools/src/replace.ts:80-84` | 用户任意文件 | 工具参数 `path` | `readFileSync` + `writeFileSync` 整文件重写, 无任何读后复核 | 是 | ✗ | **需要改走** |
| 3 | `md-logic/src/edit.ts:711-736` | 用户任意文件 | 工具参数 `path` | 临时文件 + `rename`, 带读→rename 的 TOCTOU 复核与权限保留 | 是 | ✗ | **需要改走** |
| 4 | `script-interpreter/src/run.ts:52,77,107` | 临时脚本文件 | `mkdtemp(<系统 tmpdir>/<prefix>XXXXXX)` | 目录 0700, 文件 `flag: "wx"` 0600; 跑完不清理 | 否 | ✗ | 可不走, 另登记条目 |
| 5 | `task-engine/src/engine-store.ts:174-177` | 引擎状态快照 | 配置 `snapshotPath` | `writeFile` | 否 | ✗ | 可不走 |
| 6 | `memory-base/src/schema.ts:53-55,175` | 分层记忆库 (sqlite) | 服务注入的数据目录 | `mkdir` 0700 + `open(path,"wx",0o600)` | 否 | ✗ | 可不走 |
| 7 | `session-paths/src/index.ts:169` | 会话目录 | `projectKey` / `sessionId` 推导, 根为 `~/.dsh/sessions` | `mkdir -p` 0700 (唯一写盘入口) | 否 | ✗ | 可不走 |
| 8 | `coagent/src/store.ts:135-264` | 终端记录 (meta / 认领日志 / 截屏) | `sessionPaths.sessionDirFor` 推导 | 原子写 0600 | 否 | ✗ | 可不走 |
| 9 | `agent-group/src/store.ts:71-122` | 群组索引 | `sessionDirFor` 推导 | 临时文件 + `rename` | 否 | ✗ | 可不走 |
| 10 | `auto-approve/src/audit.ts:157-174` | 审批审计流水 | `sessionDirFor` 推导 + `~/.dsh` 用户级 | `appendFileSync` / 超限截断 `writeFileSync` | 否 | ✗ | 可不走 |
| 11 | `rule-engine/src/persist.ts:27-33` | 规则库 | `homedir()/.dsh/rule-engine` | 原子写 | 否 | ✗ | 可不走 |
| 12 | `metric-loop/src/persist.ts:32-33` | 指标循环状态 | 注入 `stateDir` | 原子写 | 否 | ✗ | 可不走 |
| 13 | `preference-analysis/src/ledger.ts:116-117` | 偏好账簿 | 注入 `dshHome` | 原子写 + `chmod` | 否 | ✗ | 可不走 |
| 14 | `background-daemon/src/store.ts:352-359` | daemon 任务表 | 注入目录 | `mkdir` + 临时文件原子写 | 否 | ✗ | 可不走 |
| 15 | `background-daemon/src/journal.ts:107-108` | 运行流水 | 同上 | `appendFileSync` | 否 | ✗ | 可不走 |
| 16 | `background-daemon/src/control.ts:72-73` | 开关状态 | 同上 | `appendFileSync` | 否 | ✗ | 可不走 |
| 17 | `output-compress/src/digest-db.ts:61-66` | 摘要库 (sqlite) | 会话目录; 父目录必须已存在 (不 `mkdir`) | `DatabaseSync` | 否 | ✗ | 可不走, 另登记条目 |
| 18 | `pin-note/src/store.ts` | 钉住要点 | 会话层记忆库 | 原子写 | 否 | ✗ | 可不走 |
| 19 | `TUI/src/app/layout/width-symbols.ts:74-82` | 宽度符号缓存 | `<profile 目录>/tui-width-symbols.json` | 临时文件 + `rename` | 否 | ✗ | 非工具面, 记现状 |
| 20 | `TUI/src/app/adapter/session-ui-state.ts:130-134` | UI 状态 | 会话目录 | 临时文件 + `rename` | 否 | ✗ | 非工具面, 记现状 |
| 21 | `TUI/src/app/adapter/local-log.ts:173-182` | 本地日志 | 会话目录 | append + 超限轮转 `rename` | 否 | ✗ | 非工具面, 记现状 |
| 22 | `TUI/src/app/layout/pipeline/memlog.ts:106` | 排版诊断日志 | 环境变量 `DSH_LAYOUT_MEMLOG` | `appendFileSync` | 否 | ✗ | 非工具面, 记现状 |
| 23 | `TUI/src/app/runtime/lifecycle.ts:131` / `runtime/interaction.ts:1078` | 宽度探测报告 / 重启交接标记 | 注入路径 (`deps.restartHandoffPath` 等) | `writeFileSync` 0600 | 否 | ✗ | 非工具面, 记现状 |
| 24 | `TUI/src/app/adapter/session-records.ts:243-248` | 删除整个会话目录 | 会话根 + 单段 id 校验 + `realpath` 包含性校验 | `rmSync(recursive)` | 否（受 id 校验与包含性校验约束） | ✗ | 非工具面, 记现状 |

全仓没有任何一处走 `ctx.fs`; 官方 `write` / `edit` / `apply_patch` 全程经 `ctx.fs`, 故本仓与官方在围栏上完全不同源。

## 分档结论

### 需要改走围栏 (3 处, 都是模型可直接指定任意路径)

1. **`hash-edit`** — 风险最高: `resolvePath` 对绝对路径直接放行 (`fs.ts:56-61`), 读写都走 `node:fs`, 既不受 `workspace-write` 围栏约束, 也没有版本守卫。行级锚点只保证「同一文件内的 staleness」, 与「能不能写这个路径」是两件事。改造点在 `docs/ARCHITECTURE-REUSE.md` §4 D 曾评估后关闭, 本次重开。
2. **`ast-tools` 的 `ast_replace`** — `writeFileSync` 整文件重写, 连读后复核都没有 (`replace.ts:80-84` 无 `stat` / 哈希比对); 并发改动会被静默覆盖。工具描述里已自认「无读后改前版本守卫」。
3. **`md-logic` 的 `replace`** — 有临时文件 + `rename` 与 TOCTOU 复核, 是三处里写盘最讲究的, 但仍绕开围栏, 越界能力与上面两个相同。

三处的共同点: 参数是模型给的 `path`, 目标是用户 / 项目工作文件, 且能指向工作区外。按条目口径 ①③ 都判「需要」。

### 可不走围栏 (数据目录 / 临时区)

15 处, 路径都不来自模型参数: 会话目录由 `sessionPaths.sessionDirFor` 推导、规则库与账簿在 `~/.dsh` 下、其余由配置注入。越界风险只剩「配置被改坏」, 而配置是用户自己写的。这些写入的边界写进各包 README 即可, 不必改造。

### 非工具面 (TUI 自身状态)

6 处, 目标是 profile 目录、会话目录与诊断日志, 模型触发不到。唯一带破坏性的是 `deleteSessionDir` 的 `rmSync(recursive)`, 但它前面有单段 id 校验与 `realpath` 包含性校验 (对齐官方 `dsh-tui` 的 `compat/sessionLog`), 判定为已具备安全线。

## 决策

| 编号 | 决策项 | 结论 |
| --- | --- | --- |
| D1 | 实现范围 | 只做三个文件编辑工具: `hash-edit` / `ast-tools` 的 `ast_replace` / `md-logic` 的 `replace` |
| D2 | 改写形式 | 逐行仿照官方 `write` / `edit` 的用法, 改成调用 `ctx.fs` 的方法（见下一节）; 不自己复刻围栏、不自建临时文件 + rename |
| D3 | 行为口径 | 完全仿官方: 权限位不额外保持（`fs-local.writeText` 无 `chmod`, 不补）; 相对路径 `cwd` 由 `ctx.workingDirectory.ensure` 给, 删掉 `process.cwd()` 回落; 错误沿用官方 `FsError` 码, 各包只做对外文案映射 |
| D4 | 不属本任务的两项 | `script-interpreter` 临时脚本、`output-compress` 会话目录: 只登记条目, 不实现 |
| D5 | 工程组织 | 项目级跨多包任务: 每个包一个 worktree 分别实现, 包内各建追踪文档; 跨包共用文档（`docs/ARCHITECTURE-REUSE.md` §4 D、根 `AGENTS.md`、本文件）等各 worktree 合并回主分支后由本文件统一执行与记录 |

## 实现形式: 逐行仿照 `write` / `edit`

宿主只有两层, 没有「服务面的 write / edit 工具」可直接调:

| 层 | 服务名 / 入口 | 含写入 |
| --- | --- | --- |
| 底层抽象服务 | `ctx.fs`（`abstract class FileSystem extends Service`） | `resolve` / `stat` / `readText` / `writeText` / `editText` / `patchText` / 删除 / 移动 |
| 工具层 | `write` / `edit` / `apply_patch`（`tool-fs`）、`str_replace_editor`（`tool-str-replace-editor`） | 是工具不是服务: 两个包都不 `provide`, 别的插件拿不到编程入口 |
| 只读服务 | `WorkspaceFiles`（`workspace-files`） | 只有 `read` / `readBytes` / `stat` / `list`, 纯只读 |

所以三个包都按 `write` / `edit` 的同一套步骤改:

| 步 | 官方写法（照抄） | 说明 |
| --- | --- | --- |
| 1 | `const sandboxPolicy = await sandbox.resolvePolicy(<工具名>, args, exec)`（`write.ts:117`） | 三个工具没有 `sandbox_permissions` 参数, 简化成会话策略: `ctx.fs.sandboxMode !== undefined` 时取 `ctx.get('sandboxPolicy').resolve({ session: exec.agent.session })`, 否则 `undefined`。升档能力属后续（要先给工具加参数面） |
| 2 | `const target = await ctx.fs.resolve(path, await sessionResolveOptions(ctx, exec))`（`write.ts:118`, helper 见 `tool-fs/src/session-cwd.ts`） | `cwd` 取 `ctx.workingDirectory.ensure(exec.agent, exec.signal)`, 带上 `signal` |
| 3 | `const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)`（`write.ts:121`） | 三个包写的都是整段文本替换, 用 `write-intent`（不用 `edit-intent` 的字面量替换语义）。兜底 `() => undefined` = 无监听者时无条件写 |
| 4 | `const outcome = await ctx.fs.writeText(target, text, intent, exec.signal, sandboxPolicy)`（`write.ts:124`） | 原子写由后端保证。`intent` 三态: `replaceIfVersion`（版本不符 → `FS_STALE_VERSION`）/ `createIfAbsent`（已存在 → 失败）/ `undefined`（无条件） |
| 5 | `ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)`（`tool-fs/src/mutation-result.ts:19`） | 写后记录新版本。可选: 做了则将来版本守卫插件启用时这几个包自动受管, 不做不影响 D2 |

配套改动（三个包相同, 属跨包口径）:

- `inject` 增加 `fs`（`workingDirectory` 按需）, 当前这几个包只注入 `tools` 等。
- 每包新增同一形状的两层 IO 适配: `src/io.ts`（接口 + `node:fs` 缺省实现）与 `src/ctx-fs-io.ts`（`ctx.fs` 实现）。三个包的接口成员统一命名为 `resolve` / `stat` / `readText` / `writeText`, 便于日后合并成共用包时直接对齐。
- 测试夹具: 现在各包测试直接读写真实临时目录, 改造后换成假 `ctx.fs`（可编程 `version` 与抛错能力）, 这是本次改造的主要工作量之一。
- 包 README 的覆盖边界同步。

### 跨包统一口径

| 项 | 口径 |
| --- | --- |
| 意图事件 | 三个包写的都是整段文本替换, 统一用 `fs/write-intent`; 不用 `edit-intent`（那是字面量替换语义） |
| 版本基准 | 读时取 `version`, 写时作为 `expected` 传入; 不一致由后端抛 `FS_STALE_VERSION`, 各包不再自建 TOCTOU 复核 |
| 服务缺失 | `ctx.fs` 不可用时不回落 `node:fs`, 直接返回可行动错误（否则围栏形同虚设）; `workingDirectory` 缺失时用 `io.resolve` 的后端缺省基准 |
| 权限位 | 不额外保持（官方 `fs-local.writeText` 无 `chmod`）, 与官方 `write` / `edit` 行为一致 |
| 降级 | `sandboxMode === undefined`（无围栏后端）时 `sandboxPolicy` 传 `undefined`, 后端按其缺省处理; 不自己判断是否围栏 |
| 错误码 | 后端统一 `FsError` 码, 各包在 `ctx-fs-io.ts` 一处做映射, 其余代码只见本包原有错误码 |
| 提交粒度 | 一包一条提交, 分别落在各自 worktree 分支 |

连带影响: 改造会真实收窄这三个包的能力 —— 写工作区外必须走升档审批, 不再无条件放行。

### 各包方案入口

| 包 | 包级追踪文档 | 一句话范围 |
| --- | --- | --- |
| `ast-tools` | `ast-tools/docs/implementation/2026-11-08-ast-replace-ctxfs.md` | `ast_replace` 读写换 `ctx.fs`, 写带 intent; 保留 ast-grep 匹配与 dry-run |
| `md-logic` | `md-logic/docs/implementation/2026-11-08-md-replace-ctxfs.md` | `replace` 落盘换 `ctx.fs.writeText`; 删临时文件 / `chmod` / 自算 TOCTOU |
| `hash-edit` | `hash-edit/docs/implementation/2026-11-08-hash-edit-ctxfs.md` | 读写全换 `ctx.fs`; 锚点算法与整批拒绝语义保留; 错误码扩为五值 |

## 拆分出去的条目

| 事项 | 去处 | 内容 |
| --- | --- | --- |
| `script-interpreter` 临时脚本 | `script-interpreter/docs/BACKLOG.md` | 默认存放位置改会话目录 `.tmp`（用 `sessionPaths` 推导）+ 执行结束必清理 |
| `output-compress` 会话目录 | `output-compress/docs/BACKLOG.md` | 缺目录时调 `sessionPaths.ensureSessionDir`, 不自己判存在 / 不自己 `mkdir` |

## 落地计划: 一包一 worktree

| 序 | 包 | worktree 分支 | 依赖 | 合并顺序 |
| --- | --- | --- | --- | --- |
| 1 | `ast-tools` | `wt/ast-tools-ctxfs` | 无 | 第一个合（改动最小, 用来验证跨包口径是否成立） |
| 2 | `md-logic` | `wt/md-logic-ctxfs` | 复用 ast-tools 的 IO 适配形状 | 第二个 |
| 3 | `hash-edit` | `wt/hash-edit-ctxfs` | 同上; 另有错误码扩展 | 最后（改动最大） |

## 合并后由本文件统一执行的事项（跨包编辑）

| 事项 | 位置 |
| --- | --- |
| 重开并更新「`hash-edit` 改走 `ctx.fs`」的改造点记录 | `docs/ARCHITECTURE-REUSE.md` §4 D |
| 更新三个包的定位描述（现描述为「直接 node:fs 直写 / 无读后改前版本守卫」等旧口径） | 根 `AGENTS.md` 的包清单一节; 根 `README.md` / `README.zh.md` 若涉围栏口径同步 |
| 写实现记录与验证证据到本文件, 再移入 `docs/archived/` | 本文件 |
| 根门禁 | `pnpm run check` / `test` / `check:docs` |

## 机械审计

审计分两级: 每包的详细判据与命令在包级文档的「机械审计清单」节（T 表与 A 表一一对应）; 本文件只列**跨包**必须同时成立的不变量, 用于合并后一次性判定。

### 跨包不变量（仓库根执行）

| 序 | 命令 | 期望 |
| --- | --- | --- |
| C1 | `pnpm run check` | 退出码 0 |
| C2 | `pnpm run test` | fail 0 |
| C3 | `pnpm run check:docs` | 错误 0 / 警告 0 |
| C4 | `grep -rn "node:fs" hash-edit/src md-logic/src ast-tools/src` | 只命中三个包的 `src/io.ts` 与 `ast-tools/src/binary.ts`（二进制探测） |
| C5 | `grep -rn "fs/write-intent" hash-edit/src md-logic/src ast-tools/src` | 每包恰好一处, 且都在各自 `src/ctx-fs-io.ts` |
| C6 | `grep -rn "process.cwd()" hash-edit/src md-logic/src ast-tools/src` | 无命中 |
| C7 | `grep -rn -e "rename(" -e "chmod(" hash-edit/src md-logic/src` | 无命中（临时文件 + rename 与权限保持已全部交给后端） |
| C8 | `grep -rln "ctx.fs" hash-edit/README.md md-logic/README.md ast-tools/README.md md-logic/docs/DESIGN.md` | 四个文件全部命中 |
| C9 | `grep -rn "inject" hash-edit/src/index.ts md-logic/src/index.ts ast-tools/src/index.ts` | 三行都含 `fs` |

### 每包机械审计（入口）

| 包 | 包级文档 | 判据覆盖 |
| --- | --- | --- |
| `ast-tools` | `ast-tools/docs/implementation/2026-11-08-ast-replace-ctxfs.md` | 任务 T1 至 T7; 审计 A1 至 A14 |
| `md-logic` | `md-logic/docs/implementation/2026-11-08-md-replace-ctxfs.md` | 任务 T1 至 T9; 审计 A1 至 A15 |
| `hash-edit` | `hash-edit/docs/implementation/2026-11-08-hash-edit-ctxfs.md` | 任务 T1 至 T9 + 可选 O1; 审计 A1 至 A19 |

判据写法统一为「可 grep 的结构事实」或「命令退出码」, 不写「行为正确」这类需要人判的措辞; 确属行为判断的（真机围栏拦截）单列在包级文档的「验证口径（真机）」小节, 由合并后统一执行。

## 验证口径

- 每包内: `pnpm run check` / `build` / `test` 全绿, 包 README 已同步（包级 A 表）。
- 合并回主分支后由本文件统一跑跨包不变量 C1 至 C9, 并补跨包文档（`docs/ARCHITECTURE-REUSE.md` §4 D 等）。
