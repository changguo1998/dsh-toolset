# `hash-edit` / `md-logic` / `ast-tools` 的写面一读就抛 `workingDirectory` 未 inject（接取条目：docs/BACKLOG.md「`hash-edit` / `md-logic` / `ast-tools` 的写面一读就抛 `workingDirectory` 未 inject」）

状态：关闭　　开启：2026-11-09　　关闭：2026-11-09
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 三包的模型侧工具恢复可读可写：`hash_read` / `hash_edit`、`md_logic`、`ast_query` / `ast_replace` 不再抛 `cannot get property "workingDirectory" without inject`。
2. 同根因的第二个雷一并拆掉：`host.sandboxPolicy` 直读（写入路径取围栏策略）在服务未 inject 时同样抛错。
3. 保持包内既有语义：可选服务缺席时按后端缺省处理, 不回落 node 标准库, 不改工具契约与输出。

## 调研

- 失败原文与根因：cordis 的 ctx 代理在 `Reflect.has` 不命中时直接抛 `cannot get property "X" without inject`（`@deepseek-ai/cordis/src/reflect.ts:144-152`）。三包 `inject` 只有 `["tools", "fs"]`（`hash-edit/src/index.ts:42`、`md-logic/src/index.ts:91`、`ast-tools/src/index.ts:127`）, 而 `ctx-fs-io.ts` 把 `apply` 收到的原始 ctx 当宿主面直读两个未 inject 的服务：
  - `host.workingDirectory`（`hash-edit/src/ctx-fs-io.ts:160,163`、`md-logic/src/ctx-fs-io.ts:143,146`、`ast-tools/src/ctx-fs-io.ts:159,162`）—— `dsh-working-directory/lib/types/index.d.ts:11` 挂 `ctx.workingDirectory`。
  - `host.sandboxPolicy`（`hash-edit:194`、`md-logic:177`、`ast-tools:168`）—— `dsh-sandbox-policy/lib/types/index.d.ts:30` 挂 `ctx.sandboxPolicy`, 由 `dsh-fs-sandbox` 以 `static inject = ["sandboxPolicy"]` 声明为服务。
- 执行顺序决定了先抛哪个：读 / 写都先 `fs.resolve(path, { cwd })` → `resolveExecCwd` 读 `workingDirectory` → 立刻抛, 所以 `sandboxPolicy` 这一半是**尚未被触发的同根因缺陷**（`fs.sandboxMode` 有值时才读, 写入路径命中）。
- 两条修法都有先例：官方包把 `workingDirectory` 写进 `inject`（`dsh-file-reference-local:321` `["agents","workingDirectory"]`、`dsh-agent-instructions:1271`）；本仓则用 `ctx.get` 受保护读（`clock-base/src/timers.ts:276` 注释「未 inject 的服务直读会抛, 故只走 get」、`code-map/src/semantic/lsp.ts:99`）。
- `ctx.get` 是官方明确的不经 inject 校验的读取口：`ReflectService.get`（`cordis/src/reflect.ts:240-249`）注释 *Read a service from the store without the inject requirement*, 服务未提供时返回 `undefined`。
- 现有测试面：三包各有一份 `tests/assemble.ts` 造假宿主（`get(name)` + `ctx.<name>` 两个面都暴露, 见 `hash-edit/tests/assemble.ts:418-431`）, 因此现网那层代理守卫**没有**被模拟到——单元测试全绿但真机必崩, 这是本次要补的缺口。
- 两处单测把 `inject` 钉死为 `["tools","fs"]`（`md-logic/tests/tool.test.ts:85`、`ast-tools/tests/tool.test.ts:122`）, 走 inject 方案要一并改。

## 决策

1. 修法取**受保护读**（用户 2026-11-09 裁定）：三包在 `ctx-fs-io.ts` 各加一个服务取值函数, 先 `host.get(name)`（真宿主走这里, 不经 inject 校验）, 拿不到再退回直接属性读（库面 / 单测的普通对象宿主, 没有 `get`）。否决「加进 inject」：三包对这两个服务的口径是**可选**（缺席即交后端缺省）, 加进 `inject` 后服务缺席会让插件静默不加载, 与「缺面降级、返回可行动错误」的包内契约冲突。
2. 修两处而不是一处：`workingDirectory` 与 `sandboxPolicy` 同根因、同文件、同一取值函数, 分两次修只会让第二个雷留到真机写入时才炸。
3. `inject` 保持 `["tools","fs"]` 不变, 工具契约、错误码、输出全部不变。
4. 回归测试补在**宿主面形状**上：给三包 `tests/assemble.ts` 加 `injectGuard` 选项——打开后 `workingDirectory` / `sandboxPolicy` 的属性直读按真宿主文案抛错, `fs` / `tools` 照常可读。这样旧代码必红、新代码必绿, 且不需要连真宿主。

## 规划

- 计划改动文件清单：
  - `hash-edit/src/ctx-fs-io.ts`（新增受保护读函数, `resolveExecCwd` 与 `sandboxPolicy()` 改走它）
  - `md-logic/src/ctx-fs-io.ts`（同上）
  - `ast-tools/src/ctx-fs-io.ts`（同上, `resolveOptions` 内联读改走函数）
  - `hash-edit/tests/assemble.ts`（`injectGuard` 选项 + 代理包装）
  - `md-logic/tests/assemble.ts`（同上）
  - `ast-tools/tests/assemble.ts`（同上）
  - `hash-edit/tests/ctx-fs-io.test.ts`（代理形态回归用例：读 + 写各一次, 断言 cwd 与策略真的传下去）
  - `md-logic/tests/ctx-fs-io.test.ts`（同上）
  - `ast-tools/tests/ctx-fs-io.test.ts`（同上）
  - `docs/BACKLOG.md`（条目状态：进行中 → 完成 / 移除）
- 明确不做：不改 `inject` 声明、不动 `tests/tool.test.ts` 的 inject 断言、不改工具 schema 与 README 的用户面描述（工具行为对外无变化）、不动其它包。
- 验证：三包 `pnpm -C <包> run test` + `run test:integration`；根 `pnpm run check` / `pnpm run build` / `pnpm run test` / `pnpm run check:docs`。
- 未验证项（提前说明）：真机会话里的「工具恢复可用」要等 profile 重新同步并重启会话后才可观察, 本任务只做到单测层面的代理形态仿真 + 一份临时脚本对真 cordis 的独立验证。

## 实现记录

- 2026-11-09：三包 `src/ctx-fs-io.ts` 各加 `optionalService<T>(host, name)`——先 `host.get(name)`（真宿主走这里）, 取不到或抛错再退回属性直读（普通对象宿主）, 两条路径都按 `undefined` 降级；`resolveExecCwd`（hash-edit / md-logic）、`resolveOptions`（ast-tools）与三处 `sandboxPolicy()` 全部改走它。
- 2026-11-09：三包 `tests/assemble.ts` 加 `injectGuard` 选项, 在 ctx 构造后用 `guardServices` 包一层 Proxy：`workingDirectory` / `sandboxPolicy` 直读按宿主原文抛错, `fs` / `tools` 照常透出。不能做在基对象的 getter 上——`ctx = { ...base }` 会在装配期求值 getter, 守卫会提前触发。
- 2026-11-09：三包 `tests/ctx-fs-io.test.ts` 各加 1 例代理形态回归（hash-edit 读 + 写、md-logic replace、ast-tools replace write）, 断言 cwd 走到后端、`sandboxPolicy.resolve` 的返回值原样传给 `writeText`、`workingDirectory.ensure` 被调用。

## 偏差

- 条目只写到 `workingDirectory`；实现一并修了同根因的 `sandboxPolicy` 直读（写入路径会第二次抛, 见调研）。属同一条缺陷的完整修复, 不是顺手改别处。
- 条目给了「加进 inject」与「ctx.get」两选一, 按用户裁定取后者。
- 首版把守卫写在假宿主的属性 getter 上, 被对象展开在装配期触发（新用例在 `assemble` 阶段就红）；改为 ctx 构造后包 Proxy。

## 测试与证据

- `pnpm -C hash-edit run test`：**66 例全绿**（原 65 + 新 1）；`test:integration` **18 例全绿**。
- `pnpm -C md-logic run test`：**84 例全绿**（原 83 + 新 1）；`test:integration` **10 例全绿**。
- `pnpm -C ast-tools run test`：**90 例全绿**（原 89 + 新 1）；`test:integration` **9 例全绿**。
- 反向验证（把三包 `src/ctx-fs-io.ts` 换回 HEAD 版本）：新增 3 例各红 1 例, 其余全绿——hash-edit 65/66、md-logic 83/84、ast-tools 89/90, 失败原文 `cannot get property "workingDirectory" without inject`。
- 真代理验证（一次性脚本, 已删）：用宿主同一份 `@deepseek-ai/cordis`（`lib/index.js`）起三个服务（`fs` / `workingDirectory` / `sandboxPolicy`）, 再用 `inject: ["fs"]` 的插件拿到上下文, 调构建产物 `hash-edit/dist/src/ctx-fs-io.js`：属性直读确实抛 `cannot get property "workingDirectory" without inject`；`io.resolve` 收到的 cwd 是 `workingDirectory.ensure` 的返回值 `/cwd-from-proxy`；`writeText` 收到的策略是 `sandboxPolicy.resolve` 的返回值。输出 `REAL_PROXY_CHECK_PASS`。
- 根 `pnpm run check`（38 包 exit 0）、`pnpm run build`（exit 0）、`pnpm run test`（38 包全绿, hash-edit 66 / md-logic 84 / ast-tools 90）、`pnpm run check:docs`（119 篇 / 959 个 .ts, 错误 0 / 警告 0）。
- 未验证：真机会话里的工具恢复要等 profile 重新同步并重启会话后才可观察（本会话跑的是安装快照里的旧构建）。`ctx.logger` / `ctx.waterfall` / `ctx.emit` 属 cordis 核心面, 代理按 accessor 放行, 本次未单独改动。

## 收尾

- BACKLOG 条目已标完成并从 `docs/BACKLOG.md` §2 移除；本文件移入 `docs/archived/`。
- 回写：无（工具契约、错误码与对外行为未变, 三包 README 的 `inject` 口径仍准确）；`docs/STATUS.md` 按约定由用户择时更新, 本任务未改。
- 提交：本批次未在决策 / 实现 / 测试三个检查点逐次提交, 收尾一次提交（沿用上一批次口径, 待用户确认）。
