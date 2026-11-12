#!/usr/bin/env sh
# 全部子包的并行入口（根 `pnpm run test` / `check` / `build` 都委托本脚本）。
#
# 调度：优先 GNU parallel（-j 并发，默认核数，TEST_JOBS 可覆盖），缺失时退回
# xargs -P（TEST_RUNNER=auto|parallel|xargs 可强制）。单包执行单元
# scripts/test-one.sh 写 <logdir>/<pkg>.{log,exit,ms}，全部结束后统一聚合。
# 脚本由 TEST_SCRIPT 指定（缺省 test，可传 check / build / test:integration / test:e2e），
# 包内没有该脚本时记 SKIP。
#
# 构建依赖序（TEST_SCRIPT=build 时生效）：跨包源码依赖只有两处
# （code-map → ast-tools、md-map → md-logic，与 scripts/install.sh 同口径），
# 依赖方放到第二批，保证全新环境（dist/ 尚不存在）也能一次建成功。
#
# 为什么并行：39 个包各自独立（tsc / node --test 各自进程），串行 `&&` 只是顺序
# 等待；并行后墙钟 ≈ 最慢包（当前 test 的 TUI ~8.6s）。
# 输出：每包 OK/SKIP/FAIL + 耗时；test 系脚本再加 pass/fail 计数；FAIL 的包附日志。
# 退出码：任一包失败即非零（不 fail-fast——等全部跑完，便于一次看到所有失败）。
#
# 用法：scripts/test-parallel.sh [包名...]   # 缺省 = 全部子包
#      TEST_SCRIPT=check scripts/test-parallel.sh
#      TEST_SCRIPT=build scripts/test-parallel.sh
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
default_pkgs="clock-base shell-parse tool-surface TUI herdr-integration herdr-use memory-base task-engine ast-tools md-logic md-map fs-digest goal-contract hash-edit metric-loop output-compress security-guard code-map context-report rule-engine behavior-correction symbol-normalizer session-channel session-title-cutoff command-template ponytail md-table-check auto-approve background-daemon preference-analysis session-paths script-interpreter agent-group coagent tool-consult escalation-hint term-check pin-note flow-track"
pkgs="${*:-$default_pkgs}"
target="${TEST_SCRIPT:-test}"

warn() {
    printf 'WARN  %s\n' "$*" >&2
}

# 包清单双向校验：清单里有、目录没有；目录有、清单漏列。与 install.sh 同口径，只告警不退出。
for p in $default_pkgs; do
    [ -d "$root/$p" ] || warn "test-parallel.sh: default_pkgs 里的 $p 目录不存在（请同步清单）"
done
for manifest in "$root"/*/package.json; do
    [ -f "$manifest" ] || continue
    p=$(basename "$(dirname "$manifest")")
    case "$p" in
        node_modules | tmp | .*) continue ;;
    esac
    case " $default_pkgs " in
        *" $p "*) ;;
        *) warn "test-parallel.sh: 仓库包 $p 未列入 default_pkgs（请同步清单）" ;;
    esac
done

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
[ -n "$runpkgs" ] || {
    rm -rf "$logbase"
    exit 1
}

# 构建分两批：依赖 ast-tools / md-logic 的 code-map / md-map 后置（其余的脚本单批）。
batch1=""
batch2=""
if [ "$target" = "build" ]; then
    for p in $runpkgs; do
        case "$p" in
            code-map | md-map) batch2="$batch2 $p" ;;
            *) batch1="$batch1 $p" ;;
        esac
    done
else
    batch1="$runpkgs"
fi

jobs="${TEST_JOBS:-$(getconf _NPROCESSORS_ONLN 2> /dev/null || echo 4)}"
runner="${TEST_RUNNER:-auto}"

# dispatch <包列表>：parallel → xargs，两路都不可用时返回 2（调用方据此退出）；
# 有包失败时返回非零（parallel / xargs 的聚合语义），调用方**不据此提前退出**
# ——失败明细留给下面的汇总节打印。
dispatch() {
    batch="$1"
    [ -n "$batch" ] || return 0
    if { [ "$runner" = "parallel" ] || [ "$runner" = "auto" ]; } && command -v parallel > /dev/null 2>&1; then
        # GNU parallel：--will-cite 免除首次运行引用提示；作业在脚本 cwd（仓库根）下执行
        # shellcheck disable=SC2016
        printf '%s\n' $batch | parallel -j "$jobs" --will-cite "scripts/test-one.sh {} $logbase" || true
    elif { [ "$runner" = "xargs" ] || [ "$runner" = "auto" ]; } && command -v xargs > /dev/null 2>&1; then
        printf '%s\n' $batch | xargs -P "$jobs" -I{} scripts/test-one.sh {} "$logbase" || true
    else
        echo "parallel / xargs 均不可用，无法并行（请安装 GNU parallel）"
        return 2
    fi
    return 0
}

for batch in "$batch1" "$batch2"; do
    [ -n "$batch" ] || continue
    # shellcheck disable=SC2086
    dispatch "$batch" || {
        rm -rf "$logbase"
        exit 1
    }
done

failpkgs=""
for p in $runpkgs; do
    safe=$(printf '%s' "$p" | tr '/.' '__')
    ms=$(cat "$logbase/$safe.ms" 2> /dev/null || echo 0)
    if [ "$(cat "$logbase/$safe.exit" 2> /dev/null || echo 1)" = "0" ]; then
        if grep -q "^SKIP " "$logbase/$safe.log" 2> /dev/null; then
            printf "SKIP %-20s %4s ms\n" "$p" "$ms"
            continue
        fi
        # 只有 test 系的日志才有 node --test 的计数；check / build 只给耗时
        summary=""
        case "$target" in
            test*) summary=$(grep -oE "pass [0-9]+|fail [0-9]+" "$logbase/$safe.log" 2> /dev/null | tr '\n' ' ') ;;
        esac
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
