# @dsh-toolset/hash-edit

DSH（DeepSeek Harness）进程内插件：基于 `LINE:HASH` 锚点的文件编辑。读取文件得到每行的内容哈希锚点，编辑时用锚点定位行；文件在读取之后被改动则锚点失效（stale），整批拒绝、文件字节不变。

## 能力

注册两个模型侧工具。

### `hash_read`

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `path` | 是 | — | 绝对路径，或相对 `Config.root` / 宿主 cwd 解析 |
| `offset` | 否 | 1 | 起始行号（1 基） |
| `limit` | 否 | 200 | 返回行数上限 |

返回 `{ ok, path, line_count, file_hash, hashlines }`：`hashlines` 为 `[offset, offset+limit)` 窗口内的 `{ line, hash, text }`（`text` 已去行尾符）；`file_hash` 为文件内容的 sha256 完整 64 位 hex，用于判断文件是否整体变化。文件不存在、非 UTF-8、IO 失败返回 `not_found` / `not_utf8` / `io_error` 结构化错误。

### `hash_edit`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `path` | 是 | 目标文件路径 |
| `edits` | 是 | 非空指令数组，每条恰好一个变体键；行号均锚定同一次 `hash_read` 的原始内容 |

| 指令 | 语义 | `new_text` 口径 |
| --- | --- | --- |
| `set_line` | 替换锚点行 | 含 `\n` 展开为多行；空串 = 该行变空行（不删除） |
| `replace_lines` | 替换闭区间 `[start_anchor, end_anchor]` | 空串 = 纯删除，不留空行 |
| `insert_after` | 锚点行之后插入 | 空串 = 无操作；锚末行 = 追加到文件尾 |
| `delete_line` | 删除锚点行 | — |

成功返回 `{ ok, content, line_count, file_hash, hashlines, applied }`：`content` 为编辑后全文，`hashlines` 为新锚点可直接用于下一轮编辑，`applied` 记录实际应用的指令（类型、锚点行号、产出行数）。指令按锚点行号升序应用；`new_text` 尾随 `\n` 会产生一个显式空行。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `root` | `process.cwd()` | 相对路径解析基准目录 |

bundle 契约：`name` / `inject: ["tools"]` / `Config` / `apply`；`ctx.tools` 不可用时仅告警并跳过注册。

## 使用示例

```jsonc
// 1) 取锚点
{ "path": "src/app.ts", "offset": 10, "limit": 20 }

// 2) 提交编辑（一次多条，原子应用）
{
  "path": "src/app.ts",
  "edits": [
    { "set_line": { "anchor": "12:a1b2c3d4", "new_text": "const x = 1;" } },
    { "replace_lines": { "start_anchor": "14:6c1e9d3f", "end_anchor": "16:ffff0011", "new_text": "" } },
    { "insert_after": { "anchor": "20:00aa11bb", "new_text": "export { x };" } },
    { "delete_line": { "anchor": "30:deadbeef" } }
  ]
}
```

任一锚点失效（stale）时返回 `{ ok: false, code: "stale_anchors", details: [...] }`，`details` 列出全部失效锚点（含 `expected` 与 `actual`），据此重新 `hash_read` 取锚点后重试。

锚点可离线复算：行文本为 `abc` 时 `printf 'abc' | sha256sum` 输出 `ba7816bf...`，取前 8 位即该行锚点的哈希部分。

## 边界与限制

- 锚点格式：`LINE:HASH`，`LINE` 为 1 基行号，`HASH` 为 `sha256(行文本)` 的前 8 位小写 hex（接受大写，归一化）。空行为 `sha256("")` 前缀 `e3b0c442`。
- 与 readseek 的 `LINE:HASH` 语法同形但哈希口径不同（本包为 8 位 sha256 前缀），两者锚点不可互换；编辑前须用 `hash_read`（或纯函数 `hashlines()`）重新取锚点。
- 校验顺序（全部针对读取时的原始快照，先于任何写入）：`malformed`（指令形状/锚点语法/`end < start`/空 `edits`）→ `out_of_range`（行号超出文件行数）→ `stale_anchors`（行内容哈希不符）→ `overlapping_edits`（同一行被两条指令占用）。任一失败即整批拒绝，文件字节不变，无临时文件残留。
- 写入语义：校验全部通过后写盘，同目录临时文件 + `rename` 原子替换；继承原文件权限位（含执行位）；UTF-8 strict（非法字节拒绝）；换行符跟随原文件（CRLF 保持 CRLF，尾随换行保留）；空文件视为 1 行，可 `set_line` / `delete_line`。
- 仅 4 类行级指令，无符号级编辑（如按符号替换）能力。

## 测试

```sh
npm run check   # tsc --noEmit（strict + noUncheckedIndexedAccess）
npm run build   # 编译到 dist/
npm run test    # node --test（43 例：hashline / edit / fs）
npm run demo    # 冒烟：多锚点编辑 + stale 拒绝，输出 SMOKE_PASS
```
