# script-interpreter Python venv / uv 自动探测（接取条目：script-interpreter/docs/BACKLOG.md「Python venv / uv 自动探测」）

状态：关闭　　开启：2026-10-19　　关闭：2026-10-19
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

在现有解释器路径覆盖（`pythonPath` / `SCRIPT_PY_INTERPRETER`）之外，按工作区探测 `.venv/bin/python`，或支持 `uv` 前缀；**不**自作主张改 `sys.path`；探测不到时回落当前解释器。验收按条目：有 / 无 `.venv` 两态各一例，且解释器路径写进回执。

## 调研

来源：本 worktree 只读检视 + 本机实测（2026-10-19）+ 上一任务（语言后端）同期检视。

- **R1 现状代码**：`src/probe.ts` 是四级链「显式配置 → 环境变量 → PATH → 常见绝对路径」，配了不可执行就不回落；`apply`（`src/index.ts`）在装配期**一次性**探测并缓存进 `EnabledLanguage.interpreter`，`execute`（`src/tools.ts`）直接用缓存值，不做二次探测。探测链与 README 的「探测顺序」节都不含工作区概念。
- **R2 工作区上下文只在 execute 期可用**：`apply` 装配期没有会话上下文；工作区根（`workspaceRoot` / `session.header.cwd`）只有在 `execute` 时经 `ctx.sandboxPolicy.resolve()` 才拿得到。⇒ `.venv` / `uv` 探测必须放在 **execute 期、按已解析 workdir** 重探测 python 后端，apply 期的探测结果作为「回落」。
- **R3 实测（2026-10-19）**：`python3 -m venv` 可用，`.venv/bin/python -` 从 stdin 执行正常，`sys.prefix` 指向 venv；`uv` 0.13.3 已装，工作区有 `pyproject.toml` 时 `uv run -- python -u -` 从 stdin 执行正常，`uv run -- python -c "print(sys.executable)"` 输出项目 `.venv` 下的真实 python 路径。**副作用**：`uv run` 首次会自动创建 `.venv` 并解析解释器（uv 自身行为），本插件自身不改 `sys.path`、不建虚拟环境。
- **R4 回执口径**：`ScriptRunResult.interpreter` 结构化字段已带实际解释器路径（`src/tools.ts` 结果装配），但 `render.ts` 文本回执**不渲染**它（决策 6 口径只列四种标记 + 围栏拒绝提示）。⇒「解释器路径写进回执」的验收要落到哪个面，见决策 3。
- **R5 测试面**：`probe.test.ts` 全假解释器（不依赖机器）；`tool.test.ts` 的 `pyTest` 走真实 Python + `workdir` 用例；验收「有 / 无 `.venv` 两态 + 解释器路径进回执」适合落在 probe 假环境 + tool 真实执行两层。

## 决策

（拟定于 2026-10-19，提交询问点 1 等用户确认；改选时在原处划掉并注明取代者。）

1. 探测时机与插入位置
   a. execute 期重探测 python：顺序「显式配置 → 环境变量 → 工作区 `.venv` → uv（可选）→ PATH → 常见绝对路径」，apply 期结果作为回落
   b. 只在 apply 期探测（但装配期没有工作区上下文，做不到按工作区探测）
   **选定 a**。理由：工作区根只在 execute 期可得（R2）；把 `.venv` 插在环境变量之后、PATH 之前，保证「用户显式给出的覆盖优先」，缺省环境自动进项目 venv；探测不到时沿用 apply 期结果（即「回落当前解释器」）。execute 重探测时跳过版本读取（避免每次调用多 spawn 一个 `--version`）。

2. uv 前缀支持范围
   a. 支持：无 `.venv` 且工作区有 `pyproject.toml` / `uv.lock`、PATH 有 `uv` 时，用 `uv run -- python -c "print(sys.executable)"` **解析真实解释器路径**后直接执行（回执与启动都用真实路径）；解析失败回落。首次调用 uv 可能自动建 `.venv` / 拉解释器（uv 自身行为，本插件不建 venv、不改 sys.path）
   b. 本期不做 uv，只实现 `.venv` 探测（验收只要求两态）；uv 记入 README 与 BACKLOG 备查
   **选定 a**。理由：条目「或支持 uv 前缀」且实测可行（R3）；解析出真实路径后执行面零改动（仍 `python -u -`），回执路径真实可审计。代价是收到 `uv` 首次解析耗时的下限（上限钳 20s，超时就回落）。

3. 解释器路径进回执的口径
   a. 只落在结构化结果值 `interpreter` 字段（现状已满足；文本回执不加行）
   b. 文本回执恒加一行 `[interpreter: <path>]`
   c. 仅当解释器被 `.venv` / `uv` / 覆盖键改变（即不同于 apply 期默认）时，文本回执加一行 `[interpreter: <path>]`
   **选定 c**。理由：验收要求「写进回执」需要在模型可见的文本里体现环境切换；恒加一行会稀释决策 6 的标记口径，只在实际用了项目环境时提示，模型能立刻知道「这轮跑在哪个解释器上」。结构化 `interpreter` 字段始终保留（b 的代价是噪声，a 不达标）。

4. 新来源类型与文件清单
   a. `InterpreterSource` 扩 `"venv"` / `"uv"`，探测痕迹与新源都进 trail；改动文件扩到 `types.ts` / `index.ts`（把 `pythonPath` 传进工具面）/ `tools.ts`（execute 重探测）/ `render.ts`（决策 3 的行）/ `probe.ts` / 两个测试文件 / README
   b. 不扩类型（用 existing 的 `"path"`），减少改动面
   **选定 a**。理由：来源可审计（回执 / 日志能区分「系统 python」与「项目 venv」），成本只是联合类型加两个成员。影响：计划清单从原 4 项扩到 9 项（见规划），需用户批准。

## 规划

任务拆分（2026-10-19 决策后细化）：

1. 探测层：`src/probe.ts` 给 `probeInterpreter` 加可选 `workspace`（目录）与 `version: false` 选项；python 后端在 env 之后插入 `.venv/bin/python` 探测，`uv` 分支经 `uv run` 解析真实路径；trail 记 `venv:…（命中）` / `uv:…（命中）`。
2. 类型：`src/types.ts` 的 `InterpreterSource` 扩 `"venv"` / `"uv"`。
3. 装配面：`src/index.ts` 把 `pythonPath` 配置透传给工具面（`ToolSettings.pythonPath`）。
4. 执行面：`src/tools.ts` 在选中 python 后端后按已解析 workdir 重探测（跳过版本、探测不到回落 apply 期解释器），`ScriptRunResult.interpreter` 用最终生效路径；`src/render.ts` 按决策 3.c 在解释器被切换时加 `[interpreter: <path>]` 行。
5. 测试：`probe.test.ts` 补 venv / uv 假环境探测（有 / 无 `.venv`、config / env 优先、uv 假脚本 + pyproject 标记）；`tool.test.ts` 补真实执行两态（有 `.venv` → 用 `.venv/bin/python` 且回执带该路径；无 `.venv` → 回落系统 python、回执无切换行）。
6. 文档：`README.md` 探测表与「执行与围栏」口径同步；`docs/` 本追踪文档。

计划改动文件清单（决策后更新；原预估 4 项，按决策 4 扩到 9 项）：

- `script-interpreter/src/probe.ts`（workspace 探测：venv / uv / version 跳过）
- `script-interpreter/src/types.ts`（`InterpreterSource` 扩 `venv` / `uv`）
- `script-interpreter/src/index.ts`（`pythonPath` 透传工具面）
- `script-interpreter/src/tools.ts`（execute 期按工作区重探测 python）
- `script-interpreter/src/render.ts`（解释器切换标记行）
- `script-interpreter/tests/probe.test.ts`（venv / uv 探测）
- `script-interpreter/tests/tool.test.ts`（有 / 无 `.venv` 两态真实执行）
- `script-interpreter/README.md`（探测表 / 回执口径）
- 本追踪文档

明确不做：不改 `sys.path`；本插件不创建虚拟环境（`uv run` 自动建 `.venv` 属 uv 自身行为，会在 README 注明）；不做语言层面的其它探测（仅 python 后端）；`uv` 解析单个调用上限 20s，超时回落。

## 实现记录

（2026-10-19 按用户确认的推荐组合 D1a / D2a / D3c / D4a 实现。）

1. **探测层**（`src/probe.ts`）：`probeInterpreter` 增加可选 `workspace: { dir }` 与 `version: false`；python 后端在「环境变量」与「PATH」之间插入工作区探测 —— `.venv/bin/python` / `.venv/bin/python3`（来源 `venv`）→ uv 分支（工作区有 `pyproject.toml` / `uv.lock` 且 PATH 有 `uv` 时，调新导出 `resolveUvPython(uvPath, cwd)`：`uv run -- python -c "import sys; print(sys.executable)"`，上限 `UV_DISCOVERY_TIMEOUT_MS = 20_000` 解析出真实解释器路径，来源 `uv`）。trail 逐级记录；`version: false` 时跳过版本读取。
2. **类型**（`src/types.ts`）：`InterpreterSource` 扩 `"venv"` / `"uv"`；`ScriptRunResult` 增加可选 `interpreterChanged`（本次实际解释器与装配期默认不同时置 `true`）。
3. **装配面**（`src/index.ts`）：`ToolSettings` 增加 `pythonPath?: string`，`apply` 把 `resolveSettings` 的结果透传进去（execute 重探测的第一顺位仍是显式覆盖）。
4. **执行面**（`src/tools.ts`）：`executeScript` 在 workdir 解析之后（④.5）对 python 后端按 `workdir.dir` 重探测（跳过版本、传 `runtime.settings.pythonPath`）；命中且路径不同于装配期默认（或装配期为 null 而 venv / uv 命中）→ 切换并置 `interpreterChanged`；未命中 → 回落装配期解释器；`ScriptRunResult.interpreter` 恒为最终生效路径。解释器缺失判定（⑤）改在重探测之后。
5. **回执**（`src/render.ts`）：`interpreterChanged` 为真时在标记区（沙箱之后、超时之前）加一行 `[interpreter: <path>]`；未切换不加行（决策 6 口径不变）。
6. **测试**：`tests/probe.test.ts` 加 5 条（venv 命中且优先于 PATH、config / env 优先于 venv、无 .venv 回落 PATH、uv 假脚本命中、uv 无标记或无 uv 时跳过）；`tests/tool.test.ts` 加 2 条真实执行（有 `.venv` → 用 `.venv/bin/python` 且回执带切换行；无 `.venv` → 回落系统 python、无切换行）。
7. **文档**：README 探测节补 python 工作区探测与 uv 副作用、回执节补 `[interpreter: ...]` 标记、落点与测试表同步。

## 偏差

- **现状里 python 已缺解释器时的「venv 救场」是超出原口径的加分项**：原计划按「回落装配期解释器」，实现时允许「装配期为 `null` 但工作区 `.venv` / `uv` 命中」也切换（`tools.ts` ④.5 的 `before === null` 分支），即项目有 venv 时哪怕系统没装 python 也能跑。README 已在探测节写明（装配期结果作为回落），无单独条目。
- 其余按计划落地，无未做项。

## 测试与证据

均在本 worktree 的 `script-interpreter/` 包内执行（2026-10-19）：

```sh
npm run check   # tsc --noEmit → 通过
npm run build   # tsc → 通过（dist 生成）
npm test        # 86 例全过：tests 86 / pass 86 / fail 0 / skipped 0
```

真机烟测（真实 `apply`/`makeRuntime` + 真实解释器，不重启 dsh）：

- **有 `.venv`**：workdir 为含 `.venv/bin/python`（软链到系统 python）的目录 → `interpreterChanged: true`、`interpreter` 为 `.venv/bin/python`、回执含 `[interpreter: <venv 路径>]`，输出正常（`in-venv`）。
- **无 `.venv`**：同 workdir 删掉 `.venv` 后 → `interpreter` 回落 `/usr/bin/python3`、无 `[interpreter:` 行。
- **真 uv**：为无 `.venv` 的 uv 项目（`pyproject.toml`）目录，`UV_CACHE_DIR` 指到 /tmp → `interpreterChanged: true`，`interpreter` = `uv run` 解析出的项目 `.venv/bin/python`（uv 自动建 venv），回执带切换行；脚本自身报错属烟测脚本写法问题（`list.at`），不影响机制的判定。
- 验收断言「有 / 无 `.venv` 两态各一例，解释器路径写进回执」→ `tests/tool.test.ts` 两条真实执行用例 + 上述烟测均满足；「解释器路径」有结构化 `interpreter` 字段与文本 `[interpreter: ...]` 行两个落点。

**真实 profile 真机验证（2026-10-19，重启加载新代码后，经 `script_run` 工具真实调用）**：

- **有 `.venv`**：`workdir` 指向含 `.venv` 的目录，python 脚本打印 `sys.executable` / `sys.prefix` → 实际执行 `.venv/bin/python`，`sys.prefix` 为 venv 目录，回执含 `[interpreter: …/.venv/bin/python]` 切换行。
- **无 `.venv`**：`workdir` 指向空目录 → 实际执行 `/usr/bin/python3`（回落系统解释器），回执无 `[interpreter:` 行。
- 验收口径「有 / 无 `.venv` 两态各一例，且解释器路径写进回执」在真实 profile 下逐字满足（切换行即有 / 无两态各自出现与不出现，结构化 `interpreter` 字段恒在）。验证用临时工作区已清理（`tmp/` 删除后工作树干净）。
- 复核：/restart 后（主分支确认 pid 2447319、fff profile）两态结果一致（venv → `.venv/bin/python` + 切换行；plain → `/usr/bin/python3` 无切换行）。

未覆盖：仓库根整仓 check / test（其余包本轮未改，包内三件已绿；上一任务已整仓验证过基线）。残留：`node_modules` 为软链（gitignore 覆盖）。

## 收尾

（2026-10-19 关闭；用户经主分支会话放行关闭。）

- **人工确认真机**：/restart（pid 2447319）后在真实 fff profile 下经 `script_run` 完成有 / 无 `.venv` 两态验证，验收断言逐字满足（证据见「测试与证据」）；用户在关闭裁定中放行，视为人工确认通过。
- **BACKLOG 清理**：`script-interpreter/docs/BACKLOG.md` 的「Python venv / uv 自动探测」条目标记完成并移除，模块待办清单已空（未完成项无，仅留「已裁定不做」备查）。
- **归档**：本追踪文档移入 `script-interpreter/docs/archived/`。
- **回写**：`README.md` 已随实现同步（python 工作区 `.venv` / `uv` 探测口径、uv 副作用、回执 `[interpreter: ...]` 标记）；`STATUS.md` 由用户择时更新，本流程不改。
- **遗留**：node 项目级环境探测（`.nvmrc` / `fnm` / `nvm` 等）未立项，如需要另立条目；REPL / 状态保持等既有「不做」口径不变。
- **收尾提交**：提交点 4 完成本次变更的最后一次提交（记录见 git 历史）。
