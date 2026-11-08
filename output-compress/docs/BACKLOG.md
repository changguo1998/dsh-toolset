# output-compress 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 待办

- **会话目录缺失时用 `sessionPaths.ensureSessionDir` 新建, 不自己判存在**

  - 现状: `src/digest-db.ts:61-66` 在打开摘要库前只做 `existsSync(dirname(actual))`, 父目录不存在就告警 + `skipped.sessionDirMissing` 计数 + 跳过本次摘要。会话目录本该由宿主建好, 但宿主换版本或会话被外部清理时, 摘要会**静默丢失**且没有补救。
  - 期望: 改为调用 `sessionPaths` 服务的 `ensureSessionDir`（该包唯一写盘入口, 幂等 `mkdir -p` 0700）把目录建出来再打开库; 不在本包内自己拼 `~/.dsh/sessions` 路径、不自己 `mkdir`。仅当服务不可用时才回退到「告警 + 跳过」。
  - 来源: 2026-11-08 项目级 `docs/implementation/2026-11-08-tool-write-path-fence.md` 的写面核查（决策 D5 拆出, 本任务只做文件编辑工具, 本项单独登记）。优先级: 低。

（完成项见 git 历史与 `output-compress/docs/archived/`; 关闭时把条目从这里移除。）
