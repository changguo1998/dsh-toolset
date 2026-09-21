#!/usr/bin/env sh
# 全部子包测试并行入口（根 `npm test` 委托本脚本）。
#
# 调度：优先 GNU parallel（-j 并发，默认核数，TEST_JOBS 可覆盖），缺失时退回
# xargs -P（TEST_RUNNER=auto|parallel|xargs 可强制）。单包执行单元
# scripts/test-one.sh 写 <logdir>/<pkg>.{log,exit,ms}，全部结束后统一聚合。
#
# 为什么并行：11 包子包测试各自独立（node --test 各自进程），串行 `&&` 只是顺序
# 等待；并行后墙钟 ≈ 最慢包（当前 TUI ~8.6s）。
# 输出：每包 OK/FAIL + 耗时 + pass/fail 计数；FAIL 的包附日志。
# 退出码：任一包失败即非零（不 fail-fast——等全部跑完，便于一次看到所有失败）。
#
# 用法：scripts/test-parallel.sh [包名...]   # 缺省 = 全部子包
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
default_pkgs="TUI herdr-integration knowledge-base task-engine ast-tools fs-digest goal-contract hash-edit metric-loop output-compress security-guard code-map"
pkgs="${*:-$default_pkgs}"
logbase="${TMPDIR:-/tmp}/dsh-test-parallel.$$"
mkdir -p "$logbase"

# 只跑存在的包；不存在的提示 SKIP
runpkgs=""
for p in $pkgs; do
  if [ -d "$root/$p" ]; then
    runpkgs="$runpkgs $p"
  else
    echo "SKIP  $p（目录不存在）"
  fi
done
[ -n "$runpkgs" ] || { rm -rf "$logbase"; exit 1; }

jobs="${TEST_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
runner="${TEST_RUNNER:-auto}"
if { [ "$runner" = "parallel" ] || [ "$runner" = "auto" ]; } && command -v parallel >/dev/null 2>&1; then
  # GNU parallel：--will-cite 免除首次运行引用提示；作业在脚本 cwd（仓库根）下执行
  # shellcheck disable=SC2016
  printf '%s\n' $runpkgs | parallel -j "$jobs" --will-cite "scripts/test-one.sh {} $logbase"
elif { [ "$runner" = "xargs" ] || [ "$runner" = "auto" ]; } && command -v xargs >/dev/null 2>&1; then
  printf '%s\n' $runpkgs | xargs -P "$jobs" -I{} scripts/test-one.sh {} "$logbase"
else
  echo "parallel / xargs 均不可用，无法并行（请安装 GNU parallel）"
  rm -rf "$logbase"
  exit 1
fi

failpkgs=""
for p in $runpkgs; do
  safe=$(printf '%s' "$p" | tr '/.' '__')
  ms=$(cat "$logbase/$safe.ms" 2>/dev/null || echo 0)
  if [ "$(cat "$logbase/$safe.exit" 2>/dev/null || echo 1)" = "0" ]; then
    summary=$(grep -oE "pass [0-9]+|fail [0-9]+" "$logbase/$safe.log" 2>/dev/null | tr '\n' ' ')
    printf "OK   %-20s %4s ms   %s\n" "$p" "$ms" "$summary"
  else
    printf "FAIL %-20s %4s ms\n" "$p" "$ms"
    failpkgs="$failpkgs $p"
  fi
done
if [ -n "$failpkgs" ]; then
  echo "===== 失败包日志 ====="
  for p in $failpkgs; do
    safe=$(printf '%s' "$p" | tr '/.' '__')
    echo "----- $p -----"
    sed -n '1,160p' "$logbase/$safe.log"
  done
fi
rm -rf "$logbase"
[ -z "$failpkgs" ]
