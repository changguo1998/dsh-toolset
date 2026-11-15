# plan 模式：非流程控制部分（原「自研 plan 模式（替代官方 plan-mode）」条目）

状态：关闭，已归档（2026-11-15 开启并关闭）。
本文件是后续实施的基线：状态更正的结论（§1、§2）、10 项决策（§3）、可机械审计的任务清单（§4）。接取时另建追踪文档，引用这里的 §3 与 §4。

## 1. 背景与目标

1. **状态更正**：plan 模式的流程控制部分已于 2026-11-15 随「泛化 task-engine」任务交付，但条目仍写「未接取」。已完成部分记进 `docs/BACKLOG.md` §1，剩余部分另立条目。
2. **补齐决策**：把剩余部分的 10 项决策补齐并裁定（§3），作为后续接取的依据。
3. **给出任务清单**：T0 至 T16 逐条带审计命令（§4.3），接取者不必再解释「做到什么算完」。

拆分结果（`docs/BACKLOG.md` §2 的 plan 模式相关条目，共三条）：

- 自研 plan 模式：非流程控制部分（主条目，含写面拦截与阶段注入）；
- plan 模式段位展示（TUI 状态行）；
- 子代理写调用继承父会话阶段。

「阶段结构校验」（探索结论齐备、计划清单完整一类）不在本次范围，见 §4.4。

## 2. 现状调研

### 2.1 已交付的流程控制部分

- 三段定义：探索 / 计划 / 实施，各带 `needDecompose` 与 `enforceOrder`（`plan-mode/src/stages.ts:44-84`）；计划段验收为 human（`:62-66`），即人工确认后才进实施。
- 入口：`plan_start` 建树，内部调 `taskEngine.composeFromNodes`（`plan-mode/src/index.ts:104-108`、`plan-mode/src/plan-start.ts`）；同时向 `flowArbiter.register` 登记（`index.ts:92-101`）。
- 越序拦截在任务层：`task_implement` / `task_execute` / `task_stop` 撞前序未完成即被拒（`task-engine/src/order.ts:26-63`）。
- 验证：单测 11 例（2026-11-15 实测 11/11 通过）；e2e 1 例通过（依据 `docs/archived/2026-11-15-task-engine-template-framework.md` 的 T9 记录，写作时未重跑）。`STATUS.md:60` 记完成，`docs/PACKAGES.md:55` 已登记。

### 2.2 还缺什么

- **不拦写面**：`plan-mode/src` 没有任何 `ctx.on` 或 `tools/pre-execute` 监听，注入面只有 `["tools"]`（`plan-mode/src/index.ts:23`），探索与计划阶段可以随意改文件。
- **不注入阶段约束**：本仓 plan-mode 不注入上下文（`plan-mode/src/index.ts:8-9`）；官方 `plan:policy` 已随官方 plan-mode 停挂（`profiles/example/cordis.patch.yml:274-279`）。
- **没有状态位**：入口已由 `flow-arbiter` 的 `flow_select` 提供（选中 `plan` 即模式生效，`flow-arbiter/src/state.ts:137-166`），缺的是「当前在哪一段、是否只读」的查询与展示。本条目补查询面（§4.1 阶段 3 的 `planStage`），展示归段位条目。

### 2.3 关键约束

1. **任务树不按会话隔离**：每个进程只有一个 `engine` 实例（`task-engine/src/plugin.ts:358-372`），当前节点推送 `pinNotes.hold("task", ...)` 也不带会话参数（`:406`）。按会话判定只能自持「会话 id → 帧 id」映射。
2. **服务面没有「当前帧」**：`taskEngine` 只暴露 `query` / `frameStack` / `composeFromNodes`（`task-engine/src/plugin.ts:437-446`）；快照只有 `tasks` / `frameStack` / `activeCount` / `isComplete`（`task-engine/src/engine-types.ts:175-184`），任务项含 `id` / `parentId` / `order` / `title` / `status` / `children`（`task-engine/src/types.ts:233-245`）。阶段只能按帧 id + 标题 + 状态自行推。
3. **会话 id 在 pre-execute 可取**：`exec.agent.session.id`，缺省退 `exec.session.id`（`flow-arbiter/src/tool.ts:32-39`）。
4. **权限预设是会话级**：`set(session, name)` / `current(session)` 都按 Session 读写（宿主 `packages/interaction/permission-presets/src/index.ts:343`、`:398`），多会话各切各的，互不覆盖。

### 2.4 写面清单（可直接复用既有登记表）

- 官方文件工具：`write` / `edit` / `apply_patch` / `patch`（`security-guard/src/tool-registry.ts:14-25`）；`apply_patch` 出厂关闭（`docs/host/HOST-UPGRADE-0.2.2-rc.1.md:71-75`），今天不注册。
- 本仓插件文件工具：`hash_edit`、`ast_replace`、`md_logic`（仅 `action === "replace"` 写）（`security-guard/src/tool-registry.ts:47-54`）。
- 间接写面：`bash` / `shell` / `pwsh` / `run_code`（`:9-10`）、`script_run`、`herdr_run` / `herdr_text`（终端命令面，`:124-129`）；`workflow` / `task_execute` 另开会话，边界见下条。
- 边界：子代理的写调用带子会话 id，父会话的拦截按会话匹配不会命中，需另行设计（已另立条目）。

### 2.5 可复用面

- 拦截骨架：`flow-arbiter/src/index.ts:148-167`（`tools/pre-execute` + `deny { reason, info }`，工具恒注册、只在执行前判）。
- 逐项判定范本：`security-guard/src/index.ts:146-153`、`behavior-correction/src/index.ts`（`rule-engine` 的 guard 消费者）。
- 注入范本：`ponytail/src/index.ts:73-79`（`systemPrompt.section`，全进程一段）；动态保持用 `pinNotes.hold`，其 provider 每步带 `{ sessionId }`（`pin-note/src/index.ts:47-49`、`:378`）。
- 命令判定：`shell-parse/src/command-position.ts`（`security-guard` 与 `behavior-correction` 已在用）。

### 2.6 两条防线与判定顺序

1. 宿主沙箱：预设 `read-only` 时 `fs-sandbox` 直接拒 `write` / `edit`（`docs/host/HOST-PACKAGES.md:270`），`bash-sandbox` 每条命令过 `ctx.sandbox`（`:262`），策略所有者 `ctx.sandboxPolicy`（`:284`）。本仓的 `hash_edit` / `ast_replace` / `md_logic` 也已改走 `ctx.fs`（2026-11-08 改造），同样受这道约束。
2. 本仓插件：`plan-mode` 自己的 `tools/pre-execute`，按阶段与工具名判定。

两者互不替代：`pre-execute` 在工具执行前跑，本仓回执先出现；用户手动把预设改回 `workspace-write` 不能绕过本仓拦截，本仓放行也不解除宿主沙箱。任一环节缺席，另一道仍在。

### 2.7 三个前提

1. **`plan_start` 拿不到会话**：`execute(args, exec?)` 声明了第二参，实现却只写 `execute(args)`（`plan-mode/src/plan-start.ts:121`），`exec` 被丢掉；而记会话映射与切预设都要 `exec.agent.session`。
2. **「计划段完成」没有宿主事件可听**：`plan/frame-completed` 等只是引擎内部事件流（`task-engine/src/events.ts:20-125`），包内没有 `ctx.emit`。只能轮询 `taskEngine.query()`——现成钩子是 `pinNotes.hold` 的 provider（每步一次、带 `sessionId`）。
3. **`current` 的入参是 Session，不是 events**：TUI 侧传的是 `session.events` 数组（`TUI/src/app/adapter/dsh-panels.ts:56-62`），与宿主签名不一致，不能照抄。

另两点：`permissionPresets.set` 只改预设与沙箱 / 审批旋钮，不动工具面；会话结束有 `ctx.on("session/disposed", ...)` 可用（`docs/host/DSH-CTX-API.md:36`，`cache-hit-monitor/src/index.ts:232` 已在用），清理与恢复有正规入口。

### 2.8 部署现状

- 主 profile 快照停在 2026-11-07，挂载 38 个本仓包，尚未同步 `plan-mode` / `flow-arbiter`（`STATUS.md:16`），所以现有证据只有单测与 e2e，没在真机跑过。
- `pin-note` 与 `plan-mode` 都在 `scripts/install.sh:44` 的 `canonical_pkgs` 里、以 bundle 挂载；`profiles/example/cordis.patch.yml` 不列它们属正常（该文件只写官方行与配置）。

## 3. 决策

10 项均由用户 2026-11-15 裁定，下面记选项与理由；契约、恢复规则、降级等实施细节见 §4。

### 决策项 1：拦截器放在哪

- a. 扩展 `plan-mode` 包
- b. 新建 `plan-guard` 包
- c. 走 `rule-engine` 的 guard 消费者

**选定 a**。阶段与写权限是同一件事的两面，同包可直接复用 `PLAN_NODES` 与会话映射；c 是全局规则、不按会话，且每个工具都要单写一条。

### 决策项 2：会话与阶段归属怎么定

- a. 只读仲裁选中状态 + 全局树状态
- b. `plan_start` 时记「会话 id → 三段帧 id」，拦截时取自己那棵树
- c. 不做会话判定，进程里有未完成的 plan 树就全线禁写

**选定 b**。树不隔离（§2.3 第 1 条），a 在多会话下会串；b 只需建树写一条、树完成删一条，与 `flow-arbiter` 的会话级选择同构。

### 决策项 3：拦哪些工具

- a. 只拦直接文件写面
- b. a 再加间接写面（`bash` / `run_code` / `script_run` / `herdr_run` / `workflow` / `task_execute`）
- c. a 再加子代理继承

**选定 b**（推荐原为 a，用户改选）。只拦 a 会留 `bash -c 'echo > f'` 这类绕行；c 需宿主暴露父会话身份，目前没有，已另立条目。`workflow` / `task_execute` 只能拦发起，拦不住子代理内部的写，这条缺口随 c 的条目一起留着。

### 决策项 4：哪一段允许写

- a. 探索与计划段拒写，计划段完成（人工确认）后放行，实施段全程放行
- b. 树完成前一律拒写
- c. 节点自带 `allowWrite`，逐节点给权限

**选定 a**。与三段语义一致，人工闸门正好是放行开关；b 会挡住探索期的只读排查，c 与 `enforceOrder` 语义重复。

### 决策项 5：拒绝时回执怎么写

- a. `deny` + `reason`（说明当前段与下一步）+ `info.code`
- b. `deny` 但可跳审批
- c. 只注入提示、不拦

**选定 a**。与 `flow-arbiter` 的 `info.code` 口径一致（`flow-arbiter/src/index.ts:160-164`），模型能据此改道；b 需接 `auto-approve` 且削弱闸门（未立条目）；c 已证明不可靠——官方 policy 就不保证模型遵守。

### 决策项 6：阶段约束怎么进上下文

- a. `systemPrompt.section` 静态段
- b. `pinNotes.hold` 动态保持
- c. 不注入

**选定 b**。段会变，静态段写不清「现在在哪一段」，且 `systemPrompt.section` 全进程一份；hold 的 provider 每步带 `sessionId`，可按会话给段位。

### 决策项 7：模式入口与状态展示

- a. 复用 `flow_select` 选中 `plan` 即视为进入，不新增工具
- b. 新增 `plan_enter` / `plan_exit`
- c. a 之外再加 TUI 状态行段位

**选定 a**，展示面 c 另立条目。未选中流程时 `plan_start` 本就被拒，a 与仲裁语义一致；b 与「选中即模式」重叠；c 不阻塞写权限落地。

### 决策项 8：进入 plan 模式时改权限预设

- a. 进入时切 `read-only`，计划段结束（完成或失败）时恢复进入前的预设
- b. 进入时切 `read-only`，只在树完成 / 切走 / 会话结束时恢复
- c. 不切预设，只靠本仓拦截

**选定 a**（用户确认「计划完成后可以切回原来的权限」）。宿主沙箱是独立兜底；实施段必须可写，故恢复点是计划段的终态（完成，失败也恢复）。b 会让实施段写不进去，c 缺宿主兜底。

### 决策项 9：命令「是否写」怎么判

- a. 白名单式保守判定，认不出的命令放行。名单初版：重定向 `>` / `>>` / `&>`、`tee`、`sed -i`、`mv` / `cp` / `rm` / `mkdir` / `touch` / `truncate` / `dd`、`perl -i`、`python -c` 写文件等
- b. 黑名单式，列出禁止的命令
- c. plan 阶段任何 shell 类工具都拒

**选定 a**。与「宁可漏拦，也不错拦只读排查」一致；b 盖不住 `echo x > f` 这类没有写命令名的形态；c 会把 `git status` 这样的排查也挡死。

### 决策项 10：同一会话再次 `plan_start` 时，原预设怎么记

- a. 会话已有映射 → 沿用首次记录的原预设，只更新帧 id
- b. 每次建树都重记重切
- c. 已有未完成的 plan 树就拒绝 `plan_start`

**选定 a**。否则第二次建树会把上一次设的 `read-only` 记成「原值」，恢复后会话被永久钉在只读；b 需要额外的「谁设的」标记才安全；c 会挡住「上一棵树放弃后重开」。

## 4. 实施规划

六段串行推进，每段收尾都跑 `pnpm -C plan-mode run check` 与 `run test`。决策项与落地位置的对应：

| 决策项 | 落地位置 |
| --- | --- |
| 1 拦截载体 | 全部改动在 `plan-mode/`，不新建包 |
| 2 会话与阶段归属 | 阶段 2 `session-map.ts` / `stage.ts`，阶段 3 取用 |
| 3 拦哪些工具 | 阶段 2 `guard.ts` 工具分类 |
| 4 哪段允许写 | 阶段 2 `guard.ts` 段规则，阶段 3 装配 |
| 5 回执形态 | 阶段 2 `guard.ts` 文案，阶段 3 `info.code` |
| 6 阶段注入 | 阶段 5 `push.ts` 与 `pinNotes.hold` |
| 7 入口与展示 | 阶段 3 只读服务面（不加工具），展示另立条目 |
| 8 权限预设 | 阶段 4 `preset.ts` |
| 9 命令判定 | 阶段 2 `guard.ts` 命令白名单 |
| 10 二次进入 | 阶段 4 沿用首次记录的原预设 |

### 4.1 六个阶段

**阶段 1：补会话通路**

决策项 2 的映射与决策项 8 的预设切换都要 Session，而当前两样都拿不到（§2.7 前提 1），故先补这条通路。

- `plan-mode/src/plan-start.ts:121` 现为 `execute(args)`，声明了的第二参被丢掉；改成真收 `execute(args, exec)`，从 `exec.agent.session` 取会话 id 与 Session。
- 建树成功后调注入的 `onStarted({ sessionId, frames })`，把返回的 `{ presetSwitched, presetNote? }` 并进工具回执。
- 契约：`PlanStartDeps.onStarted?(input: { sessionId: string; frames: readonly string[] }) => Promise<{ presetSwitched: boolean; presetNote?: string }>`。`frames` 就是建树产出的三个节点 id（`plan-start.ts:136`、`:163`），顺序同 `PLAN_NODES`；`index.ts` 注册时透传第二参，在 `onStarted` 里串起会话映射与预设切换。
- 降级：`exec` 缺失或没注入 `onStarted` 时回执为 `{ sessionId: null, presetSwitched: false, presetNote: "拿不到会话，权限面未切换" }`，建树不受影响。

**阶段 2：判定核与会话映射**

- 新增 `guard.ts`（段规则、工具分类、命令白名单、判定顺序、回执文案，全是纯函数）、`stage.ts`（按帧 id 从 `query().tasks` 推段：探索 / 计划 / 实施 / 未知，并判计划段是否已到终态）、`session-map.ts`（会话 id → plan 记录：三段帧 id + 原预设 + `restored` 标记，进程内内存，提供 `set` / `get` / `drop`）。
- `package.json` 加 `@dsh-toolset/shell-parse`，加完在仓库根跑 `pnpm install` 让链接生效。
- 判定顺序，短路，先命中先返回：
  1. 会话没有映射 → 放行（决策项 2b，非 plan 会话零动作）。
  2. 推不出段（树缺失、帧对不上）→ 放行，按未知段处理，不把人锁死。
  3. 计划段已 done，或段是实施 → 放行（决策项 4a 的放行点）。
  4. 工具不在写面 → 放行。`flow_select` / `plan_start` / `task_decompose` / `task_implement` / `task_stop` 都在此类，只读期间照常可用，否则流程推不动。`task_implement` 是 model 后端、在当前会话执行，内部调用的写工具仍会命中本拦截，不算绕行口；会另开执行面、拦不住内部写的是 `workflow` / `task_execute`，已单独拒。
  5. 在写面 → 按下面的分类判，命中即拒。
- 工具分类，决策项 3b 的清单逐项归位：

| 类别 | 工具 | 只读段处置 |
| --- | --- | --- |
| 直接写面 | `write` / `edit` / `apply_patch` / `patch` / `hash_edit` / `ast_replace`（`write: true`）/ `md_logic`（`action: "replace"`） | 拒 |
| 终端命令面 | `bash` / `shell` / `pwsh` / `herdr_run` / `herdr_text` | 按命令白名单判，认不出放行 |
| 代码执行类 | `run_code` / `script_run` | 拒，代码体里判不出写不写 |
| 派生会话类 | `workflow` / `task_execute` | 拒，只能拦发起 |

- 带写开关的工具按开关判：`ast_replace` 不带 `write: true` 是 dry-run（`ast-tools/src/tools.ts:378-384`），`md_logic` 非 `replace` 只读，两者都不拦。
- `herdr_text` 归入终端命令面的理由：它只比 `herdr_run` 少一个回车（`security-guard/src/tool-registry.ts:124-129` 已按终端命令面登记），不判等于留一个「打字 + 回车」的绕行；决策项 3b 的清单只写到 `herdr_run`，这里按同一口径补齐。
- 命令白名单初版（决策项 9a）：重定向 `>` / `>>` / `&>`、`tee`、`sed -i`、`perl -i`、`mv` / `cp` / `rm` / `mkdir` / `touch` / `truncate` / `dd`、`python -c` 写文件；其余命令（含 `git status` 这类排查）放行。
- 回执文案写清三件事：当前段、为什么不能写、下一步做什么（探索段指向「先交探索结论」，计划段指向「计划段确认后再写」）。

**阶段 3：拦截器装配**

- 挂 `ctx.on("tools/pre-execute")`，取会话 id（`exec.agent.session.id`，缺省退 `exec.session.id`，`flow-arbiter/src/tool.ts:32-39`），按阶段 2 的判定核给结论；命中返回 `{ kind: "deny", reason, info: { name: "plan_stage_readonly", code: "plan_stage_readonly" } }`，否则 `next()`（决策项 5a）。骨架照 `flow-arbiter/src/index.ts:148-167`。
- 工具面不增删：不注册新工具、不改既有工具定义，只把 `plan_start` 的说明改成「进入后探索与计划段只读，计划确认后自动恢复」，缓存不受影响（决策项 7a）。
- 只读服务面 `planStage.current(sessionId)` 返回 `{ stage, readonly }` 或 `null`（无映射、无任务引擎时），供 TUI 段位条目消费（决策项 7c 的落地前提）；不新增工具，不写状态。

**阶段 4：权限预设切换与恢复**

- 新增 `preset.ts`：预设读写、恢复、降级。
- 进入：`names` 里有 `read-only` → `current(session)` 存原值，再 `set(session, "read-only")`。三种情况不动预设、只告警，靠阶段 3 的拦截兜底：`names` 里没有 `read-only`；原值是 `custom`（旋钮不匹配任何预设，`set(session, "custom")` 会抛错，记下来也恢复不回去）；`set` 抛错。映射记录里同时记原预设（切成功才记值，降级记缺失）与 `restored: false`。
- 二次进入：会话已有映射就沿用首次记录的原预设，只更新帧 id（决策项 10a）；上一棵树已恢复过（记录里 `restored` 为真）时，用同一份原预设再切一次 `read-only` 并把标记复位，不重记原值。否则第二次建树会把上一次设的 `read-only` 记成原值，恢复后会话被永久钉在只读。
- 恢复入口，同一棵树的每个入口只走一次（`restored` 标记挡重复触发）：

| 触发 | 依据 |
| --- | --- |
| 计划段到终态，完成或失败 | 决策项 8a |
| `flow_select` 切走，不再选中 plan | 8a 补充：树已废弃，留着只读只会卡人 |
| 会话结束 `session/disposed` | 兜底 |
| 树完成，快照 `isComplete` | 兜底，与决策项 2 的「树完成删一条」对齐 |
| 插件卸载，`ctx.on("dispose")` | 兜底 |

- 轮询来源：「计划段到终态」与「切走」都没有事件可听——前者没有宿主事件（§2.7 前提 2），后者是因为 `flow-arbiter` 的服务面只有 `register` / `select` / `clear` / `current` / `flows`，不派发事件（`flow-arbiter/src/index.ts:178-185`）。本段先挂一个 `pinNotes.hold("plan-mode", ...)` 的空壳 provider，每步查一次快照与 `flowArbiter.current(sessionId)`：计划段到终态就恢复预设，不再选中 `plan` 就恢复并 `drop`，树完成就恢复并清映射；文案留到阶段 5 补进同一个 provider，避免每步遍历两次。
- 映射留存：计划段终态那条只恢复预设、不动映射，实施段的注入与 `planStage` 还要用；切走、树完成、会话结束、卸载四条把映射一并 `drop`。
- 覆盖保护：映射记录里没原预设（进入时已降级）的，恢复时不碰预设、不重复告警，只清理；有原预设而 `restored` 为假且当前预设已不是 `read-only` 时，视为用户手动改过，跳过 `set`、只清记录并告警一次，不拿旧值覆盖用户的选择。
- 降级口径：以上任一情况都只告警、不阻断建树、映射照记（否则本仓拦截也不生效），回执与告警里注明「权限面未切换」；预设服务整个缺席时同此。`flowArbiter` 缺席时「切走」这条不生效，其余入口不变。

**阶段 5：阶段注入**

- 新增 `push.ts` 出文案，补进阶段 4 已挂的 `pinNotes.hold("plan-mode", ...)`（决策项 6b）。
- 文案：探索段与计划段说明只读原因与下一步；实施段说明已放行；未知段不输出。
- 不选静态段的原因：`systemPrompt.section` 全进程一份，写不清「这个会话现在在哪一段」。
- 降级：`pinNotes` 缺席时既不注入也不轮询恢复，只剩会话结束与插件卸载两条兜底，实施段会一直停在只读；告警一次并写进包 README。

**阶段 6：收尾**

- 包 README 写清拦截、权限切换与恢复、降级与边界；`docs/PACKAGES.md` 补 plan-mode 职责；BACKLOG 条目改「进行中」，完成后清理；e2e 扩断言；按 §4.3 的 T9 至 T16 收尾验证。

### 4.2 改动文件清单（13 条 / 17 个文件）

- `plan-mode/src/plan-start.ts`（`exec` 透传、`onStarted`、返回值契约）
- `plan-mode/src/index.ts`（装配 pre-execute / hold / 预设切换 / `planStage` 只读服务面，降级告警）
- `plan-mode/src/guard.ts`（新增：写面名单与工具分类、命令白名单、判定顺序、回执文案）
- `plan-mode/src/stage.ts`（新增：按快照推段，并判计划段是否已到终态）
- `plan-mode/src/session-map.ts`（新增：会话 id → plan 记录（帧 id + 原预设 + restored））
- `plan-mode/src/preset.ts`（新增：预设读写与恢复、降级）
- `plan-mode/src/push.ts`（新增：当前段注入文案）
- `plan-mode/tests/guard.test.ts` / `stage.test.ts` / `session-map.test.ts` / `preset.test.ts` / `index.test.ts`
- `plan-mode/package.json`（加 `shell-parse` 依赖）
- `plan-mode/README.md`
- `e2e/plan-mode.test.ts`
- `docs/PACKAGES.md`（plan-mode 一行）
- `docs/BACKLOG.md`（条目状态与清理）

### 4.3 机械审计（T0 至 T16，按序执行）

口径：命令都在仓库根跑，判据一律**退出码 0**。断言用 `test -f`、`awk`、`pnpm`、`dsh` 折成退出码——不用 `grep` / `sed`（本仓 agent 环境的 bash 策略禁止在 shell 里调它们；查文件用模型侧 grep 工具，审计用 `awk '/串/{f=1} END{exit !f}'`）。测试名当契约用，改名审计就失败；源码断言的串同样是契约，实现时照原样写，不要折行或改写。

**T0 基线确认**

- 改动：无
- 审计：`pnpm -C plan-mode run check`；`pnpm -C plan-mode run test 2>&1 | awk '/fail 0/{f=1} END{exit !f}'`

**T1 `exec` 透传与会话取用**

- 改动：`plan-mode/src/plan-start.ts`、`plan-mode/src/index.ts`
- 审计：`awk '/execute\(args, exec/{f=1} END{exit !f}' plan-mode/src/plan-start.ts`；`awk '/onStarted/{f=1} END{exit !f}' plan-mode/src/plan-start.ts`；`awk '/presetSwitched/{f=1} END{exit !f}' plan-mode/src/plan-start.ts`；`awk '/拿不到 exec 时降级/{f=1} END{exit !f}' plan-mode/tests/index.test.ts`

**T2 判定核 `guard.ts`**

- 改动：`plan-mode/src/guard.ts`（新增）、`plan-mode/package.json`
- 审计：`test -f plan-mode/src/guard.ts`；`awk '/@dsh-toolset\/shell-parse/{f=1} END{exit !f}' plan-mode/package.json`；`test -d plan-mode/node_modules/@dsh-toolset/shell-parse`；`awk '/探索段拒绝 write/{f=1} END{exit !f}' plan-mode/tests/guard.test.ts`；`awk '/重定向判为写/{f=1} END{exit !f}' plan-mode/tests/guard.test.ts`；`awk '/认不出的命令放行/{f=1} END{exit !f}' plan-mode/tests/guard.test.ts`；`awk '/回执写明当前段与下一步/{f=1} END{exit !f}' plan-mode/tests/guard.test.ts`；`awk '/只读段拒 workflow 与 task_execute/{f=1} END{exit !f}' plan-mode/tests/guard.test.ts`；`awk '/只读段拒 run_code 与 script_run/{f=1} END{exit !f}' plan-mode/tests/guard.test.ts`；`awk '/任务面工具不受影响/{f=1} END{exit !f}' plan-mode/tests/guard.test.ts`；`awk '/dry-run 的 ast_replace 放行/{f=1} END{exit !f}' plan-mode/tests/guard.test.ts`；`awk '/herdr_text 按命令白名单判/{f=1} END{exit !f}' plan-mode/tests/guard.test.ts`；`awk '/实施段放行/{f=1} END{exit !f}' plan-mode/tests/guard.test.ts`；`awk '/plan_stage_readonly/{f=1} END{exit !f}' plan-mode/src/guard.ts`；`awk '/只读段拒 hash_edit 与 md_logic 的 replace/{f=1} END{exit !f}' plan-mode/tests/guard.test.ts`

**T3 推段 `stage.ts`**

- 改动：`plan-mode/src/stage.ts`（新增）
- 审计：`test -f plan-mode/src/stage.ts`；`awk '/按帧 id 推出当前段/{f=1} END{exit !f}' plan-mode/tests/stage.test.ts`；`awk '/计划段完成后判为可写/{f=1} END{exit !f}' plan-mode/tests/stage.test.ts`；`awk '/树缺失时返回未知段/{f=1} END{exit !f}' plan-mode/tests/stage.test.ts`

**T4 会话映射 `session-map.ts`**

- 改动：`plan-mode/src/session-map.ts`（新增）
- 审计：`test -f plan-mode/src/session-map.ts`；`awk '/登记后按会话取回/{f=1} END{exit !f}' plan-mode/tests/session-map.test.ts`；`awk '/drop 之后不再命中/{f=1} END{exit !f}' plan-mode/tests/session-map.test.ts`

**T5 拦截器装配**

- 改动：`plan-mode/src/index.ts`、`plan-mode/src/plan-start.ts`、`plan-mode/tests/index.test.ts`
- 审计：`awk '/tools\/pre-execute/{f=1} END{exit !f}' plan-mode/src/index.ts`；`awk '/plan_stage_readonly/{f=1} END{exit !f}' plan-mode/src/index.ts`；`awk '/planStage/{f=1} END{exit !f}' plan-mode/src/index.ts`；`awk '/计划确认后自动恢复/{f=1} END{exit !f}' plan-mode/src/plan-start.ts`；`awk '/非 plan 会话零动作/{f=1} END{exit !f}' plan-mode/tests/index.test.ts`；`awk '/工具面注册不变/{f=1} END{exit !f}' plan-mode/tests/index.test.ts`；`awk '/服务面暴露当前段/{f=1} END{exit !f}' plan-mode/tests/index.test.ts`

**T6 权限预设切换**

- 改动：`plan-mode/src/preset.ts`（新增）、`plan-mode/src/index.ts`
- 审计：`test -f plan-mode/src/preset.ts`；`awk '/进入时切只读并记住原预设/{f=1} END{exit !f}' plan-mode/tests/preset.test.ts`；`awk '/二次进入沿用原预设并重新切只读/{f=1} END{exit !f}' plan-mode/tests/preset.test.ts`；`awk '/预设名不含 read-only 时降级/{f=1} END{exit !f}' plan-mode/tests/preset.test.ts`；`awk '/原预设为 custom 时降级/{f=1} END{exit !f}' plan-mode/tests/preset.test.ts`；`awk '/服务缺席时降级/{f=1} END{exit !f}' plan-mode/tests/preset.test.ts`；`awk '/"read-only"/{f=1} END{exit !f}' plan-mode/src/preset.ts`

**T7 恢复钩子**

- 改动：`plan-mode/src/index.ts`、`plan-mode/src/preset.ts`、`plan-mode/tests/preset.test.ts`、`plan-mode/tests/index.test.ts`
- 审计：`awk '/计划段完成时恢复原预设/{f=1} END{exit !f}' plan-mode/tests/preset.test.ts`；`awk '/计划段失败时也恢复/{f=1} END{exit !f}' plan-mode/tests/preset.test.ts`；`awk '/用户手改过则不覆盖/{f=1} END{exit !f}' plan-mode/tests/preset.test.ts`；`awk '/pinNotes 缺席时只剩两条恢复入口/{f=1} END{exit !f}' plan-mode/tests/index.test.ts`；`awk '/计划段恢复后仍报段位/{f=1} END{exit !f}' plan-mode/tests/index.test.ts`；`awk '/树完成时清映射/{f=1} END{exit !f}' plan-mode/tests/index.test.ts`；`awk '/切走时恢复并清映射/{f=1} END{exit !f}' plan-mode/tests/index.test.ts`；`awk '/卸载时恢复/{f=1} END{exit !f}' plan-mode/tests/index.test.ts`；`awk '/会话结束时恢复/{f=1} END{exit !f}' plan-mode/tests/index.test.ts`；`awk '/pinNotes/{f=1} END{exit !f}' plan-mode/src/index.ts`；`awk '/session\/disposed/{f=1} END{exit !f}' plan-mode/src/index.ts`

**T8 阶段注入 `push.ts`**

- 改动：`plan-mode/src/push.ts`（新增）、`plan-mode/src/index.ts`
- 审计：`test -f plan-mode/src/push.ts`；`awk '/当前段/{f=1} END{exit !f}' plan-mode/src/push.ts`；`awk '/只读/{f=1} END{exit !f}' plan-mode/src/push.ts`；`awk '/下一步/{f=1} END{exit !f}' plan-mode/src/push.ts`

**T9 单测全绿**

- 改动：`plan-mode/tests/*.test.ts`
- 审计：`pnpm -C plan-mode run check`；`pnpm -C plan-mode run test 2>&1 | awk '/fail 0/{f=1} END{exit !f}'`；`pnpm -C plan-mode run test 2>&1 | awk '/pass ([2-9][0-9]|[1-9][0-9][0-9])/{f=1} END{exit !f}'`（通过数不少于 20）

**T10 包 README**

- 改动：`plan-mode/README.md`
- 审计：`awk '/plan_stage_readonly/{f=1} END{exit !f}' plan-mode/README.md`；`awk '/read-only/{f=1} END{exit !f}' plan-mode/README.md`；`awk '/presetSwitched/{f=1} END{exit !f}' plan-mode/README.md`；`awk '/白名单/{f=1} END{exit !f}' plan-mode/README.md`；`awk '/降级/{f=1} END{exit !f}' plan-mode/README.md`；`awk '/shell-parse/{f=1} END{exit !f}' plan-mode/README.md`

**T11 包清单**

- 改动：`docs/PACKAGES.md`
- 审计：`awk '/写面拦截/{f=1} END{exit !f}' docs/PACKAGES.md`；`awk '/plan_stage_readonly/{f=1} END{exit !f}' docs/PACKAGES.md`

**T12 e2e 扩断言**

- 改动：`e2e/plan-mode.test.ts`
- 审计：`awk '/plan_stage_readonly/{f=1} END{exit !f}' e2e/plan-mode.test.ts`；`awk '/presetSwitched/{f=1} END{exit !f}' e2e/plan-mode.test.ts`；`node --experimental-transform-types --test --test-force-exit e2e/plan-mode.test.ts`（需已装 dsh 宿主；没有宿主时按「未验证」记进追踪文档，断言不能省）
- 挂载：现有 e2e 只挂 `dsh-base` + `task-engine` / `clock-base` / `tool-surface`（`e2e/plan-mode.test.ts:6-13`），要验阶段注入与轮询恢复得把 `pin-note` 加进 `extraPackages`，否则 hold 不在、恢复轮询与注入都不发生（`presetSwitched` 的取值另看 `permission-presets` 是否挂载）。若再挂 `flow-arbiter`，调 `plan_start` 前必须先 `flow_select` 选 `plan`。
- 边界：计划段是 human 验收，e2e 没有审批应答者，难以把计划段标成完成。故 e2e 只断言「探索段写被拒」与 `presetSwitched` 字段在场（宿主没装 `permission-presets` 时它只能是 false，不硬断言 true，真值留给 T16）；「计划段完成后放行 / 预设恢复」由单测（纯函数 + 合成快照）与真机确认覆盖，不伪造审批。

**T13 接线一致性**

- 改动：无（只读核对，缺枚举就补）
- 审计：`awk '/plan-mode/{f=1} END{exit !f}' scripts/test-parallel.sh`；`sh scripts/test-install.sh`（较慢）；`pnpm run check:docs`

**T14 BACKLOG 状态与清理**

- 改动：`docs/BACKLOG.md`
- 审计（接取时）：`awk '/自研 plan 模式：非流程控制部分/{f=1} END{exit !f}' docs/BACKLOG.md`；`awk '/状态: 进行中/{f=1} END{exit !f}' docs/BACKLOG.md`
- 审计（完成时）：`awk '/自研 plan 模式：非流程控制部分/{f=1} END{exit f}' docs/BACKLOG.md`（未命中时 `f` 为空，按 0 退出；§2 条目已清走。新写的 §1 完成行要避开这个整串，建议题作「自研 plan 模式：写面拦截与阶段注入」）；`awk '/写面拦截/{f=1} END{exit !f}' docs/BACKLOG.md`（§1 有完成行）

**T15 全仓验证**

- 改动：无
- 审计：`pnpm run check`；`pnpm run build`；`pnpm run test`；`pnpm run check:docs`

**T16 真机同步与确认**

- 改动：无代码改动（部署面）
- 审计：`sh scripts/install.sh --profile fff --sync`；`dsh --profile fff --dump-config 2>/dev/null | awk '/plan-mode-track/{f=1} END{exit !f}'`（`fff` 是本机主 profile 名，换机器两条命令都要换）
- 人工项：真跑一遍三段（探索段被拒 → 计划段确认 → 实施段放行），结果回填本文档；这条不能机械审计。

| 实施阶段 | 对应任务 |
| --- | --- |
| 接取前 | T0 |
| 阶段 1 | T1 |
| 阶段 2 | T2 / T3 / T4 |
| 阶段 3 | T5 |
| 阶段 4 | T6 / T7 |
| 阶段 5 | T8 |
| 阶段 6 | T9 至 T16 |

### 4.4 明确不做

- 不改 `task-engine` 执行内核；若确需「当前帧」透出服务面，另立条目。
- 不做子代理写调用继承（决策项 3 的 c 未选，已另立条目）。
- 不覆盖 `herdr_key` 与 `task_stop` 的验收命令：前者只发按键、没有命令正文（不在写面分类表，直接放行，判定顺序第 4 条），后者执行的是 `task_decompose` 里早先声明的命令，直接拒会挡住流程推进。两处的残留口子（按键重放终端历史里的旧命令、验收命令改文件）记在此处，需要时另立条目。
- 不新增流程入口工具、不改 `flow_select` 语义；TUI 段位另立条目。
- 不做阶段结构校验（探索结论齐备、计划清单完整一类），需要时另开。
- 不接管官方 `ctx.planMode`，官方 plan-mode 保持停挂。
- 不加运行时开关：紧急停用在 profile patch 给该行加 `disabled: true`（与官方 plan-mode 同款，`profiles/example/cordis.patch.yml:274-279`），代价是 `plan_start` 一并停掉；告警沿用既有 `[plan-mode] warn:` 前缀（`plan-mode/src/index.ts:70-76`）。
- 不改 `STATUS.md`（由用户择时更新）。

## 5. 更正记录

写作与审阅中纠正过的事实：拦截骨架在 `flow-arbiter/src/index.ts:148-167` 与 `state.ts:137-166`（不存在 `pre-execute.ts`）；会话结束有 `ctx.on("session/disposed")`（`docs/host/DSH-CTX-API.md:36`）；子代理继承是决策项 3 的 c；改动清单是 13 条 / 17 个文件；入口早已由 `flow_select` 提供，缺的只是状态位与展示；归档按 `docs/WORKFLOW-STANDARD.md:48` 移入 `docs/archived/`。

## 6. 验证与证据

- `pnpm run check:docs`：通过，125 篇现行 Markdown / 999 个 .ts，错误 0 / 警告 0。
- `format`：对 `docs/BACKLOG.md` 与本文件均退出 0。
- 交叉核对（均为实读，按面分列）：
  - plan-mode 现状：`src/index.ts` 无 `ctx.on`；`src/plan-start.ts:121` 的 `execute(args)` 未收第二参。
  - task-engine：`src/plugin.ts:437-446` 服务面只有三项；`src/events.ts:20-125` 只有引擎内部事件，包内无 `ctx.emit`。
  - 宿主与预设：`permission-presets/src/index.ts:343` / `:398` 的 `current(session)` 与 `set(session, name)`；`cache-hit-monitor/src/index.ts:232` 的 `session/disposed` 订阅；`docs/host/DSH-CTX-API.md:36`。
  - 写面与入口：`security-guard/src/tool-registry.ts:9-54` 写面清单、`:124-129` 终端命令面（`herdr_run` / `herdr_text` / `herdr_key`）；`ast-tools/src/tools.ts:378-384` 的 `write: true` 写回开关；`flow-arbiter/src/state.ts:137-166` 入口裁决。
  - 部署：`scripts/install.sh:44` 的 `canonical_pkgs` 含 `pin-note` / `plan-mode`；`STATUS.md:16` 主 profile 未同步。
- 单测：`pnpm -C plan-mode run test` 11/11 通过（2026-11-15）。
- 审计命令试跑：未实现项（`test -f guard.ts`、依赖声明、`pre-execute`、node_modules 链接、工具说明里的「只读」）退出 1；已有基线（`fail 0`、`test-parallel.sh` 枚举、`session/disposed`）退出 0，与预期一致。

## 7. 收尾

- 回写：`docs/BACKLOG.md`（§1 记完成、§2 立三条条目、修失效引用）与本文件。
- 遗留：`docs/BACKLOG.md` §2 的三条条目均未接取；主条目按本文件 §3 / §4 接取，段位展示与子代理继承各自独立。
- 归档：本文件已移入 `docs/archived/`。
