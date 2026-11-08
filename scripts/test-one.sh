#!/usr/bin/env sh
# 并行调度的单包执行单元：直接执行一个子包 `<脚本>` 的脚本体，输出写 <dir>/<safe>.log，
# 退出码与耗时分别写 <dir>/<safe>.exit、<dir>/<safe>.ms（safe = 包名经 `/`、`.`
# 替换后的安全文件名，避免嵌套路径；由 test-parallel.sh 的 GNU parallel / xargs
# 调度后统一聚合）。脚本由 TEST_SCRIPT 指定（缺省 test，也可为 check / build），
# 包内没有该脚本时记 SKIP。
#
# 不经 `pnpm run`：pnpm 会把 NODE_V8_COVERAGE 从脚本环境里清掉，覆盖率采集需要它
# 传进 node --test 的子进程。脚本体只用到 node / sh，PATH 补上本包 node_modules/.bin。
set -u
pkg="$1"
dir="$2"
script="${TEST_SCRIPT:-test}"
safe=$(printf '%s' "$pkg" | tr '/.' '__')
t0=$(date +%s%N)
body=$(node -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(p.scripts?.[process.argv[2]] ?? "")' "$pkg/package.json" "$script" 2> /dev/null)
if [ -z "$body" ]; then
    echo "SKIP $pkg（缺少 $script 脚本）" > "$dir/$safe.log"
    echo 0 > "$dir/$safe.exit"
    echo 0 > "$dir/$safe.ms"
    exit 0
fi
(
    cd "$pkg" || exit 1
    PATH="$PWD/node_modules/.bin:$PATH" sh -c "$body"
) > "$dir/$safe.log" 2>&1
code=$?
echo "$code" > "$dir/$safe.exit"
echo $((($(date +%s%N) - t0) / 1000000)) > "$dir/$safe.ms"
exit $code
