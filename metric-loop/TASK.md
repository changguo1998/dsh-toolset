# 任务：metric-loop

> 本文件为 herdr worktree 任务契约。**只允许修改本 worktree 的 `metric-loop/` 目录内文件**（pre-commit 钩子强制，其他目录/根文件的提交会被拒绝）。

## 目标

实现指标驱动自动循环：由协作者进程按 schedule 周期唤醒执行一条「测量命令」（输出单个数字），循环改进目标，指标无改进达窗口即 plateau 停止；支持边界上限（时间/轮数）与 cadence（两次自动唤醒最小间隔）。

## 来源

对比文档 §3.1 拆项 3（| loop | 指标驱动自动循环 + plateau 停止 | 🔶 无「指标驱动自动循环 + 平台停止」现成语义）；`docs/DEVELOPMENT-BACKLOG.md` 插件规划表 `metric-loop`（P1）。

## 复用底座（不新建）

- `workflow` / `workflow-worker-thread`：循环载体
- `schedule`（after/at/rate）：周期唤醒
- 测量命令由用户提供（单一数字输出），方向（min/max）、窗口、cap 上限均为配置
- 参考主仓 `knowledge-base/` 插件模板（`dsh.bundle` + `cordis.patch.yml` + `src/` + `tests/` + `smoke/`）

## 接口对齐

`DSH-CTX-API.md`（0.1.5-rc.2 契约）+ 词汇表。语义：

- `direction`：min（越低越好）/ max（越高越好）
- `window`：连续 N 轮无改进 → plateau 停止（默认 5）
- 边界：轮数 cap（默认 50）、时间 bound（可选）、token bound（可选）
- cadence：成功后自动唤醒的最小间隔（秒）；显式 start/resume 视为紧急唤醒不受 cadence 限制
- 无测量命令（metricless spec loop）：按边界停止，不做 plateau 判定

## 交付物（均在 `metric-loop/` 下）

- `metric-loop/package.json`（含 `dsh.bundle` 键）+ `cordis.patch.yml`
- `metric-loop/src/`：循环编排（workflow 载体）、测量命令执行与解析、plateau 判定、边界守卫 + DSH bundle 接入面
- `metric-loop/tests/*.test.ts`：plateau 判定、方向、边界、metricless 路径、cadence 语义
- `metric-loop/smoke/smoke.mjs`：真实 dsh 会话验证一轮循环 + 停止语义（可选）

## 完成门槛

1. `npm --prefix metric-loop run check`（tsc --noEmit 严格）通过
1. `npm --prefix metric-loop run test` 全绿（node --test）
1. `npm --prefix metric-loop run build` 产出 `dist/`
1. 改动文件执行 `format <文件...>`
1. 独立 profile `~/.dsh/profiles/dsh-metric-loop`（`link:` 指向本 worktree）+ smoke/示例验证

## 硬约束

- 只改 `metric-loop/` 目录；其余目录与根文件一律禁止改动
- 提交仅限本 worktree 的 `feat/metric-loop` 分支；不 merge main、不 push
- 不装全仓依赖，自包依赖按需最小（优先复用 workflow/schedule 宿主面）
- 不实现任务未提及的额外功能；代码注释中文、标识符英文
