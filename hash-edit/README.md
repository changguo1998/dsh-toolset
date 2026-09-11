# hash-edit

DSH 进程内集成插件：基于 `LINE:HASH` 锚点的文件编辑。读取文件得到每行的内容哈希锚点，编辑时用锚点定位行；若文件内容在读取之后被修改（锚点失效/stale），整批拒绝、文件字节保持不变。

与 `readseek` 的 `LINE:HASH` 锚点语法兼容（`^(\d+):([0-9a-f]{6,})$`），但**哈希口径独立**（见下文），两者锚点**不可互换**。

## 工具

### `hash_read`

```json
{ "path": "src/app.ts", "offset": 10, "limit": 20 }
```

- `offset`：起始行号（1 基，默认 1）
- `limit`：窗口行数（默认整文件）

返回：

```json
{
  "ok": true,
  "path": "src/app.ts",
  "line_count": 42,
  "file_hash": "<sha256 64 hex>",
  "hashlines": [{ "line": 10, "hash": "a1b2c3d4", "text": "..." }]
}
```

- `hashlines` 为 `[offset, offset+limit)` 窗口的行：`{line, hash, text}`
- `file_hash` 为整文件字节 sha256 前缀（64 hex），用于快速判断文件是否整体变化
- 非 UTF-8 / 文件不存在 → 结构化错误（`not_utf8` / `not_found`），不抛原生异常

### `hash_edit`

```json
{
  "path": "src/app.ts",
  "edits": [
    { "set_line": { "anchor": "12:a1b2c3d4", "new_text": "..." } },
    { "replace_lines": { "start_anchor": "12:a1b2c3d4", "end_anchor": "15:ffff0011", "new_text": "..." } },
    { "insert_after": { "anchor": "20:00aa11bb", "new_text": "..." } },
    { "delete_line": { "anchor": "30:deadbeef" } }
  ]
}
```

一次提交多条指令，原子应用（任一锚点失效则整批拒绝，文件不变）。

| 指令 | 语义 | `new_text` 说明 |
| --- | --- | --- |
| `set_line` | 替换锚点行 | 含 `\n` 则展开为多行；空串 = 该行变空行（不删除） |
| `replace_lines` | 替换闭区间 `[start, end]` | 空串 = 纯删除（不留空行） |
| `insert_after` | 锚点行后插入 | 空串 = no-op；锚末行 = 追加到文件尾 |
| `delete_line` | 删除锚点行 | — |

- 同一 `path` 的批量指令按**锚点行号升序**应用
- `new_text` 尾随 `\n` 会产生一个显式空行（与 readseek 口径一致）
- 成功返回 `ok: true` + 编辑后完整内容 + 新锚点列表（可直接用于下一轮编辑）

## 锚点语法与哈希口径

- 锚点格式：`LINE:HASH`，`LINE` 为 1 基行号，`HASH` 为小写 hex（接受大写，归一化）
- **hash-edit 的 `HASH` 是 `sha256(行文本)` 的前 8 位**：
  - 行文本 = 去掉行尾换行符的行内容（CRLF 文件中 `\r` 不入哈希）
  - 空行 = `sha256("")` 前缀 = `e3b0c442`
  - 零运行时依赖（`node:crypto`），可离线验证：`printf 'abc' | sha256sum` → `ba7816bf...`
- **readseek 的 `LINE:HASH` 是其自有 24-bit 哈希（6 位 hex，闭源算法）**。语法兼容但哈希口径不同：
  - 从 `readSeek_digest` 读到的 `2:fe705f` **不能**直接用于 `hash_edit`
  - 编辑前必须用 `hash_read`（或本插件的 `hashlines()`）重新取锚点
- 行拆分口径：`\n` 与 `\r\n` 均为换行；孤立 `\r` 不是换行符；尾随换行不产生独立空行

## 校验顺序（全部针对读取时的原始快照，先于任何写入）

1. `malformed` — 指令形状错误（多键/未知键）、锚点语法非法、`end < start`、空 `edits`
1. `out_of_range` — 锚点行号超出文件行数
1. `stale_anchors` — 行内容哈希不符；**列出全部**失效锚点，每条含 `expected`（锚点期望哈希）与 `actual`（当前实际哈希）
1. `overlapping_edits` — 同一行被两条指令占用（如 `set_line` + `insert_after` 同一行）

任何一项失败 → 整批拒绝，文件字节不变，无临时文件残留。

## 写入语义

- **原子性**：校验全部通过后才写盘；同目录临时文件 + `rename`（同文件系统原子操作）
- **权限保留**：继承原文件 mode（含执行位）
- **编码**：UTF-8 strict（非法字节拒绝，`not_utf8`）；换行符口径跟随原文件（CRLF 文件保持 CRLF）
- **空文件**：视为 1 行（空行），可 `set_line` / `delete_line`
- 路径：绝对路径，或相对路径按 `root` 参数（DSH 会话 cwd）解析

## 与 readseek / pi edit 工具的关系

| | hash-edit | pi `edit`（readseek 锚点） |
| --- | --- | --- |
| 锚点哈希 | `sha256` 前 8 hex（本插件自算） | readseek 自有 24-bit（6 hex） |
| 锚点来源 | `hash_read` / `hashlines()` | `readSeek_digest` |
| stale 处理 | 整批拒绝 + 列出全部失效锚点（expected/actual） | readseek 内部校验 |
| 批量 | 一次提交 N 条，原子 | 多条 edit 逐个应用 |

两者可共存：hash-edit 提供**可审计的哈希口径**（任意环境可离线复算行哈希），readseek 提供带 LSP/AST 能力的 IDE 式编辑。

## 开发

```sh
npm run check   # tsc --noEmit（strict + noUncheckedIndexedAccess）
npm run test    # node --test（tests/*.test.ts，node --experimental-transform-types）
npm run build   # 编译到 dist/
npm run demo    # 冒烟：多锚点编辑 + stale 拒绝，输出 SMOKE_PASS
```

结构：

- `src/hashline.ts` — 行拆分、行哈希、锚点解析/格式化（纯函数）
- `src/edit.ts` — `applyAnchoredEdits`：纯内容级批量编辑（校验 + 应用）
- `src/fs.ts` — 文件级读写封装（`node:fs/promises`，原子写）
- `src/main.ts` — DSH bundle 入口：注册 `hash_read` / `hash_edit` 工具
- `tests/` — `node:test` 单测（hashline / edit / fs）
- `demo/main.ts` — 冒烟脚本（临时目录全流程）

## DSH 集成

- `cordis.patch.yml`：`inject: [tools]`，入口 `./dist/src/main.js`
- 遵循 `DSH-CTX-API.md` 的 `ctx.tools.register(name, tool)` 契约（结构性访问，不依赖 `dsh` 包）
- 非集成插件：无 `ctx.ui` / `ctx.session` 依赖，无需真实 DSH 会话即可运行 demo 与单测

## 已知差异（相对 readseek / pi）

1. **哈希口径**：sha256-8 前缀 vs readseek 24-bit（锚点不可互换，见上）
1. **批量原子性**：readseek 的多条 edit 逐条应用（前条成功后文件已变，后条锚点可能失效）；hash-edit 整批先校验后应用
1. **指令集**：hash-edit 仅 4 类行级指令；readseek 另有 `replace_symbol` 等符号级能力
