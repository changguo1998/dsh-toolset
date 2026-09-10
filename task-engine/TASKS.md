# task-engine 开发任务安排

> 来源：`docs/DEVELOPMENT-BACKLOG.md` #1-#5、#13（P0）；分支 `feat/task-engine`（基线 c1ad2ae）。
> 定位：**架构主线**——任务树引擎（设计文档 `docs/AGENT-ARCHITECTURE-ANALOGY.md` §13-§18）。
> 状态：**首版最小闭环已完成（2026-09-10）**。实现见 `task-engine/README.md`；
> `npm run check` / `build` / `test`（21 用例）全绿，`npm run demo` 输出 DEMO_OK；
> 已经 `dsh plugin add` 部署到 `~/.dsh/profiles/dsh-toolset-tui`（link 依赖 + bundles，
> profile 为目录外用户确认例外），启动加载无 `ERR_MODULE_NOT_FOUND`、4 个 `task_*` 工具注册成功。
> 第二迭代未启动。

## 目标（首版最小闭环）

1. 栈引擎：Frame 状态机、decompose/pop、join 续体、就绪池（**先单执行器**）、bounded retry；
1. 模型侧工具族：`decompose` / `implement` / `stop` / `status` + 嵌套任务列表（`parent_id` + `order`）；
1. 门禁（机械部分）：粒度四规则（越级/过粗/过细/数量）+ coverage 映射，拒绝带反馈打回；
1. RET 验收路由：mechanical（命令退出码）+ human（approval 链）两级。

**第二迭代**：fan-out（#13：就绪池多执行器 + agent-team DAG）、semantic 级验收（独立 audit run + outputSchema）、step 级 `accepted`/`next` 裁决字段（#5）。

## 任务分解

- [x] 脚手架（同 herdr-integration 流程，以 `TUI/` 为模板）
- [x] 数据结构：Frame/任务树；事件溯源（`plan/node-expanded {parent, children}` 等自定义事件 + 内存树 + 周期快照）
- [x] 引擎服务（cordis 服务注册：状态机、就绪池、续体激活）
- [x] 模型侧工具族 + 嵌套 todo
- [x] 门禁（机械：粒度四规则 + coverage）
- [x] RET 路由（mechanical/human；注意 `ctx.approval` turn-enclosed 约束，后台作业 fail-closed）
- [x] mock demo（无 DSH 依赖，对齐 `TUI/demo/` 模式）
- [x] 构建部署 + 人工确认

## 复用（不新建）

`ctx.subagents.start()` / fork-in-process、`outputSchema` → `SubagentResult.structured`、`SubagentCapabilities.depthLimit`、`session.append` + `ignorable`、`SessionSeq`、storage-sqlite、experimental-agent-team（DAG）。

## 约束

- **所有改动仅限本目录（`task-engine/`）内；不得修改仓库根目录任何既有文件**；跨目录变更回 `migrate-pi-plugins` 处理。
- 契约对齐 `DSH-CTX-API.md`；设计对照 `AGENT-ARCHITECTURE-ANALOGY.md` §10/§13-§18。
- 变更流程：改代码 → `npm run build` → 人工确认 → 提交；Conventional Commits 中文。

## 验收

对照 BACKLOG #1-#4：单执行器下 decompose → implement → stop 全链路可跑通；门禁拒绝与带反馈打回生效；验收按 mechanical/human 分级路由。
