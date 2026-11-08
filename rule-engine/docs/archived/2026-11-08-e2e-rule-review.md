# e2e 残留规则 `e2e-rule` 的核查与处置（接取条目：rule-engine/docs/BACKLOG.md「核查 `e2e-rule` 这条规则的用途, 决定保留 / 停用 / 删除」）

状态：已关闭　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 查清用户级规则库 `~/.dsh/rule-engine/rules.json` 里 `e2e-rule` 的来源与用途。
2. 按用户 2026-11-08 裁定的方案一处置：删除该规则, 并让 `rule-engine` 的缺省状态目录尊重 `DSH_HOME`, 使 e2e 不再写进真实 home。
3. 验证：该规则不再注入；e2e 用例写到临时 home；`rule-engine` 与全仓 check / build / test 全绿。

## 核查结论（2026-11-08）

`e2e-rule` 是 **e2e 用例残留**, 不是有意配置。证据链：

| 证据 | 内容 |
| --- | --- |
| 参数逐字一致 | `e2e/rule-engine.test.ts:10-14` 的 `rule_add` 给的正是 `id: "e2e-rule"` / `text: "端到端规则命中"` / `match.keywords: ["端到端"]`；运行时层里其余字段均为归一化缺省值, `description: null`、冷却与去重全 0 |
| 基线里没有 | `~/.dsh/profiles/fff/cordis.patch.yml:72-107` 的 `rules` 只有 `skill-autoload`（`enabled: false`）与 `resumed-notice`, 无该 id |
| 成因 | `rule-engine/src/persist.ts` 的 `defaultStateDir()` 直取 `os.homedir()`, 不读 `DSH_HOME`；而 e2e 夹具靠 `DSH_HOME` 隔离 home（`e2e/harness.ts:144`），故跑一次 e2e 就往真实 home 写一条 |
| 实测 | 2026-11-08 20:37 重跑 `e2e/rule-engine.test.ts`：用例通过, 日志 `stateDir=/home/guochang/.dsh/rule-engine`（临时 home 未生效）, 真实状态文件未被修改 |
| 排除「人工真机验证」 | 会话日志（`~/.dsh/sessions`）里搜不到该规则名, 与「由模型经 `rule_add` 工具在真实会话里登记」不符 |

现象解释：该规则的 `cooldownTurns` / `cooldownMs` / `dedupeInRecord` 全为 0, 且 `delivery: followup`, 故助手正文一出现「端到端」就立刻新起一回合注入, 同回合反复提到就反复触发。

## 计划改动文件清单

1. `rule-engine/src/persist.ts` — `defaultStateDir()` 优先级补 `DSH_HOME`（`RULE_ENGINE_STATE_DIR` > `<DSH_HOME>/rule-engine` > `~/.dsh/rule-engine`, 空值视同未设）。
2. `rule-engine/src/types.ts` / `rule-engine/src/index.ts` — `stateDir` 缺省口径注释同步。
3. `rule-engine/tests/persist.test.ts` — 补 `DSH_HOME` 优先级与空值回退用例。
4. `rule-engine/README.md` — 配置表 `stateDir` 口径。
5. `~/.dsh/rule-engine/rules.json`（项目外, 用户已授权）— 清空运行时规则层, 保留 `{version, state}` 外壳。
6. 本追踪文档 + `rule-engine/docs/BACKLOG.md`（条目状态与关闭）。
7. `metric-loop/docs/BACKLOG.md` — 途中发现的同类问题另登记（见下）。

## 途中发现（另登记, 不在本任务范围）

`metric-loop/src/index.ts:98-103` 的 `defaultStateDir()` 与旧 `rule-engine` 同型（`METRIC_LOOP_STATE_DIR` ?? `os.homedir()/.dsh/metric-loop`）, 同样忽略 `DSH_HOME`, 故 `e2e/metric-loop.test.ts` 也会往真实 home 写。已追加条目到 `metric-loop/docs/BACKLOG.md`。

## 验证（2026-11-08）

| 项 | 结果 |
| --- | --- |
| `pnpm -C rule-engine run check` | 通过 |
| `pnpm -C rule-engine run build` | 通过 |
| `pnpm -C rule-engine run test` | 177 例全绿（新增 1 例覆盖 `DSH_HOME` 优先级与空值回退） |
| `pnpm -C rule-engine run test:integration` | 13 例全绿 |
| `pnpm run check`（全仓 38 包） | 退出码 0 |
| 重跑 `e2e/rule-engine.test.ts` | 通过, 日志 `stateDir=<仓库>/tmp/e2e/rule-engine-XXXX/rule-engine` —— 临时 home 生效, 真实 home 未被写入 |
| 真实规则库 | `~/.dsh/rule-engine/rules.json` 已清空为 `rules: []`（外壳 `{version, state}` 保留） |

## 关闭说明

1. **生效时点**：规则层在插件启动时读盘, 故正在运行的 dsh 进程仍持有旧规则缓存; 需重启（主 profile 还要 `scripts/install.sh --profile fff --sync` 刷新快照）后「端到端」不再触发注入。
2. **处置结论**：方案一（删除规则 + 修 `DSH_HOME` 口径）已落地, 属「保留 / 停用 / 删除」中的**删除**档, 且堵住了「下次 e2e 又写回」的通路。
3. 处置涉及项目外文件 `~/.dsh/rule-engine/rules.json`, 用户 2026-11-08 已明确授权。
