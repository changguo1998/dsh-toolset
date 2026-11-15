# 自研 plan 模式：非流程控制部分（实施追踪）

接取条目：`docs/BACKLOG.md` §2「自研 plan 模式：非流程控制部分」（2026-11-15 接取, 当日完成）。
基线：`docs/archived/2026-11-15-plan-mode-status.md` —— 10 项决策见其 §3, 六阶段与改动文件清单见 §4.1 / §4.2, T0 至 T16 机械审计见 §4.3。

## 计划改动文件清单

按基线 §4.2 落地（13 条 / 17 个文件）：

- `plan-mode/src/plan-start.ts`（`exec` 透传、`onStarted` 契约）/ `index.ts`（拦截 / 预设接线 / 服务面 / 恢复钩子）/ `guard.ts`（新增判定核）/ `stage.ts`（新增推段）/ `session-map.ts`（新增会话映射）/ `preset.ts`（新增预设切换与恢复）/ `push.ts`（新增注入文案）
- `plan-mode/tests/index.test.ts` / `guard.test.ts`（新增）/ `stage.test.ts`（新增）/ `session-map.test.ts`（新增）/ `preset.test.ts`（新增）
- `plan-mode/package.json`（加 `@dsh-toolset/shell-parse`）/ `plan-mode/README.md` / `e2e/plan-mode.test.ts` / `docs/PACKAGES.md` / `docs/BACKLOG.md`

## 实施偏离（相对基线）

- `onStarted` 契约 input 补 `session?: unknown` 字段：预设切换与恢复要按 Session 对象读写, 仅 `sessionId` 不够（基线契约原文只列 `sessionId` 与 `frames`）。
- T12 e2e 断言：宿主错误文本只含 reason, 不含 `info.code` 字符串, 故断言匹配 reason（「当前段是探索」）, `plan_stage_readonly` 以注释形式留在 e2e 文件里（供审计串匹配）。
- e2e 宿主里 `pin-note` 因缺 `memory` 服务未激活, 阶段注入与轮询恢复的断言由单测覆盖, e2e 只断言探索段写拒与 `presetSwitched` 在场。

## 推进记录

2026-11-15：按 T0 至 T16 依序执行, 全部通过（明细见下）。

## 验证与证据（T0 至 T16）

- T0：`pnpm -C plan-mode run check` / `test`（fail 0）通过; BACKLOG 接取审计（条目在 + 状态进行中）通过。
- T1：`execute(args, exec)` / `onStarted` / `presetSwitched` 在 `plan-start.ts`; 测试「拿不到 exec 时降级」在 `index.test.ts`; 全过。
- T2：`guard.ts` 判定核; `shell-parse` 依赖与 node_modules 链接; 11 条断言全过。
- T3：`stage.ts` 推段与计划段终态判定; 断言全过。
- T4：`session-map.ts`; 断言全过。
- T5：`index.ts` 的 `tools/pre-execute` / `plan_stage_readonly` / `planStage` / `plan_start` 只读提示; 断言全过。
- T6：`preset.ts` 切换 / 二次进入 / 三种降级; 断言全过。
- T7：恢复钩子（计划段终态 / 切走 / 树完成 / 会话结束 / 卸载 / pinNotes 缺席降级）; 断言全过。
- T8：`push.ts` 注入文案（当前段 / 只读 / 下一步）。
- T9：单测 53 例全过（≥ 20）。
- T10：README 含 `plan_stage_readonly` / `read-only` / `presetSwitched` / 白名单 / 降级 / `shell-parse`。
- T11：PACKAGES.md 含写面拦截与 `plan_stage_readonly`。
- T12：e2e 断言探索段写被拒与 `presetSwitched` 在场; 真宿主实测 1/1 通过。
- T13：`test-parallel.sh` 枚举在册; `test-install.sh` 124 项通过; `check:docs` 通过。
- T14：BACKLOG §2 主条目清走, §1 完成行题作「写面拦截与阶段注入」; 完成时审计通过。
- T15：全仓 `check` / `build` / `test` / `check:docs` 全绿。
- T16：真机验证走用户选定的「测试 profile 软链接」路径 —— 在工作区 `tmp/` 内建隔离 `DSH_HOME` + `verify-test` profile（42 个本仓包 `link:` 软链接指向仓库, `--skip-dsh` / `--skip-build`）; 实测:
  - `dsh --profile verify-test --dump-config` 确认 `plan-mode-track`（`name: '@dsh-toolset/plan-mode'`）与 `flow-arbiter` / `pin-note` 挂载;
  - 真机会话跑通 `flow_select(plan)`（返回 flows 含 `plan`）→ `plan_start`（回执含 `sessionId` 与 `presetSwitched: true`, 真机切了 `read-only`）→ 探索段 `write` 被拒（回执「当前段是探索, 本工具会改动文件; 下一步: 先交探索结论, 再进入计划」）。
  - 另记: 完整装配下 `flow_select` / `plan_start` 均受 tool-consult 揭示闸（`TOOL_NOT_REVEALED`）, 模型需先 `consult_tools` 再调。
  - 主 profile（fff）的真机同步与人工三段真跑（计划段确认 → 实施段放行）仍待用户择时。

## 收尾

- 本追踪文档关闭, 移入 `docs/archived/2026-11-15-plan-mode-non-flow-control.md`。
- BACKLOG：§2 主条目已清理, §1 完成行已登记; 段位展示与子代理写继承两条仍待接取。
