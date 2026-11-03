# 统一界面名称

> 接取条目: `docs/BACKLOG.md` #1（2026-11-03 开工）
> 层级: 项目级（跨 TUI 文档、代码注释与用户可见字符串）

## 计划改动文件清单

| 范围 | 文件 | 作用 |
| --- | --- | --- |
| 检查器 | `dev/standard/index.mjs`、`dev/standard/rules.mjs` | 术语检查扩到 `.ts`（注释与字符串），让 `--rule term.interface` 能验收 0 命中 |
| TUI 文档 | `TUI/README.md`、`TUI/docs/DESIGN.md`、`TUI/docs/SPEC.md`、`TUI/docs/COMMANDS-SPEC.md`、`TUI/docs/design/NOTICE-LEVELS.md`、`TUI/docs/design/AUDIT-colors.md`、`TUI/docs/BACKLOG.md`、根 `README.zh.md` | 旧称按 `docs/GLOSSARY.md`「界面名称」与「需要替换」表替换 |
| 其他包文档 | `rule-engine/docs/DESIGN.md`、`rule-engine/docs/BACKLOG.md`、`security-guard/README.md`、`herdr-use/docs/BACKLOG.md` | 同上 |
| TUI 代码 | `TUI/src/**/*.ts`、`TUI/demo/*.ts` | 注释与命令描述 / help 文本里的旧称替换, 标识符与英文名不动 |
| TUI 测试 | `TUI/tests/**/*.ts` | 注释与断言里的旧称替换, 期望文本随显示文本同步 |
| 其他包代码 | `rule-engine/src`、`session-channel/src`、`ponytail/src` 等命中文件 | 同上, 只改注释与字符串 |
| `docs/BACKLOG.md` | 条目状态与本条关闭注记 | 流程记录 |

## 调研

- 存量分布（排除 `dist/` 与归档）: 现行 Markdown 191 处；`.ts` 里注释内 808 处、注释外（命令描述 / help 文本 / 测试断言 / demo 数据）295 处。
- 旧称 → 新称的对应关系来自 `docs/GLOSSARY.md`：`活动区` / `Turn 区` / `Turn 面板` → `回合区`；`对话区` / `历史区` / `历史 pane` / `对话 pane` → `会话区`；`系统状态区` / `系统状态栏` → `状态行`；`Tool 面板` / `工具面板` → `工具区`；`输入框` / `输入栏` → `输入区`；`底部提示` / `提示区` → `提示行`；`交互区` → `输入区 + 提示行`。
- 只有 `状态栏` 需要按位置分流: 左侧竖列 → `状态列`，底部横条 → `状态行`（`docs/GLOSSARY.md` 明确「不再单独用状态栏」）。
- 代码标识符与英文（`activity` / `dialogue` / `history` / `statBar` 等）一律不动；只有中文文案与注释里的界面名替换。
- 用户 2026-11-03 裁定扩范围: 连命令描述 / help 文本 / 测试断言一起改（不只是文档与注释），故测试期望文本随显示文本同改。

## 决策

1. 替换用一次性脚本按「长词优先」做词面替换（先 `系统状态区` / `工具面板区` / `对话历史区` / `活动 pane` / `Turn 面板` 等长词，后 `活动区` / `状态栏` 这类短词），避免短词先吃掉长词的一部分。
2. `状态栏` 不交给脚本盲替换: 脚本先把每一处连同所在行导出到清单，按上下文（左侧竖列 vs 底部横条）分批替换，替换后回扫确认无遗漏。
3. `交互区` 按 `输入区 + 提示行` 展开；个别句子展开后读不通的，按所在句子的实际所指改为单指（`输入区` 或 `提示行`），逐条记在实现记录里。
4. 测试断言与 demo 数据里的旧称随显示文本同改；断言之外不含界面名的用例不动。
5. 验收: `node dev/standard/index.mjs --rule term.interface` 为 0；`pnpm -C TUI run check` / `test` / `demo:build -- --smoke` 通过；全仓 `check` / `test` 退出 0；`format` 幂等。

## 实现记录

- 检查器扩面: `dev/standard/index.mjs` 对 `.ts` 逐行跑界面旧称规则（注释、命令描述、help 文本、测试断言都算现行文案），新增 `onlyInterface` 过滤；`term.interface` 的严重度从 `warn` 改回 `error`（界面旧称清零后由它守门）。
- 替换量: 165 个文件、约 1300 处。词面替换按长词优先（`系统状态区` / `Tool 面板` / `对话历史区` / `活动 pane` / `Turn 面板` 先于 `活动区` / `状态栏`），带「原名 / 旧称 / 历史对照」的行跳过。
- `状态栏` 逐条按位置分流: 167 处先全量落 `状态行`（绝大多数指底部横条），再把 `goal` / `todo` / `jobs` 徽标相关的 4 处（`demo/main.ts:408,486`、`demo/mockAdapter.ts:306,336`）改回 `状态列`——它们在状态列块里渲染。`layout` 几何、`layout/status-line.ts`、`frame-build.ts` 的框线与分隔行口径全是底部横条，保持 `状态行`。
- `交互区` 33 处: 按 `输入区 + 提示行` 展开后逐条消除冗余表述（`geometry.ts:47,53,275` 的几何注释与公式、`config.ts:4,28`、`TUI/README.md:45`、`SPEC.md:75,84`、`COMMANDS-SPEC.md:41`、`layout4.test.ts:196,199`、`config.test.ts:99`、`JobsPanel.ts:3`、`top-region.ts:396`），公式行改为 `rows − 状态区 − 输入区 − 提示行 − 分隔行`。
- 用户可见文案同改: `/collapse` `/verbose` 描述、help 键位表、demo 场景数据与断言里的旧称一并更新；demo 冒烟帧里出现 `● 状态列 goal 徽标`，与断言一致。
- 文档: `TUI/README.md` / `TUI/docs/DESIGN.md` / `TUI/docs/SPEC.md` / `TUI/docs/COMMANDS-SPEC.md` / `TUI/docs/design/*` / `rule-engine` / `security-guard` / `herdr-use` / 根 `README.zh.md` 同批替换；`docs/GLOSSARY.md` 与 `AGENTS.md` 的「统一替换待办」改为「已统一, 由 `term.interface` 规则守护」。

## 测试与证据

- `node dev/standard/index.mjs --rule term.interface`: 命中 0（规则已为错误档）。
- `pnpm run check:docs`: 退出 0（错误 0 / 警告 648，警告只剩注释路径存量）。
- `pnpm -C TUI run check` 退出 0；`pnpm -C TUI run test`: 1829 例全过；`pnpm -C TUI run demo:build -- --smoke`: `SMOKE_OK`。
- 全仓 `pnpm run check` / `pnpm run build` / `pnpm run test` 退出 0（34 包，各包 fail 0）。
- `format` 对 165 个改动文件执行一次，无残留重排。

## 偏差

1. `状态栏` 的二分是人工判断: 除 4 处 `状态列` 外全部落 `状态行`；判断依据是所在句子的主语（底部横条的 model/ctx/cache/policy/cwd/几何 vs 状态列的 goal/todo/jobs 徽标），未逐条找原作者确认。
2. `交互区` 展开后在公式与几何注释里出现 `输入区 + 提示行` 连写，已逐条改写为「底部两行（输入区 + 提示行）」或直接写 `输入区 − 提示行` 的分项式；个别句子（`hints.ts` / `frame-build.ts`）保留连写，因为上下句已在讲这两个区域。
3. 检查器本身随本条一起改了严重度（`term.interface` 警告 → 错误），属条目 #1「用 check:docs 验收 0 命中」的落地动作，记在此处。
