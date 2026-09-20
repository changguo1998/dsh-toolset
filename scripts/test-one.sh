#!/usr/bin/env sh
# 并行测试的单包执行单元：跑一个子包 `npm test`，输出写 <dir>/<safe>.log，
# 退出码与耗时分别写 <dir>/<safe>.exit、<dir>/<safe>.ms（safe = 包名经 `/`、`.`
# 替换后的安全文件名，避免嵌套路径；由 test-parallel.sh 的 GNU parallel / xargs
# 调度后统一聚合）。
set -u
pkg="$1"
dir="$2"
safe=$(printf '%s' "$pkg" | tr '/.' '__')
t0=$(date +%s%N)
npm --prefix "$pkg" run test >"$dir/$safe.log" 2>&1
code=$?
echo "$code" >"$dir/$safe.exit"
echo $(( ($(date +%s%N) - t0) / 1000000 )) >"$dir/$safe.ms"
exit $code
