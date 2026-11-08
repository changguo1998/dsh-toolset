# script-interpreter 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 待办

- **临时脚本改落会话目录 `.tmp`, 并补清理**

  - 现状: `src/run.ts:52,77` 用 `mkdtemp(join(<系统 tmpdir>, "<prefix>XXXXXX"))` 建临时目录, 脚本正文写成 `flag: "wx"` 0600 的文件; **跑完不清理**（源码里没有 `rm`）, 脚本正文（可能含模型拼进去的 token / 私密路径）会一直留到系统清理。路径不来自模型参数, 所以不属「需要走官方围栏」的范围, 但存放位置与清理都不合适。
  - 期望: ① 默认存放位置改为**会话目录下的 `.tmp`** —— 用 `sessionPaths` 服务的 `sessionDirFor` / `ensureSessionDir` 推导与会话目录, 不自己拼 `~/.dsh/sessions` 路径; 系统临时区只作会话目录不可用时的兜底。② 执行结束（成功 / 失败 / 中止）都清掉本次临时文件。
  - 来源: 2026-11-08 项目级 `docs/implementation/2026-11-08-tool-write-path-fence.md` 的写面核查（决策 D4 拆出, 本任务只做文件编辑工具, 本项单独登记）。优先级: 低。

（完成项见 git 历史与 `script-interpreter/docs/archived/`; 关闭时把条目从这里移除。）
