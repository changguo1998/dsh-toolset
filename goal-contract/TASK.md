# 任务：goal-contract

> 本文件为 herdr worktree 任务契约。**只允许修改本 worktree 的 `goal-contract/` 目录内文件**（pre-commit 钩子强制，其他目录/根文件的提交会被拒绝）。

## 目标

实现 goal 会话中的契约起草与验证条款形态：在 dsh-goal（事件源目标）之上补「interview 式起草 + 可验证 Done-when 契约条款」的交互形态（对照 pi 的 propose_goal_draft：objective、verificationContract、确认对话框）。

## 来源

对比文档 §3.1 拆项 1（| goal | 目标起草与契约 | 🔶 缺「interview 起草/验证契约条款」形态）；`docs/DEVELOPMENT-BACKLOG.md` 插件规划表 `goal-contract`（P1）。

## 复用底座（不新建）

- `dsh-goal` / `goal-round-driver` / `command-goal` / `tool-goal`：目标事件源与轮次驱动
- `tool-ask-user`：interview 提问（结构化选项/自由回答）
- **契约 schema 取自 task-engine**（经宿主 context 的 `ctx.get(...)` 面，**不做 npm 级互相依赖**）
- 参考主仓 `knowledge-base/` 插件模板（`dsh.bundle` + `cordis.patch.yml` + `src/` + `tests/` + `smoke/`）

## 接口对齐

`DSH-CTX-API.md`（0.1.5-rc.2 契约）+ 词汇表。语义：

- goal 起草入口：interview 式提问（目标、Done-when 验证条款），经 `tool-ask-user`
- 契约条款：结构化（可验证的 done-criteria，如命令/文件状态/测试结果）
- 起草结果落 dsh-goal 事件源；多 item 时可承接 liite/队列式逐项

## 交付物（均在 `goal-contract/` 下）

- `goal-contract/package.json`（含 `dsh.bundle` 键）+ `cordis.patch.yml`
- `goal-contract/src/`：interview 流、条款 schema（对齐 task-engine 契约）、落 goal 事件源 + DSH bundle 接入面
- `goal-contract/tests/*.test.ts`：interview 状态机、条款校验、goal 事件落地
- `goal-contract/smoke/smoke.mjs`：真实 dsh 会话验证起草→落 goal→条款回读

## 完成门槛

1. `npm --prefix goal-contract run check`（tsc --noEmit 严格）通过
1. `npm --prefix goal-contract run test` 全绿（node --test）
1. `npm --prefix goal-contract run build` 产出 `dist/`
1. 改动文件执行 `format <文件...>`
1. 独立 profile `~/.dsh/profiles/dsh-goal-contract`（`link:` 指向本 worktree，**需同挂 task-engine bundle**）+ smoke 通过 + 人工确认

## 硬约束

- 只改 `goal-contract/` 目录；其余目录与根文件一律禁止改动
- 提交仅限本 worktree 的 `feat/goal-contract` 分支；不 merge main、不 push
- 与 task-engine 只经宿主 context 通信，**不引入 npm 依赖**
- 首次应先读 `task-engine/` 的契约 schema（当前 worktree 内已存在），对齐字段后再实现
- 不实现任务未提及的额外功能；代码注释中文、标识符英文
