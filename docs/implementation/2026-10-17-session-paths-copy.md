# 新增 session-paths 插件：复刻宿主的会话目录编码（接取条目：`docs/BACKLOG.md`「新增 `session-paths` 插件：复刻宿主的会话目录编码，供其他插件共用」）

状态：决策（2026-10-17）　　开启：2026-10-17　　关闭：未关闭
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮范围：调研 + 决策，不写实现代码（用户 2026-10-17 指示：添加条目和追踪文档即可、决策后结束）。工作区：主检出 `main`。

## 目标

把「宿主把会话目录放在哪」这件事从各插件各自复刻、各自写错，收敛成一个仓内共有的事实源：新增轻量包 `session-paths`，忠实复刻宿主的目录编码并以服务形态供其他插件调用；消费方（memory-base 的 S 层、可选 output-compress）改为经它取路径。

## 调研

来源：宿主包 `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`（只读）、本机 `~/.dsh/sessions/` 实测、仓内 `memory-base/src/router.ts` 与两份追踪文档。

1. **宿主的编码算法**（该文件内部函数，**均不导出**；包只导出 `JsonlCompressionSchema` 与默认类）：
   - `encodeSegment(raw)`（`:853-865`）：空串抛错；`.` → `~002E`、`..` → `~002E~002E`；逐字符保留 `[A-Za-z0-9._-]`（`~` 除外），其余转成 `~XXXX`（4 位大写十六进制码位）。
   - `projectKey(cwd)`（`:875-894`）：空串抛错；`/` `\` `:` 归一为 `-` 且**连续分隔符合并成一个**；其余字符同 `~XXXX` 转义；最后返回 `--<readable 去掉前导 - ，空则 "root">--`，并 `.slice(0, 251)` 截断。注释自述「分隔符替换与截断**有意有损**」。
   - `projectDir(root, cwd)`（`:902-905`）：`join(root, projectKey(cwd))`；`cwd === undefined` 时 `join(root, "_no-cwd")`。
   - `sessionDir(root, cwd, id)`（`:912-914`）：`join(projectDir(root, cwd), encodeSegment(id))`；注释说明它是「**The directory owned by one session and available for future session-local artifacts**」—— 本就是给每会话本地产物准备的。
2. **拿不到**：`dsh-session` / `dsh-session-persistence` 里没有任何面向插件的目录读取面；`memory-base/src/router.ts:10-11` 的注释也记着「宿主 0.2.0-rc.2 未暴露「会话目录」读取面」。
3. **本机实测的桶名**（`~/.dsh/sessions/`，可作对拍向量）：`--home-guochang--`、`--home-guochang-.dsh--`、`--home-guochang-.dsh-profiles-tui--`、`--home-guochang-fff--`、`--home-guochang-Projects-dsh-toolset--`、`--home-guochang-Projects-dsh-toolset-.worktree-preference-analysis--`、`--home-guochang-Projects-RTEMS--`；会话子目录是裸的 uuid（如 `07bd659f-f134-44de-9946-8c9f7575af28`）。可见 `.` 属白名单字符（`.dsh` 原样保留）、分隔符连续出现时被合并。
4. **仓内那份复刻是错的且无人用**：`memory-base/src/router.ts:70-79` 的 `sessionDirFor` 只做「去前导斜杠 + 分隔符换 `-`」，既无 `--…--` 外壳、也无 `~XXXX` 转义与 251 截断，算出的路径（`~/.dsh/sessions/home-guochang-Projects-dsh-toolset/<id>`）**并不存在**；全仓 grep 只有定义与文档，无调用点。
5. **它卡住谁**：memory-base 重设去掉 `dbPath`、层级恒开启后，S 层没有可推导的落点（不配 `tiers.sessionDir` 就写不进 S 层）；output-compress 的「把 `is_error` digest 推进 memory-base 的 `session` 层」也依赖同一件事。
6. **既有口径可循**：仓内已有多处「按约定把宿主的常量 / 小函数复制一份、注释标注出处」的先例（如 output-compress 的 `deny-patterns.ts` 与 memory-base `rules.ts` 的同源复制 + 对拍测试），故「复制宿主函数」不是新做法，本任务只是把它从「每包各一份」收敛成「一个包提供」。

## 决策

决策项 1　包与服务的形态

- a) **轻量包 `session-paths`，服务键 `sessionPaths`，纯函数 + 一个显式落盘函数**
- b) 并把能力塞进既有包（如 `fs-digest` / `command-template`）
- c) 各插件各自复刻（现状）

**选定 a**。理由：这是「宿主约定」这一件事的单一事实源，与任何既有包的职责都不搭（b 会让别的包背上无关契约）；c 已经证明会漂移 —— 仓内那份复刻就是错的。形态照 `md-table-check/` 的轻量包模板。

决策项 2　服务面（签名与边界语义见「规划」的「实现前冻结的接口」）

- a) **`root()` / `projectKey(cwd)` / `projectDir(cwd)` / `sessionDir(cwd, sessionId)` 四个纯函数 + `ensureSessionDir(cwd, sessionId)` 一个显式落盘函数**
- b) 只给 `sessionDir`，其余不暴露
- c) 连 `ensure*` 一并省掉（只算路径）

**选定 a**。理由：`root()` 让消费方能报告与排障（缺省 `dshHomePath('sessions')`，可经配置覆盖）；`projectKey` / `projectDir` 是对拍测试与排障需要的中间量；`ensureSessionDir` 解决的问题是「宿主已建目录，但恢复会话 / 桶被清理时可能不在」，而仓内「不静默建目录」的口径针对的是**静默换路径**，显式调用 `ensureSessionDir` 不属于静默 —— 所以它提供、但只由调用方显式调用，四个纯函数一律不落盘、目录不存在也不报错。

决策项 3　消费方怎么接

- a) **消费方改为经服务面取目录，仓内不再保留第二份复刻**
- b) 消费方各自留一份本地副本
- c) 只让 memory-base 接

**选定 a**。理由：留下第二份就等于把这次的漂移问题原样保留；`memory-base/src/router.ts:70-79` 那份错的复刻**直接删掉**，`resolveTierPaths` 继续保持纯函数（它本来就以 `sessionDir` 作为入参），改由 `index.ts` 在需要时向服务要目录。跨包依赖方向是「存储包依赖一个零依赖的工具包」，可接受；该包缺失时 memory-base 的 S 层按「不可用即明示例外」处理（不退化、不静默）。

决策项 4　会话 id 与 cwd 从哪来（实现时要用到的两个入参）

- a) **由调用方显式给**：`sessionDir(cwd, sessionId)` 的两个参数都由调用方提供，本包不猜
- b) 本包自己订阅 `session/event` 去记当前会话
- c) 只给 `sessionId`，cwd 用 `process.cwd()`

**选定 a**。理由：b 会把「订阅会话事件」这件与本包职责无关的事塞进来（而且 memory-base 重设后本仓已不再订阅事件）；c 的 `process.cwd()` 与「会话的 cwd」在宿主里不是同一个概念（会话可带 `header.cwd`）。**留给实现阶段的一处开口**：memory-base 的 S 层写入要拿到 cwd 与 sessionId —— 现有句柄 `put` 只有 `sessionId?`，实现时需要补一个 cwd 来源（显式参数或由调用方传入的 `sessionDir`），记进「规划」的开口清单。

决策项 5　output-compress 的 `digest.db` 是否回到「每会话一个文件」

- a) **本轮不改**（维持已修好的 `~/.dsh/output-compress/digest.db`，全机一个文件，会话维度靠表内 `session_id`）
- b) 借本包改回「每会话一个文件」（D60 原意）

~~**选定 a**~~ → **改选 b（用户 2026-10-17 裁定「改回去」）**：`digest.db` 回到 D60 原意 —— **每会话一个文件**，落在宿主会话目录里，路径经本服务推导。

落地口径（同时写进 output-compress 的规划与决策项 9）：

- `output-compress/src/hooks.ts`：在 `session/event` 的会话视图里宽容读取 `header.cwd`（它已经拿到 `session.id`，见 `:161-162`），经 `sessionPaths.sessionDir(cwd, sessionId)` 推导落点；取不到 cwd 时按既有口径降级为 `skipped.session-dir-missing` + 计数。
- 配置键 `sessionDir` 退为**显式覆盖**（配了就优先用它）；因此 profile 里那行在本改动落地时要删掉（现在先留着，否则代码改完之前管线又会变回全跳过）。
- 早前「一行配置的事」的说法作废：这是代码改动，估 1 至 2 小时含用例，且**本包未落地前无法开工**。
- 附带后果照实记：digest 从此**只在本会话可见**（跨会话检索不再覆盖未推送到 memory-base 的 digest；`is_error` 的摘要仍会经句柄进 memory-base，那条路不受影响）；`digest.db` 的 100 MB 上限变成「每会话每文件」。

## 规划

### 实现前冻结的接口（消费方按此写）

配置面（`cordis.patch.yml` 的 `config`）：

```ts
interface SessionPathsConfig {
  /** sessions 根；缺省读环境变量 `DSH_HOME` → `<DSH_HOME>/sessions`，无该变量回落到 `~/.dsh/sessions`。 */
  root?: string;
}
```

服务面（`ctx.get('sessionPaths')`）：

```ts
interface SessionPathsService {
  /** 已 resolve 的绝对路径。 */
  root(): string;
  /** 宿主 projectKey 的忠实复刻（`--…--` 外壳 / `~XXXX` 转义 / 251 截断）。 */
  projectKey(cwd: string): string;
  /** `cwd` 缺失 → `<root>/_no-cwd`。 */
  projectDir(cwd: string | undefined): string;
  /** `<projectDir>/<encodeSegment(sessionId)>`。 */
  sessionDir(cwd: string | undefined, sessionId: string): string;
  /** 唯一写盘入口：`mkdir -p`（0700）、幂等，返回目录路径。 */
  ensureSessionDir(cwd: string | undefined, sessionId: string): Promise<string>;
}
```

边界语义四条：

1. 四个纯函数**不落盘**、**不因目录不存在报错**；只在入参非法时按宿主同语义抛（空 `cwd` / 空 `sessionId`）。
2. `ensureSessionDir` 是**唯一写盘入口**，权限 0700、幂等；纯函数永不调用它。
3. 服务缺失时由调用方自行降级：memory-base → S 层不可用（写该层报错 + 启动日志说一次）；output-compress → `skipped.session-dir-missing`。
4. 复刻范围与出处写进 `src/encode.ts` 的注释（来源 `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:853-914`），宿主升级后按注释复核。

### 依赖读取方式（定案）

消费方**不硬 `inject`，用可选读取**：`memory-base` 在 apply 时 `ctx.get('sessionPaths')` 取一次、需要 S 层落点时复取（服务可能晚挂载）；取不到 → S 层不可用并在启动日志里说一次。理由：硬 `inject` 会让「本包未挂载」直接拦住 memory-base 的加载，而它的 P / U 层本来不依赖本包。

### 任务拆分（5 步，每步带中间验证）

1. **起包骨架** —— 照 `md-table-check/` 复制 `package.json` / `cordis.patch.yml` / `tsconfig.json` / `tests/tsconfig.json` / `.gitignore` / `LICENSE`；`package.json` 的 `dsh.bundle` 与 `provide` 声明服务键 `sessionPaths`。验证：`npm --prefix session-paths run check` 通过（空实现）。
2. **复刻编码 + 对拍** —— `src/encode.ts` 写四个纯函数（含来源注释）；`tests/encode.test.ts` 表驱动对拍：本机七个真实桶名 + 合成向量（非白名单字符的 `~XXXX`、连续分隔符合并、`_no-cwd`、`.` 与 `..`、超长路径 251 截断、空入参抛错）。验证：`npm --prefix session-paths run test` 全绿。
3. **服务注册与配置归一** —— `src/main.ts`：配置归一（`root` 缺省读 `DSH_HOME`）、`provide('sessionPaths')`、`ensureSessionDir` 的 0700 与幂等、`README.md`（契约与出处）。验证：`check` + `test` + 一例「假 ctx 拿服务并核对返回值」的用例。
4. **接线 7 处** —— 根 `package.json`（check / build 链）、`scripts/install.sh`（`canonical_pkgs`）、`scripts/test-parallel.sh`（`default_pkgs`）、`profiles/example/cordis.patch.yml`（挂载行，**排在 memory-base 之前**，保证服务先注册）、`README.md` + `README.zh.md`（清单与包数）、`AGENTS.md`（插件清单与计数）、`docs/BACKLOG.md` §4 插件规划表。验证：`npm run check` / `npm run build` / `npm run test` 全绿；`scripts/install.sh --dry-run` 的清单含本包。
5. **消费方接入与联调** —— memory-base 的 S 层改为经服务取目录（删掉 `src/router.ts` 那份错的 `sessionDirFor`）。**归属注明**：这一步的代码落在 memory-base；按用户口径可与本包同批做，若分两批则本包只交付契约与联调用例，接入归 memory-base 的实现。验证：memory-base 的 S 层落点用例 + 真机重启 profile 后确认 S 库落在 `<sessions root>/<projectKey>/<sessionId>/` 下。

### 本轮（调研 + 决策）改动文件清单

- `docs/BACKLOG.md`：新增条目「新增 `session-paths` 插件：复刻宿主的会话目录编码，供其他插件共用」并标〔进行中: 2026-10-17〕
- `docs/implementation/2026-10-17-session-paths-copy.md`（本文件）
- `memory-base/docs/implementation/2026-10-17-slim-and-storage-surfaces.md`：在它的「跨任务发现」处记下本条裁定（S 层改为经服务面取目录、实现顺序排在本包之后）
- `docs/implementation/2026-10-17-output-compress-scope-handle.md`：同上，记下受影响的决策项 2 与 8

### 实现阶段改动文件清单

- 新包 `session-paths/`：`package.json`、`cordis.patch.yml`、`tsconfig.json`、`tests/tsconfig.json`、`.gitignore`、`LICENSE`、`README.md`、`src/main.ts`（服务注册与配置归一）、`src/encode.ts`（复刻的四个纯函数 + 来源注释）、`tests/encode.test.ts`（对拍）、`tests/service.test.ts`（假 ctx 的服务面用例）
- 接线 7 处（见项目级条目「五个新插件落地时的仓库清单与包计数统一」）：根 `package.json`（check / build 链）、`scripts/install.sh`（`canonical_pkgs`）、`scripts/test-parallel.sh`（`default_pkgs`）、`profiles/example/cordis.patch.yml`（挂载行，排在 memory-base 之前）、`README.md` + `README.zh.md`（清单与包数）、`AGENTS.md`（插件清单与计数）、`docs/BACKLOG.md` §4 插件规划表；**该条目的标数会因本包 +1，需一并同步**
- 消费方（代码落在 memory-base，归它的实现）：`memory-base/src/router.ts`（删掉那份错的 `sessionDirFor`）、`memory-base/src/index.ts`（向服务要 S 层目录）、`memory-base/tests/`（S 层落点用例）
- `docs/BACKLOG.md`：条目状态回写（完成时标「完成」并移除）

明确不做：不做任何存储或建库（本包只算路径 + 一个显式 `ensureSessionDir`）；不订阅 `session/event`、不猜 `cwd`（决策项 4）；不改 output-compress 的 `digest.db` 落点（决策项 5）；不动宿主的任何东西；不改 TUI。

### 实现阶段的验证口径

- **对拍（单测）**：`tests/encode.test.ts` 表驱动 —— 本机七个真实桶名 + 五类合成向量（`~XXXX` 转义 / 连续分隔符合并 / `_no-cwd` / `.` 与 `..` / 251 截断）；断言用**逐字符相等**，不用「包含」。
- **接线（机械）**：`npm run check` + `npm run build` + `npm run test` 三件全绿；`scripts/install.sh --dry-run` 的包清单含本包。
- **真机**：重启一次 `dsh --profile fff`，确认 memory-base 的 S 库落在 `<sessions root>/<projectKey>/<sessionId>/` 下。
- **不做**：不核对宿主升级后的编码漂移（留到宿主升级时按 `encode.ts` 注释里的出处复核，属另一次任务）。

### 收尾动作（实现完成时）

- 条目「新增 `session-paths` 插件：复刻宿主的会话目录编码，供其他插件共用」标「完成」并从 `docs/BACKLOG.md` 移除；本文件移入 `docs/archived/`。
- 回写 `docs/BACKLOG.md` §4 与条目「五个新插件落地时的仓库清单与包计数统一」的标数（因本包 **+1**）。
- 实现期剩下一处开口：memory-base 的 S 层写入如何拿到 `cwd`（属它的实现，见第 5 步）。

## 实现记录

（本轮为决策轮，未进入实现；待用户审定后按「规划」清单执行。）

## 偏差

无（本轮只做调研与决策，未承诺实现动作）。

## 测试与证据

本轮为决策轮，未改代码，故未跑 `check` / `build` / `test`；调研阶段的事实证据：

- `sed -n '853,914p' ~/.local/share/fnm/.../@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`（只读）：`encodeSegment` / `projectKey` / `projectDir` / `sessionDir` 的完整实现与注释。
- `grep -n "^export" 同文件`：只导出 `JsonlCompressionSchema` 与默认类 → 四个函数不对外。
- `ls ~/.dsh/sessions/`：七个真实桶名（见调研 3），其中 `.dsh` 与 `.worktree-…` 两例可用于验证「`.` 在白名单」与「连续分隔符合并」。
- `grep -rn "sessionDirFor" --include=*.ts .`（排除 `.worktree/`）：只有 `memory-base/src/router.ts` 的定义与注释，无调用点。
- 未核实：真实桶里没有出现 `~XXXX` 转义与 251 截断的样本，二者只能靠合成的表驱动用例覆盖（实现阶段）。
- 未核实：`root`（`~/.dsh/sessions`）在宿主侧是否可配置成别的路径；本包按「缺省 `dshHomePath('sessions')` + 可配置覆盖」处理。

## 收尾

- **用户审定（2026-10-17）**：决策项 1 至 4「没有问题」，决策项 5 定为「改回去」—— 五项全部落定，可实现。
- 本轮不归档：条目保持〔进行中: 2026-10-17〕，本文件留在 `docs/implementation/`，等开工后按「规划」清单执行。
- 回写文档：本轮无（实现阶段才动 README / AGENTS.md / 包计数）。
- 遗留项：① memory-base 与本条的实现顺序（本包先，或 memory-base 先按「S 层不可用是明示例外」落地）；② 实现阶段的两处开口（cwd 来源、`ensureSessionDir` 权限口径）；③ 条目「五个新插件落地时的仓库清单与包计数统一」的标数需因本包 +1。
