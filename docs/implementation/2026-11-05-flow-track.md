# 标准流程固化插件 flow-track（接取条目：docs/BACKLOG.md「标准流程固化插件 `flow-track`」）

状态：调研 / 决策 / 规划 / 实现 / 测试 / 关闭　　开启：2026-11-05　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

把项目「标准流程」（`docs/WORKFLOW-STANDARD.md` / `AGENTS.md` 内容变更规范）从「文档规范 + agent 自觉」固化为插件机制：

- 流程阶段由 **task-engine** 承载为任务树——根下第一层分解 = 标准流程各阶段（登记 BACKLOG / 建追踪文档 / 实现 / 测试+人工确认 / 收尾归档 / 提交询问），各帧 `deps` 指前序、`acceptance` 设门（mechanical / human / semantic），human 验收走 `approval.request` = 提交询问点；
- 流程正文与状态落 **memory-base**（P 层 project 库，`registerKind` 写句柄 + 本插件补模型侧写工具）；
- 回合边界经 **rule-engine** 消费者注入阶段模板、检查合规、带路推进。

命名定稿（2026-11-05 用户裁定）：`flow-track`，项目内「动词+对象」风格（与 `pin-note` / `term-check` 同构）。避让：不用 `workflow` 作包名（task-engine 叶子执行后端已占用该 kind 语义）。

## 调研（来源：既有代码与既有裁定）

- `task-engine/README.md`：工具族 `task_decompose` / `task_implement` / `task_execute` / `task_stop` / `task_status`; 引擎内核 `TaskEngine.decompose` / `implement` / `execute` / `stop` / `query` / `frameStack`（`engine.ts:63-609`, 零 DSH 依赖）; `provide('taskEngine')` 服务面只暴露只读 `query()` / `frameStack()`; config `root` 只收 `{title, spec, acceptance[], needDecompose?}`; 机械门禁四规则（`DESIGN.md:66`）：越级 / 过粗 / 过细 / 数量（数量本身不设上限, >8 才要枚举来源）+ coverage + deps（只允许引用前序兄弟）+ executor 校验; RET 验收：mechanical（`/bin/sh` 退出码）/ human（`ctx.approval.request`, fail-closed）/ semantic（audit / entail 子代理裁决）; 事件溯源 `plan/*` + `snapshotPath` 快照 + `resumeFromSnapshot`。
- `memory-base/README.md:9`：**不注册写工具**——模型侧只有只读 `memory_query`; 写权限留在各扩展的 `registerKind(spec)` 返回的写入句柄（`writableTiers` 声明可写层, P 层 project 库）。
- `rule-engine/README.md`：消费者 `decide`（每回合边界按注册节点询问, 返回值注入）+ guard 面（`tools/pre-execute` 拦截）+ `agent/pre-step` 注入面（goal-round-driver / agent-instructions 同款通道）。
- 既有裁定：先例插件 `pin-note` / `term-check` 同为「跨压缩 / 治理类」插件条目; 追踪文档仍是 md 文件（git / check:docs / md-map / 归档三件套); 流程**状态与流程文档正文**落 memory-base（用户在 2026-11-05 讨论中选定「混合」取向: 正文留文件、状态落库, 分支见「决策」）。

## 决策

- 决策项 1 = 插件命名
  - 候选（动词+对象风格）: `flow-track` / `flow-check` / `change-track` / `flow-gate`
  - 选定：`flow-track`（用户 2026-11-05 裁定）。理由：动词 track + 对象 flow, 覆盖「流程状态跟踪 + 阶段推进」核心; 与 `term-check` / `pin-note` 同构; `flow-check` 只突出合规检查, `change-track` 语义窄, `flow-gate` 偏硬固化。
- 决策项 2 = 流程承载形态
  - a. **task-engine 骨架（选定）**: 根下第一层 = 标准流程各阶段, 每帧 `deps` 指前序、`acceptance` 设门, human 验收 = 提交询问点
  - b. 自研状态机: 重复实现拆解 / 验收 / 重试, 不采用
- 决策项 3 = 流程存储形态
  - a. **混合（选定）**: 追踪文档正文仍是 md 文件（git / check:docs / md-map / 归档不变）; 流程状态 / 检查点 / 提交询问记录落 memory-base P 层
  - b. 全文入库: 追踪文档正文整体存 memory-base, 文件体系仅留入口——需另评审文档体系配套改动, 暂不采用
- 决策项 4 = 固化强度与模板来源（**接取时接续裁定**, 本条只定框架）
  - 阶段模板来源: a. 模型照注入模板手动 `task_decompose`（推荐先落地, 零改引擎）; b. 插件回合边界自动 `TaskEngine.decompose`（需 import 引擎内核或扩服务面写方法）
  - 大 / 小流程分流: 标准流程走阶段树, 小改动（快速流程）不建树——判据待定
  - 固化强度档: 软（注入提醒）→ 中（每轮注入推进状态）→ 硬（guard 拦截）, 待定档

## 规划

任务拆分（接取时细化）：

1. 建包 `flow-track`（`package.json` 的 `dsh.bundle` + `cordis.patch.yml` 集成契约, 参照轻量插件模板）。
2. memory-base 接线：`registerKind({ kind, writableTiers: ["project"] })` 拿写句柄; 注册模型侧写工具（如 `flow_record`）把流程状态 / 追踪文档正文落 P 层; 只读查询复用 `memory_query`。
3. task-engine 接线：注入标准流程阶段模板（决策项 4 定来源）; 阶段帧 spec 按门禁四规则写单动作; 根契约验收分配到各阶段 coverage; human 验收接提交询问。
4. rule-engine 消费者：回合边界注入阶段模板 / 检查合规（改源码未登记、轮内未写追踪文档）/ 注入当前推进状态（决策项 4 定档）。
5. 大 / 小流程分流判据落地。
6. 配套：`pnpm run check` / `test` / `check:docs` 全绿; 真机验证一次标准流程全阶段推进 + 提交询问经 human 验收呈现。

计划改动文件清单：

- `flow-track/`（新包: `package.json` / `cordis.patch.yml` / `src/main.ts` 等）
- `docs/BACKLOG.md`（条目登记, 已完成）
- 本追踪文档
- 可能: 根 `package.json`（包枚举 / 委托链）、`scripts/install.sh`（包枚举）、`AGENTS.md`（插件清单与文档分工）、根 `README.md` / `README.zh.md`（包清单）

明确不做：

- 不改 task-engine 引擎内核与门禁规则（阶段分解在既有能力内表达）
- 不改 memory-base（不把写工具内联到 memory-base, 保持"写权限留扩展句柄"口径）
- 不做全文入库形态（文档体系三件套保留）
- 不替换宿主 todo / experimental-agent-team
- 不动 `STATUS.md`（用户择时更新）

## 实现记录

（待写）

## 偏差

（待写）

## 测试与证据

（待写）

## 收尾

（待写）
