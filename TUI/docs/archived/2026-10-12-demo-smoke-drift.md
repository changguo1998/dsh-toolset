# 演示冒烟期望漂移（接取条目：`TUI/docs/BACKLOG.md` 的〈演示冒烟期望漂移〉）

状态：进行中　　开启：2026-10-12
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`npm run demo -- --smoke` 的期望值与六步流水线的现状对齐：属**期望漂移**的项重设判据（不改产品行为），属真回归的项按回归修。

## 定性（已完成）

- 归档文档 `TUI/docs/archived/2026-10-10-markdown-cache-key.md:62` 记有 A/B 判据：`git worktree add` 出一棵干净 HEAD、跑同一条命令，失败项与本工作树**逐字相同**（当时 3 项：`step-header`、`activity-mixed-ordered`、`activity-mixed-activity-side`）→ 期望值随六步流水线切换漂移，与主题缓存键改动无关。
- 本轮实测（2026-10-12）：`npm run demo -- --smoke` = **40 PASS / 6 FAIL**（BACKLOG 里记的 36/7 是旧数）。失败项 = 上述 3 项 + `subagent-line`、`tool-meta-diff`、`policy-notice`（后三项属 BACKLOG 的〈演示冒烟现状〉条目，不在本条范围；`step-header` 两条重叠，一并处理）。

## 三条漂移项的现状与处置方向

| 断言（`demo/main.ts`） | 现状 | 处置方向 |
| --- | --- | --- |
| `step-header`（`:417-421`） | 期望帧内有 `hh:mm:ss ⇆N #1 `；实测无 | 待定：step 头是**内容驱动**（回合区无内容就不画，见条目「孤儿步骤分隔线」）→ 或改 demo 场景让第 1 步在回合区有内容，或按内容驱动重设判据 |
| `activity-mixed-ordered`（`:544-548`） | `idx=12,14,-1,15,14`：`mixed-check`（`aTool`）找不到；`aSum`(14) 不 > `aN`(15) | 待查：工具行为何缺失（很可能 demo 的 mock 交付与节模型现状不匹配） |
| `activity-mixed-activity-side`（`:570-577`） | `divCol=49 sumRow=14 midRow=14`，同一行出现 `混合中间输出混合最终总结` | 初步判断：mock 把多段文本用**同一个 `index`** 交付 → 节内**直拼成一行**（设计如此）→ demo 侧应给不同 `index`（真实宿主每个文本块一个号） |

## 计划改动文件清单

- `TUI/demo/main.ts`（三条判据 + 混合场景的 feed）；
- 可能 `TUI/demo/mockAdapter.ts`（块的 `index`、工具调用 / 结果的镜像）；
- 本文档 + `TUI/docs/BACKLOG.md`。

## 实现记录

1. `demo/mockAdapter.ts` 两处**镜像保真**修正（都不是产品改动）：
   - `stream` 事件**每块一个自增 `index`**（原来一律 `index: 0`）：同节相邻文本块被节模型按「同块流式续写」直拼成一行——实测帧里出现 `混合中间输出混合最终总结` 正是这个；
   - 内容交付跟随**当前 step**（新增 `mirrorStep`，由 `step` 事件推进；原来写死 `step: 1`）：`step-start` 声明的 `(turn, step)` 与内容落地的 `(turn, step)` 对不上 → 内容驱动的 step 头永远不画。
1. `demo/main.ts`：`step-header` 判据按现状重设 —— 本场景只画 `(回合 2, 步 2)` 的头（步 1 的头是首个头，被 `suppressFirstHead` 压掉），断言 `⇆2 #2` 而非旧的 `⇆N #1`。

## 测试与证据

- 冒烟：**41 PASS / 1 FAIL**（汇总 `n=1`）。三条漂移项（`step-header`、`activity-mixed-ordered`、`activity-mixed-activity-side`）全部转绿；块序号修正还顺带让 `subagent-line`、`policy-notice` 转绿。剩余唯一失败 = `tool-meta-diff`（`BlockDelivery` 的 `tool-result` 无 `meta` → diff 摘要永不显示，属 BACKLOG〈演示冒烟现状〉条目②的范围）。
- 全量：TUI `npm test` **1470 / 1470**；全仓 `npm test` 退出码 0（21 包全 OK）；`npm run check` / `npm run build` 各 0 条 TS 错。
- 真机复核：**不需要**（只改 demo 场景与冒烟判据，不动产品行为）。

## 审阅记录

（待补）

## 收尾

- **实现**：`5b3fd88`（mock 镜像两处保真修正 + `step-header` 判据按现状重设）。
- **验收对照**：
  1. 「三条漂移项转绿」✓ —— 冒烟 `SMOKE_PASS step-header`、`activity-mixed-ordered`、`activity-mixed-activity-side`；整体 **41 PASS / 1 FAIL**，唯一剩余 `tool-meta-diff` 属第 3 条范围。
  1. 「不改产品行为」✓ —— 只动 `demo/`（mock 镜像与判据），`src/` 零改动。
  1. 「全量测试绿 + check 干净 + build 通过」✓ —— TUI 1470 / 1470、全仓 `npm test` 退出码 0、`check` / `build` 各 0 条 TS 错。
- **遗留（另记 BACKLOG）**：`tool-meta-diff`（第 3 条②）、`subagent-line` 若再现（本次已随块序号修正转绿，未再单独处理）。
- **归档**：本文件移入 `TUI/docs/archived/`；`TUI/docs/BACKLOG.md` 移除该条。
