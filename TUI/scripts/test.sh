#!/usr/bin/env sh
# TUI 本地测试快捷入口（根 `npm run test:tui -- <过滤> [文件]` 与 TUI 的 `npm test` 都转发至此）。
#
# 用法：
#   scripts/test.sh                     # TUI 全量测试（即 TUI 的 `npm test`）
#   scripts/test.sh <name>              # 按测试名过滤（--test-name-pattern 正则，跨全部文件）
#   scripts/test.sh <file.test.ts>      # 指定单个测试文件（裸文件名自动补 tests/ 前缀）
#   scripts/test.sh <name> <file>       # 单文件内按名过滤
#
# 为什么用包装脚本：node --test 的 --test-name-pattern 必须放在文件参数 **之前**，
# 而 `npm run x -- <arg>` 只会把参数追加到命令末尾（放末尾会被当成文件路径、过滤失效）。
# 本脚本把「含 .test.ts 的参数当作文件、其余当作名字正则」安插到正确位置。
#
# 不要加 --test-force-exit（BACKLOG 3.5.3 / 3.5.4 实测）：node v24.16.0 在并行文件模式下
# force-exit 会**静默丢尾部结果**（本套件报数在 1006~1091 间浮动、真值 1115，0 失败——
# 即「全绿」可能是漏跑出来的；输出重定向到文件时同样丢，故根 `npm test` 汇总也会偏低）。
# 整轮挂死的真因是**测试侧句柄泄漏**：tests/focus-cursor.test.ts 建 renderer 后不 close，
# 而 renderer 按设计持有 stdin（stdio.resume()）→ 该文件子进程永不退出，父 runner 卡死。
# 已在测试侧用 `t.after(() => renderer.close())` 根治，故此处保持默认并发 + 自然退出
# （全量约 2~7s，用例数与直接 node --test 一致）。
set -e
cd "$(dirname "$0")/.."
name=""
file="tests/*.test.ts"
for a in "$@"; do
    case "$a" in
        *.test.ts)
            # 文件参数：相对/绝对路径原样使用；裸文件名（`foo.test.ts`）在 tests/ 下解析
            if [ -f "$a" ]; then file="$a"; elif [ -f "tests/$a" ]; then file="tests/$a"; else file="$a"; fi
            ;;
        *) name="$a" ;;
    esac
done
if [ -n "$name" ]; then
    exec node --experimental-transform-types --test --test-name-pattern="$name" "$file"
else
    exec node --experimental-transform-types --test "$file"
fi
