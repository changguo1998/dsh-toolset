#!/usr/bin/env sh
# TUI 本地测试快捷入口（根目录 `npm run test:tui -- <过滤> [文件]` 转发至此）。
#
# 用法：
#   scripts/test.sh                     # TUI 全量测试（等价 npm --prefix TUI test）
#   scripts/test.sh <name>              # 按测试名过滤（--test-name-pattern 正则，跨全部文件）
#   scripts/test.sh <file.test.ts>      # 指定单个测试文件
#   scripts/test.sh <name> <file>       # 单文件内按名过滤
#
# 为什么用包装脚本：node --test 的 --test-name-pattern 必须放在文件参数 **之前**，
# 而 `npm run x -- <arg>` 只会把参数追加到命令末尾（放末尾会被当成文件路径、过滤失效）。
# 本脚本把「含 .test.ts 的参数当作文件、其余当作名字正则」安插到正确位置。
set -e
cd "$(dirname "$0")/.."
name=""
file="tests/*.test.ts"
for a in "$@"; do
  case "$a" in
    *.test.ts) file="$a" ;;
    *) name="$a" ;;
  esac
done
if [ -n "$name" ]; then
  exec node --experimental-transform-types --test --test-name-pattern="$name" "$file"
else
  exec node --experimental-transform-types --test "$file"
fi
