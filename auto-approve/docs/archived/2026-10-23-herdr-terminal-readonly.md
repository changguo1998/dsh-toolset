# auto-approve：herdr-use 读类工具是否纳入只读类

状态：已裁定（2026-10-23，选项 b：不纳入，保持保守口径；本次只改文档，代码未动）　　开启：2026-10-23　　关闭：2026-10-23
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`herdr-use` 终端面重构后，读类工具是 `herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait`，写类是 `herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run`。本包只读类缺省清单 `DEFAULT_READONLY_TOOLS` 不含任何 herdr 工具，自动裁定不会把这四个读类工具判为只读，因而也不会自动放行。目标是把这一口径定下来并落到契约。

- 契约来源：`docs/implementation/2026-10-23-herdr-use-terminal-surface.md`（2026-10-23 定稿，commit `c061922`）§「工具契约（10 个）」的读 / 写分组。

## 核对（2026-10-23，只读确认）

- 缺省清单 `auto-approve/src/config.ts:12-22` 共 9 项：`read` / `read_image` / `grep` / `glob` / `hash_read` / `fs_digest` / `code_map` / `ast_query` / `md_map`。**不含** `bash`，也**不含**十个 herdr 工具中的任何一个。
- 归一：`auto-approve/src/config.ts:440` 为 `asStringArray(raw.readonlyTools) ?? DEFAULT_READONLY_TOOLS`——用户显式给了 `readonlyTools` 就**整体替换**内置清单（空数组即整层关闭），不做并集。
- 判定：`auto-approve/src/rules.ts:76` 只按工具名 `includes` 匹配，命中即 `allowed-once`，`ruleId` 形如 `readonly:<工具名>`。
- 缺省清单的测试断言落点：
  - `auto-approve/tests/config.test.ts:15`：缺省 `readonlyTools` 与 `DEFAULT_READONLY_TOOLS` 做 `deepEqual`（跟常量走，清单加项不会破）。
  - `auto-approve/tests/bundle.test.ts:504`：`status.readonlyTools === 9`（**硬编码数量，清单加项必改这一行**）。
  - `auto-approve/tests/command.test.ts:45`：命令面状态快照夹具里的 `readonlyTools: 9`，与清单内容无关，只需与上一处同步数量。
  - `auto-approve/tests/rules.test.ts:52-58`：只断言 `read` / `grep` 命中、`bash` 不含，不涉及 herdr 工具。
- 结论：现状与本文建文时一致——四个读类工具事实上按「非只读」处理，保持裁定不需改代码。

## 裁定

**选项 b：`herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` 不纳入 `DEFAULT_READONLY_TOOLS`，保持「一律按未登记只读类处理」。**

理由：

1. `herdr_read` / `herdr_wait` 取的是终端屏与输出流原文，内容可能是别人跑过的命令回显，含凭据、令牌、隐私数据；是否敏感只有人能判，机器判不了。
2. 本包只读类的口径是「无副作用，且放行不需要人看内容」。终端读类满足前者（不改终端状态），不满足后者。
3. 同族一致：`herdr_list` / `herdr_info` 只出元数据，但与读屏同族；只把这两个免确认会造成「同族工具一部分要确认、一部分不要」的认知成本，而收益只是元数据级确认噪音的降低。

## 被拒选项与代价

- 选项 a（四个读类加入清单）：收益是高频读屏 / 探活不再逐次弹面板；代价是把「读终端屏」判为无副作用，凭据与隐私内容经自动放行进入模型上下文与审计，且与本包「`bash` 不进清单」的保守方向相反。
- 选项 b 的代价（已接受）：读屏、探活、等输出每次走人工面板，交互式调试时确认噪音高。
- 噪音的缓解不在本包：用户可在自己 profile 里显式配 `readonlyTools` 覆盖（见「生效范围」）；若要机器侧缓解，属另一条目（按工具参数或来源收窄），不在本次裁定内。

## 生效范围

- 只作用于**未在用户配置里覆盖 `readonlyTools`** 的会话：该字段是整体替换，用户配了就按用户的清单。
- 六个写类工具本来就不在清单，本次不变：`herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run` 仍逐次确认。`herdr-use` 对 `read-only` 会话另有自己的沙箱闸（拒六个写类、放行四个读类），与本包审批链是两层，互不替代。
- 本次不改 `src/`、不改 `tests/`、不新增配置项。

## 未来若要改的入口

1. `auto-approve/src/config.ts:12-22`：`DEFAULT_READONLY_TOOLS` 增删工具名。
2. `auto-approve/tests/bundle.test.ts:504`：`status.readonlyTools` 的硬编码数量（现值 9）。
3. `auto-approve/tests/command.test.ts:45`：状态快照夹具里的同一数量。
4. `auto-approve/README.md`：裁定顺序表第 3 行（只读类）的说明格。
5. 改之前先确认宿主是否真的会为 `herdr_*` 发起审批请求（本包只在审批链上裁定；`herdr-use` 的自有闸不等价于审批请求）。

## 验收

- `cd auto-approve && npm run check && npm test` 全绿（本次未改代码，跑一遍证明没碰坏）。
- 文档侧：本文件含结论、被拒选项与代价、生效范围、未来入口；`README.md` 裁定顺序表第 3 行有一句口径。

## 未做 / 存疑

- 真机未观察到 `herdr_*` 的审批请求（2026-10-23 连续调用 `herdr_create` / `run` / `read` / `info` / `label` / `close` 全程无审批面板）；裁定只表达「若收到，按非只读处理」，不改变「未收到就不裁定」。证据见 `docs/archived/2026-10-23-real-machine-verification.md` #8。
- 本文件已按标准流程关闭并移入 `docs/archived/`（2026-10-23）。
