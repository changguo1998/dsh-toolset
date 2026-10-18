# ponytail 设计（@dsh-toolset/ponytail）

契约与用法见 `../README.md`；上游调研与方案取舍见 `docs/ponytail-investigation.md`（项目级，本仓 `docs/` 下）。

## 目标与边界

把上游 ponytail 的「懒资深工程师」决策阶梯做成**可开关的上下文注入**。边界：**不搬**钩子（DSH 无该面）、不做 MCP、不做 benchmarks；只做「注入 + 开关」。

## 分层

- `src/ladder.ts`：阶梯文本**自带副本**（来源 `~/GithubRepos/ponytail` v4.10.3，MIT）+ 摘要常量。文案漂移由 `tests` 的关键词断言守卫。
- `src/main.ts`：契约符号（`name` / `inject` / `Config` / `apply`）+ `resolveConfig()`（非法值回退缺省）+ 消费者注册（结构化 `RuleEngineLike`，不 import 对方代码）。
- `cordis.patch.yml`：bundle 层 insert 自身（`enabled: true` + `sources: ['session-start', 'step-end']` + `dedupeInRecord: 1`；显式 `false` 关闭）。

## 命令面（D4 降级说明）

原计划 `/ponytail`（开关）+ `/ponytail-audit`（过度工程审查）。**本批降级**：只做「配置开关 + 注入」——DSH 的 slash 命令注册面属 TUI/宿主侧契约，落地成本高于本条目核心价值；`/ponytail-audit` 另开条目评估（如做成 rule-engine 消费者 + 工具面）。

## 关键设计取舍

1. **注册为 rule-engine 消费者**（对齐 `symbol-normalizer` 先例）：注入交给 rule-engine 统一调度（去重 / 冷却 / 投递），本包不自造注入面。
2. **默认开启**（2026-10-05 起，见 `../README.md` 开头）：编码行为由本插件承担；`config.enabled: false` 可关闭。
3. **`delivery: "steer"`**（缺省）：挂到最近 pre-step 并唤醒（`inject` 不唤醒，真机 agent 非 live 时会被丢弃）。
4. **缺省 `sources: ["session-start", "step-end"]`**：会话起始注入一次；`step-end` 作兜底（session-start 时 agent 非 live 会跳过投递），`dedupeInRecord: 1` 防重复（记录 = 可见投影 + 未消费 inbox）。
5. **服务面守卫 fail-soft**：`ctx.ruleEngine` / `ctx.get("ruleEngine")` 取不到或没有 `registerConsumer` → 告警一次 + 不注册，绝不抛到宿主（cordis 下 `inject` 已保证规则引擎就绪，该守卫只覆盖非 cordis 宿主与半装配的服务面）。
6. **文本自带副本**（不运行时读上游仓）：避免外部路径依赖；上游更新需人工同步并改 `tests` 关键词断言。
