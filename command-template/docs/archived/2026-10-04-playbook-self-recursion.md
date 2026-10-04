# `/playbook playbook` 无限递归（接取条目：`command-template/docs/BACKLOG.md`「`/playbook playbook` 触发无限递归」）

状态：进行中　　开启：2026-10-04　　关闭：—

## 计划改动文件清单（只改这些）

- `command-template/src/main.ts`（`#dispatch` 的入口名守卫；注册期冲突告警集合）
- `command-template/tests/template.test.ts`（不递归用例）
- `command-template/docs/DESIGN.md`（§3 分派口径）
- `command-template/README.md`（`reservedNames` 行补「入口名恒保留」）
- `command-template/docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研（已核）

- 递归链：`run(templateName)` 见 `templateName === ENTRY_COMMAND` 即转 `#dispatch(invocation)`；而 `#dispatch` 只看「第一段是否保留子命令」，`ENTRY_COMMAND` 不在 `#reserved()` 里（缺省 = `ENTRY_SUBCOMMANDS`）→ 又把第一段当模板名调 `run("playbook")` → 死循环。实测 `RangeError: Maximum call stack size exceeded`（撤修复即复现，见证据）。
- 触发面：`/playbook playbook`（含带参数形态 `/playbook playbook x`）；现有用例只覆盖 `list` / 空输入 / `show` / `<模板>`。
- 相关但不改：模板名与保留名冲突时**只告警**（模板无法通过入口调用）——该行为本身是既定口径。

## 决策

1. **在 `#dispatch` 加入口名守卫**（`first === ENTRY_COMMAND` → 走管理面 = list），而不把 `ENTRY_COMMAND` 塞进 `#reserved()`：后者会改变 `reservedNames` 配置语义（配置只应覆盖**子命令名**），且用户一旦收窄 `reservedNames` 就会把递归放回来——守卫必须与配置无关。
1. **注册期冲突告警集合并入入口名**（`new Set([ENTRY_COMMAND, ...#reserved()])`，文案改「与入口 / 子命令名冲突」）：模板若真叫 `playbook` 则不可调用，按其既有口径在加载期留痕。
1. 不加「显式报错」分支：`/playbook playbook` 归管理面（列出模板）比报错更符合该输入的可预期语义，且与 `/playbook <未知模板>`（报「模板不存在」）区分开——入口名不是「未知模板」，是入口自己。

## 实现记录（2026-10-04）

- `main.ts`：`#dispatch` 的模板分支加 `first !== ENTRY_COMMAND` 条件（含注释：递归成因 + 与 `reservedNames` 无关）；`register()` 的冲突告警集合与文案同步。
- `tests/template.test.ts`：新增用例「入口分派：`/playbook playbook`（入口名当参数）走管理面——不递归、不爆栈」——三个断言：入口名裸形态 / 带参数形态都 success 且输出模板清单；`reservedNames: ["list"]` 收窄后仍 success（守卫不依赖配置）。
- 文档：`DESIGN.md` §3 分派口径补「或入口命令名本身」；`README.md` 的 `reservedNames` 行补「入口命令名本身恒保留」。

## 测试与证据（2026-10-04）

- `command-template`：`npm run check` ✓、`npm test` **26 例全绿**（既有 25 + 新增 1）。
- 反向验证（脚本式，未留痕）：`git stash push -- command-template/src/main.ts` → 新用例抛 `RangeError: Maximum call stack size exceeded`（1 例红，其余 25 绿）；恢复后 26 例全绿——**该用例确实复现原缺陷**。

## 子代理审阅

（本项改动面小（1 处守位 + 1 处告警集合 + 用例 + 两处文档口径），决策后与收尾前**合并一轮**；记录见下）

### 审阅（2026-10-04）

只读审阅（含 7 形态实测）结论「需修（仅 DESIGN.md 一行文档同步）」，该行已同批修：

1. **[次要] `DESIGN.md` §2 仍引旧日志文案**「模板名与子命令保留名冲突（无法调用）」且只提保留子命令 → 已改为新文案并说明告警集合 = 「入口命令名 + 保留子命令名」。
1. 已核无问题（原文摘录）：入口名递归彻底断开——实测 7 形态（裸 `playbook` / 带参数 / 多空格 / `playbook list` / `reservedNames` 收窄 `["list"]` 与清空 `[]` / 经 `apply()` 的真实 handler）全部落 list；`list` / `show` / `reload` / 空输入 / 未知模板均无回归；模板文件真叫 `playbook` 时注册期即告警且入口不可达（与保留名既有口径一致，不再爆栈）；告警集合只新增入口名、不误伤正常模板；`/playbook playbook`（list）与 `/playbook <未知模板>`（报错）的分工无口径冲突；新用例撤守卫即红（`RangeError`，25 绿 1 红），恢复后与审阅者备份的 sha1 一致。

## 收尾

- 条目从 `command-template/docs/BACKLOG.md` 移除。
- 本追踪文档移入 `command-template/docs/archived/`；本次变更合并为一次提交（`src/main.ts` + 测试 + `DESIGN.md` + `README.md` + BACKLOG + 归档文档），提交见 git 历史。
- 复跑记录：`command-template` `npm run check` ✓、`npm test` **26 例全绿**（含新增 1 例）；根 `npm run check` / `npm run build` 见收尾复跑。
