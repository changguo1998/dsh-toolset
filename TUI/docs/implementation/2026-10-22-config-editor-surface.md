# 给 TUI 接 `config-editor` 的配置编辑面（接取条目：`TUI/docs/BACKLOG.md`「#4 给 TUI 接 `config-editor` 的配置编辑面」）

状态：实现完成；真机验收（2026-10-23）两处缺陷已修（2026-10-23，待复验）　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给 TUI 一个**受控的配置编辑面**：用户改某个插件条目的 config 时，走 `ctx.configEditor.edit()`（写盘前校验完整候选值 → 原子写 profile patch → 与 profile 变更 / HMR 串行 → 经 Loader 立即应用），而不是手改 YAML。

交付：可列出现有插件条目及其配置、可编辑并提交、越权 / 更高层覆盖的字段如实回报、服务缺失时降级并说明原因。

边界：不做配置文件全文编辑器（只按插件条目的 config 编辑）；不承担插件启停 / 装卸（那属 `plugin-manager`）；不改 `/settings` 现有只读展示的语义。

## 调研

**来源**：宿主安装目录 `@deepseek-ai/dsh-config-editor`（`lib/types/index.d.ts`、`lib/index.js`）、`@deepseek-ai/cordis-plugin-loader`（`lib/index.js` `Entry.update`）、`@deepseek-ai/dsh-hmr`（README「Further Exploration」与 `reconcileProfile`）、本仓 TUI 源码（行号为当前分支实测）。

### 1. 宿主 `config-editor` 的契约（服务名 `configEditor`）

- 挂载：`dsh-base` 组合包已挂该行（条目正文记 `dsh-base/cordis.patch.yml:105-106`），`inject = ["loader", "profileContext"]`，无需 profile 改动即可用。
- 读面：
  - `documentPath`：被编辑的 profile patch 路径（`profileContext.patchPath`）。
  - `entries(): Entry[]`：**仅**返回 root Include 直属、且 `id` 唯一的行（`lib/index.js` `entries()`：按 `entry.parent.tree.ctx.fiber.entry?.id === "include"` 过滤 + 同 id 去重）→ 嵌套 Include 里的行不可编辑（官方已知限制）。
  - `configuration(): { entry, inherited, override }[]`：`inherited` = 去掉本行 override 后的组合值，`override` = 本行 patch 里的显式值（均为 detached 拷贝）。
- 写面：`edit(entry, change)`，`change: (current, inherited) => Record<string, unknown>`：
  1. `withFileLock(profile/package.json)` 串行化，并与 HMR 队列串行（`hmr.runExclusive`）；
  2. 先 `reconcileProfilePatches` 对账外部改动，再校验 `entry` 仍是活跃条目（`fiber.state === 2`）；
  3. `next = change(current, inherited)` → 过插件 `internal/config` waterfall + `resolveConfig` 校验（**无效值在此抛出，文件不动**）；
  4. 用 `yaml` 文档级改写 patch（保留注释与 `!!js` 表达式；`next` 等于 `inherited` 时删掉该行 `config`）；
  5. 组合后复核「该行实际生效值 === next」，不等则抛 `Configuration for "<id>" is overridden by a home patch or command-line overlay`；
  6. `writeFileAtomic` 落盘 → `reconcileProfilePatches([id])`；对账失败会**回滚文件**并重放旧 patches。
- 失败文案（TUI 侧原样透出即可定位）：`Configuration entry is no longer available`、`Configuration entry changed during reload`、`Configuration plugin is no longer active`、上面那条「overridden by a home patch or command-line overlay」、YAML 解析错误与 `resolveConfig` 校验错误。

### 2. TUI 侧现状（与条目正文的差异）

- 条目正文说「TUI 未消费该服务，只有 `/config` 只读展示（`TUI/src/app/commands.ts:304`）」——**实测不符**：全仓 `grep -rn "config" TUI/src/app/commands.ts` 零命中，`:304` 附近是 `/settings`（`desc: "只读展示配置（ns：value，secret 脱敏）"`）。只读展示的真身是 `handleSettingsCommand`（`TUI/src/app/index.ts:4880`），读的是宿主 `settings.describe()`（`TUI/src/app/adapter/dsh.ts:3722`），与插件条目 config 无关。故本任务的起点是「TUI 完全没有条目配置编辑面」，不是「改进既有 `/config`」。
- 可选服务的接线口径：`main.ts` 一次性读 `ctx.get(...)` 传给 App / adapter；会与插件树并发装载的服务用**惰读 getter**（`guard` / `knowledge` / `sessionChannel` 三处注释已说明「apply 期快照会是 undefined」）。`configEditor` 属同一类，必须惰读。
- 命令面：目录在 `TUI/src/app/commands.ts`（`LOCAL_COMMANDS` + `routeSlashCommand`），分派在 `TUI/src/app/index.ts` 的 `routeSlash` switch，参数解析用 `slashCommandArg(line)`；提示用 `this.notice(text, tone)`。adapter 侧可选方法以 `?(): Promise<...>` 形式挂在 `DshAdapter`（`TUI/src/app/adapter/types.ts`），实现放 `TUI/src/app/adapter/dsh.ts`，App 侧判空后给降级提示。

### 3. 与 #5 的耦合

编辑**本行（tui）**的 config 会走 TUI 自己的 `internal/update` 否决钩子（可热应用 `theme` 就地生效，其余提示需重启）；编辑**其它行**会触发该行重载，退出风险由 #5 处理（本条目只负责发起编辑）。

## 决策

**决策项 1（编辑面形态）**

- a 命令 + 逐项编辑（`/config` 列表、`/config show <id>` 明细、`/config set` / `/config unset` 单点写入）
- b 提交式面板（面板里改多个字段后一次 `edit()`）

选定 **a**。理由：复用既有 slash 命令 + notice 基建（`commands.ts` / `routeSlash` / `notice`），零新面板状态机；配置值多为标量、逐项写入与 `configEditor.edit()` 的「完整候选值」语义天然对齐（每次写入都会带完整 config）；b 需要新写多字段编辑 UI 与校验展示，工作量与回归面都远超本条目（P2）的收益。

**决策项 2（写路径）**

- a 全部经 `configEditor.edit(entry, change)`
- b TUI 直接读写 profile patch YAML

选定 **a**。理由：条目要求的就是这一条；`edit()` 已包办校验 / 原子写 / 与 HMR 串行 / 失败回滚 / 更高层覆盖拒绝，b 会重复实现且必然漏掉「home patch 覆盖」判定。

**决策项 3（寻址与陈旧对象）**

- a 按条目 `id` 寻址，写入时用 `entries()` 重新解析出当前 `Entry` 对象
- b 列表阶段缓存 `Entry` 对象，写入时直接用缓存

选定 **a**。理由：HMR 重载后 `Entry` 对象会被替换（`edit()` 自己也以「条目是否仍在活跃集合 / 是否被替换」做守卫）；缓存对象会让每次编辑在重载后报 `Configuration entry is no longer available`。a 用 id 重新解析，与宿主的守卫语义一致。

**决策项 4（值语法）**

- a `key=value`，`key` 支持点路径（如 `rules`、`approval.timeoutMs`）；值先按 JSON 解析，失败则当字符串
- b 只接受整段 JSON 对象替换该行 config
- c 只接受扁平标量键

选定 **a**。理由：日常改动是单键（`theme`、`defaultMaxGoalRounds`、`dbPath` 之类），点路径覆盖嵌套；JSON 优先让 `true` / `42` / `[1,2]` / `{"a":1}` 都能写，写不成 JSON 的裸串保持字符串（不引入 YAML 解析器，避免与 patch 的 `!!js` 语义混淆）。b 每次都要重述整份 config（会把继承值钉进本层，官方已知限制），c 写不了 `rules` 这类数组/对象。

**决策项 5（服务缺失）**

- a 提示「config-editor 未挂载」并停止（不做只读列表）
- b 只读列出条目（需另找数据源）

选定 **a**。理由：条目数据只有 `configEditor` 一个来源（`loader.entries()` 是宿主内部面，TUI 不宜直连）；没有服务就没有可信的「可编辑集合」，只读列表会给出可编辑的假象。

**决策项 6（拒绝与失败的呈现）**

- a 原样透出宿主错误文案（前缀「编辑失败：」）+ 保留 TUI 自己的前置校验文案（缺参 / 空键 / 非 JSON 的提示）
- b 统一改写成 TUI 自造文案

选定 **a**。理由：宿主文案已区分「条目消失 / 被替换 / 更高层覆盖 / 校验失败」，改写给排查添噪声；TUI 只补自己的前置校验。

## 规划

### 任务拆分

1. 纯函数层（`config-edit.ts`）：子命令判定、`key=value` 解析、点路径 set/del、条目列表与明细格式化。
2. 服务接线：`main.ts` 惰读 `configEditor` → adapter 选项；adapter 暴露 `configEntries()` / `editConfigEntry()`（把 `Entry` 归一成纯数据）。
3. 命令层：`commands.ts` 目录项 + `index.ts` 分派与 `handleConfigCommand`（含降级与错误文案）。
4. 单测：纯函数全覆盖 + App 层服务缺失 / 成功 / 抛错三条路径。

### 计划改动文件清单

- `TUI/src/app/config-edit.ts`（新增：纯函数 + 类型）
- `TUI/src/app/adapter/types.ts`（`ConfigEditorLike` 结构面、`ConfigEntrySummary`、adapter 两个可选方法、`RealAdapterOptions.configEditor`）
- `TUI/src/app/adapter/dsh.ts`（实现上述两个方法）
- `TUI/src/app/commands.ts`（`/config` 目录项）
- `TUI/src/app/index.ts`（`case "config"` 与 `handleConfigCommand`）
- `TUI/src/main.ts`（惰读 `ctx.get('configEditor')` 并传入 adapter）
- `TUI/tests/config-edit.test.ts`（新增）

### 明确不做

- 不做全文 patch 编辑器 / 不做插件启停与装卸（`plugin-manager` 面）。
- 不碰 `/settings` 的读面语义，也不新增第二套配置读面。
- 不改 `TUI/docs/SPEC.md`、`TUI/README.md`、`COMMANDS*.md` 与两级 BACKLOG（按并行约定归共享文档线）。

### 验收

- 单测：`key=value` 解析（点路径 / JSON 值 / 裸串 / 缺 `=` / 空键）、点路径 set 与 unset（不改原对象）、条目列表与明细格式、服务缺失降级、`edit()` 抛错文案透出。
- `cd TUI && npm run check` 与 `cd TUI && npm test` 全绿。
- 真机验收（改一条真实插件条目、观察 patch 落盘与生效）由用户安排；本次按指令不做真机验收。

## 实现记录

- 2026-10-23：新增 `TUI/src/app/config-edit.ts`（纯逻辑：`parseConfigCommand` 子命令决策、`parseConfigKeyPath` / `parseConfigValue`、不可变 `setConfigPath` / `deleteConfigPath`、列表与明细格式化、`CONFIG_USAGE`）；点路径拒绝 `__proto__` / `prototype` / `constructor`。
- 2026-10-23：`TUI/src/app/adapter/types.ts` 增 `ConfigEditorLike` / `ConfigEditorEntryLike` / `ConfigEditorRowLike` / `ConfigEntrySummary`、adapter 两个可选方法 `configEntries` / `editConfigEntry`、`RealAdapterOptions.configEditor`；`TUI/src/app/adapter/dsh.ts` 实现两个方法（列表走 `configuration()` 归一成纯数据，写入按 id 重新解析 `entries()` 再调 `edit()`）。
- 2026-10-23：`TUI/src/app/commands.ts` 增 `/config` 目录项与 `SlashRoute` 成员；`TUI/src/app/index.ts` 增 `case "config"` 与 `handleConfigCommand`（列表 / show / set / unset，缺服务降级，宿主错误统一「编辑失败：」前缀）；`TUI/src/main.ts` 以惰读 getter 传入 `ctx.get('configEditor')`。
- 2026-10-23：既有用例 `TUI/tests/completion.test.ts` 的补全候选断言同步加入 `/config`（目录变更的必要索引更新，不是新用例）。

## 测试与证据

- 新增 `TUI/tests/config-edit.test.ts`（20 例）：命令解析 6 例（list / show / set / unset / usage 各失败分支、点路径与 JSON 值）、点路径 3 例（嵌套创建与不可变、中间层标量拒绝、删除命中 / 缺失 / 非对象）、格式化 2 例、App 层 9 例（列表、服务缺失两种、show 命中与未命中、set 透传 change、宿主拒绝文案透出、unset 未改动、缺参不调 adapter）。
- `TUI/tests/adapter.dsh.test.ts` 追加 4 例：`configuration()` 归一化（含丢弃空 id 行）、服务缺失与 `configuration` 缺失 → undefined、edit 收到按 id 重新解析的 Entry 并透传 change 结果、三类 reject 原因（未挂载 / 不在集合内 / 宿主拒绝原文）。
- 命令结果（2026-10-23，worktree `.worktree/b-app`）：
  - `cd TUI && npm run check` → 通过（tsc --noEmit）；
  - `cd TUI && npm run build` → 通过；
  - `cd TUI && npm test` → `tests 1707 / pass 1707 / fail 0`（改动前基线 1683，新增 24 例）。
- 真机验收（改真实插件条目并观察 patch 落盘与生效）按指令未做，留给用户。

## 真机验收（2026-10-23，主分支）

**做法**：herdr 新 tab 起 `fffdsh`（profile `fff`，工作区仓库根），在该会话里依次执行 `/config list`、`show`、`set`、`unset`；改动对象取 `output-compress`（非 TUI 行，无副作用键 `minBytes`）。

**通过项**：

- `/config list` 列出 50 条条目（`id` / `name` / `override` 列），`/config show output-compress` 分「override（本行 patch 显式值）/ inherited」两段展示。
- `/config set output-compress minBytes=32768` → 回执「已写入」，profile patch 原子出现 `config: minBytes: 32768`，会话未重启；随后的 `show` 显示 override `minBytes: 32768`，说明新值已生效。
- `/config unset output-compress minBytes` → 回执「已删除（该键回到继承值）」。

**缺陷 1（P1，无效值未被拒）**：`/config set output-compress minBytes=abc` 返回「已写入 output-compress: minBytes = "abc"」，patch 实际落入 `minBytes: abc`。含义是任何字符串都能写进配置，宿主 `configEditor.edit()` 未按插件期望类型校验（该插件 `OutputCompressConfig.minBytes?: number`）。与「验收」中「无效值被拒且文件不变」相反；插件下次加载会拿到错类型（`??` 兜底只挡 `undefined`，字符串会一路带到比较 / 算术里）。

- 待定修法：① 宿主侧按 schema 校验（跨包，属官方面）；② TUI 侧对已知键做类型拒绝（需自带类型表，易与插件漂移）；③ 只做「非标量结构合法性」校验并在文档写明不做类型校验。倾向 ①＋③。

**缺陷 2（P2，unset 连条目一起删）**：`/config unset output-compress minBytes` 后，profile patch 里 `- id: output-compress` 整条连同其注释一并消失，而非只删 `config` 下的键。功能未受损（bundle 的 `- insert:` 仍提供该条目，默认值生效），但用户 patch 的显式条目与注释丢失。

- 待定：这是宿主写的归一化（空 config 的条目视为冗余即删）还是本轮 TUI 判定的副作用，需要读 `configEditor.edit()` 的写回实现确认；若属后者则 TUI 侧应在删除后判断「条目是否仍应保留」。

**副作用（记录，非缺陷）**：宿主写回会**重排整份 profile patch**——长字符串折行、空行归一；本次文件从 15695 字节变为 15433 字节，逻辑内容等价（除缺陷 2 删掉的那条）。这在预期内，但意味着「改一个键」会产生整文件级 diff。

**未覆盖**：越权 / 更高层覆盖字段的表现（未构造双层覆盖）；`configEditor` 服务缺失时的降级未真机跑（仅有单测）；`/config set` 对 `!!js` 表达式值（如 `memory-base` 的 `dbPath`）未试。

**清理**：两个测试 tab 已关闭；探测用的注释行与 `minBytes` 均已从 profile patch 移除（该条目因缺陷 2 已被宿主删去，功能由 bundle 提供）。

## 继续修改（2026-10-23，缺陷 1 / 2）

按指令沿用本条目与本文件，不新开条目 / 追踪文档；只改 `TUI/src`、`TUI/tests` 与本文件，未 commit。

### 缺陷 1：无效值未被拒（P1）

**根因（宿主校验空转）**：`dsh-config-editor` 的 `edit()` 在写盘前唯一的类型关是
`resolveConfig(fiber.runtime, resolved)`；`resolveConfig`（cordis `lib/index.js:956`）在
`runtime.Config` 缺席时**原样返回配置**。本仓 30 个插件按契约把 `Config` 写成 TS 类型别名
（如 `output-compress` 的 `export type Config = OutputCompressConfig`，编译后运行时不存在），
故 `minBytes: "abc"` 一路落到 profile patch。宿主也没有第二个类型源：`Entry` 只有
`options.config`（原始值）与 `moduleNamespace`（模块导出，类型别名不含运行时值），
`entry.fiber.runtime.Config` 是唯一 schema 面，对无 schema 插件为空。

**方案与取舍**：

- a 宿主 / 插件侧加运行时 schema（让各包导出 schemastery `Config`）：唯一权威解，但要改 30 个包并迁移
  用户 patch，跨包且超出本条目边界，另行立项。
- b TUI 侧已知键类型表（选定）：`CONFIG_KEY_TYPES` 按「条目 id + 点路径」登记
  `number` / `boolean` / `string` / `array` / `object` 与字符串枚举。最小集只收 TUI 自己的键
  （与 `DshTuiConfig` 同源，无漂移）与真机验收暴露的 `output-compress` 三个键。
- c 既有值类别兜底（选定，作为 b 的补充而非替代）：表外键用 `change(current, inherited)` 的既有值
  做同路径类别一致性判断（已是 number 的键不接受 string）；既有值为 `null` 或 `!!js` 表达式
  （`{ __jsExpr }`）时视为无类型信息放行；两处都无信息 → 放行（首次写入的新键只能靠表）。
- 落点：校验在 `change` 回调内执行，`configEditor.edit()` 在 `readFile` / `writeFileAtomic` 之前调用它，
  抛 `ConfigValueError` 即中止、patch 保持原样；App 用「值校验失败：…；未写入 profile patch」提示，
  与宿主错误（「编辑失败：…」）区分。

**漂移风险（明写）**：类型表是手维护的，插件改字段类型 / 改名后表不会跟随；错表项会**误拒合法值**
（提示可见、改一行即可修），不会静默写坏配置。表只登记**无运行时 schema** 的插件键——有 schema 的插件
由宿主 `resolveConfig` 校验，再登记会盖过权威 schema；新增键 = 表里加一行。

### 缺陷 2：unset 连条目一起删（P2）

**根因（宿主写回归一化，已读源码确认）**：`dsh-config-editor/lib/index.js:99-104`——当
`isDeepStrictEqual(next, inherited)` 成立（删掉该行最后一个 override 键后，候选值 = 继承值）时，
宿主遍历所有同 `id` 的行：`row.delete("config")`，随后
`if (row.items.length === Number(row.has("id")) + Number(row.has("name"))) document.delete(index)`
把只剩 id / name 的行**整行删除**，行上注释随之消失。不是 TUI 判定：TUI 送出的 `next` 只是删了键的副本。

**为什么不能从 TUI 阻止**：`edit()` 是唯一写路径（决策项 2）；要绕过归一化只能让 `next` 不等于 inherited，
即往用户 patch 里钉一个等于继承值的键——正是本条目要避免的「把继承值复制进本层」，不做。
故按任务给兜底提示：unset 命中该分支时回执
「已删除 …；本行已无 override，宿主归一化连同注释删掉了该 profile 行（条目仍由 bundle 的 insert 提供，生效值即 inherited）」。
同一归一化也作用于「set 的值恰好等于 inherited」：`/config set` 会给出「等于 inherited；宿主归一化删掉了本行
override 与其注释」的 warn 提示（`configsEqual` 预判，判据与宿主同为 `isDeepStrictEqual`）。

### 改动文件

- `TUI/src/app/config-edit.ts`：新增 `CONFIG_KEY_TYPES` / `ConfigValueError` / `configValueKind` /
  `readConfigPath` / `validateConfigSetValue` / `configsEqual`（内部判据 `isJsExpression`）。
- `TUI/src/app/index.ts`：`handleConfigCommand` 的 `change` 内值校验、归一化预判与提示文案、
  「值校验失败」错误分支。
- `TUI/tests/config-edit.test.ts`：新增 10 例——值类别与点路径读取、类型表（number / 枚举 / 子路径不误用）、
  既有值兜底（current / inherited / `null` / `!!js` 放行 / 无信息放行）、`configsEqual`；
  App 层：无效值被拒且 patch 不变、正确值写入、表外键类型不一致被拦、unset 删末键的归一化提示、
  仍有其它键时只提示回到继承值、set 等于 inherited 的提示。假 adapter 改为维护 `patch` / `writes`，
  使「不写盘」可直接断言。

### 验证

- `cd TUI && npm run check` → 通过；`cd TUI && npm run build` → 通过。
- `cd TUI && npm test` → `tests 1730 / pass 1730 / fail 0`（本文件 20 → 30 例，+10；其余文件未动）。
- 未做真机复验（按指令留工作区等批准）。复验口径：`/config set output-compress minBytes=abc` 应报
  「值校验失败：output-compress.minBytes 期望 number」且 patch 不变；`/config unset` 删掉末键后应看到归一化提示。

### 未做 / 存疑

- 类型表只覆盖 11 个键，其余键靠既有值兜底；插件导出运行时 schema 才是权威解（跨包，另行立项）。
- 嵌套键只在「整路径命中表项」或「同路径已有值」时校验；数组 / 对象的元素级类型不查。
- 缺陷 2 的「条目保留」在宿主侧不可控（已记不可控 + 提示兜底）；要真正保留需宿主区分「空 config 行」
  与「用户显式行」，属官方面。
- 真机验收那节记录的「写回重排整份 patch」副作用未改（非缺陷）。
