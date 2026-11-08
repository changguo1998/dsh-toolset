# tool-consult 待办

> 职责：tool-consult 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与能力（见 `tool-consult/README.md`）
> 编号口径：扁平连续 `#n`，仅供阅读；每次整理时按当前顺序从 1 起重新编号
> 本文件只列未完成项；已完成项见 git 历史与 `tool-consult/docs/archived/`。

## 待办

- **修改默认揭示工具列表（`initialTools` 改为 9 个: 保留 `write`, 去掉 `edit` / `todo_write`, 加 `hash_read` / `hash_edit`）**〔进行中: 2026-11-08〕（登记日: 2026-11-08）

  - 现状: 缺省 `initialTools` 为 9 个核心工具（`bash` / `read` / `write` / `edit` / `glob` / `grep` / `todo_write` / `ask_user_question` / `skill`）, `README.md`「能力」与「配置」表同步声明「缺省只留 9 个核心工具」。
  - 期望: 缺省名单改为 `bash` / `read` / `glob` / `grep` / `ask_user_question` / `skill` / `hash_read` / `hash_edit` / `write`（**保留 `write`** 用于整文件创建 / 覆写, 去掉 `edit` / `todo_write`, 新增 `hash_read` / `hash_edit`; 工具名已核对 `hash-edit/src/index.ts:300,332`）; `README.md` 的描述与配置表 `initialTools` 缺省值同步; 配套缺省名单断言更新。
  - 优先级: 中。
  - 来源: 2026-11-08 用户提出（首次名单未含 `write`, 用户核实 write 无追加 / 局部替换能力后决定保留）。
