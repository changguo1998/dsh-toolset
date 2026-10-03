# ponytail 设计（@dsh-toolset/ponytail）

## 目标与边界

把上游 ponytail 的「懒资深工程师」决策阶梯做成**可开关的上下文注入**。边界：**不搬**钩子（DSH 无该面）、不做 MCP、不做 benchmarks；只做「注入 + 开关」。

## 分层

- `src/ladder.ts`：阶梯文本**自带副本**（来源 `~/GithubRepos/ponytail` v4.10.3，MIT）+ 摘要常量。文案漂移由 `tests` 的关键词断言守卫。
- `src/main.ts`：契约符号（`name` / `inject` / `Config` / `apply`）+ `resolveConfig()`（非法值回退缺省）+ 消费者注册（结构化 `RuleEngineLike`，不 import 对方代码）。
- `cordis.patch.yml`：bundle 层 insert 自身，缺省 `enabled: false`。

## 命令面（D4 降级说明）

原计划 `/ponytail`（开关）+ `/ponytail-audit`（过度工程审查）。**本批降级**：只做「配置开关 + 注入」——DSH 的 slash 命令注册面属 TUI/宿主侧契约，落地成本高于本条目核心价值；`/ponytail-audit` 另开条目评估（如做成 rule-engine 消费者 + 工具面）。

## 关键设计取舍

1. **注册为 rule-engine 消费者**（对齐 `symbol-normalizer` 先例）：注入交给 rule-engine 统一调度（去重 / 冷却 / 投递），本包不自造注入面。
1. **默认关闭**：与 `karpathy-guidelines` 双份注入会刷屏；显式开启才生效（`config.enabled: true`）。
1. **`delivery: "inject"`**：挂在最近 pre-step、不唤醒 —— 模式提示不该打扰会话节奏。
1. **缺省 `sources: ["session-start"]`**：模式提示在会话起始注入一次即可；`dedupeInRecord: 1` 防重复。
1. **rule-engine 缺席 fail-soft**：告警一次 + 不注册，绝不抛到宿主（对齐本仓既有姿态）。
1. **文本自带副本**（不运行时读上游仓）：避免外部路径依赖；上游更新需人工同步并改 `tests` 关键词断言。
