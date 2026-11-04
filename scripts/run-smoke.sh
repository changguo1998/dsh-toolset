#!/usr/bin/env sh
# 宿主联调 smoke 统一入口：把 DSH_HOME / TMPDIR / 日志全部收进仓库 `tmp/`，
# 使 4 个包的真机 smoke 在沙箱 / CI 里也能跑（不再写 `~/.dsh`）。
#
# 模型面：缺省走本机 tollgate 网关（`TOLLGATE_API_KEY=local`、provider `tollgate`、
# model `qwen38`）；可用 `TOLLGATE_API_KEY` / `TOLLGATE_BASE_URL` /
# `SMOKE_PROVIDER` / `SMOKE_MODEL` 覆盖，脚本会把它们传给各包的 smoke。
#
# 每个包的 profile 落在 `$DSH_HOME/profiles/dsh-toolset-<包>`，会话日志落在
# `$DSH_HOME/sessions`；包级日志写 `tmp/smoke-logs/<包>.log`，失败时打印尾部。
#
# 用法：scripts/run-smoke.sh [包名 ...]   # 缺省 = 4 个带真机 smoke 的包
# 退出码：任一包失败即非零（不 fail-fast，便于一次看到全部失败）。
set -u
root="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
cd "$root" || exit 1
default_pkgs="goal-contract metric-loop output-compress security-guard"
pkgs="${*:-$default_pkgs}"

dsh_home="$root/tmp/smoke-dsh-home"
log_dir="$root/tmp/smoke-logs"
mkdir -p "$dsh_home" "$log_dir" "$root/tmp/tmpdir" || exit 1

export DSH_HOME="$dsh_home"
export TMPDIR="$root/tmp/tmpdir"
export DSH_TELEMETRY_DISABLED=1
export TOLLGATE_API_KEY="${TOLLGATE_API_KEY:-local}"
export SMOKE_PROVIDER="${SMOKE_PROVIDER:-tollgate}"
export SMOKE_MODEL="${SMOKE_MODEL:-qwen38}"

printf 'DSH_HOME=%s\n模型=%s/%s（key=%s，baseURL=%s）\n' \
    "$DSH_HOME" "$SMOKE_PROVIDER" "$SMOKE_MODEL" "$TOLLGATE_API_KEY" \
    "${TOLLGATE_BASE_URL:-http://127.0.0.1:8787/v1}"

# 预建 profile，并把 pnpm 的 store / cache 指到仓库内：沙箱下 pnpm 写不了
# `~/.local/share/pnpm/store`（`dsh plugin add` 会因此失败），而 profile 自带的
# `pnpm-workspace.yaml` 恰是生效的配置位置。
for pkg in $pkgs; do
    [ -d "$root/$pkg" ] || continue
    prof_dir="$dsh_home/profiles/dsh-toolset-$pkg"
    yaml="$prof_dir/pnpm-workspace.yaml"
    [ -f "$prof_dir/package.json" ] ||
        dsh --profile "dsh-toolset-$pkg" --from-default-profile headless --dump-config > /dev/null 2>&1
    if [ -f "$yaml" ] && ! grep -q '^storeDir:' "$yaml"; then
        printf '\nstoreDir: %s\ncacheDir: %s\n' "$root/.pnpm-store" "$root/.pnpm-cache" >> "$yaml"
    fi
done

failed=0
for pkg in $pkgs; do
    if [ ! -d "$root/$pkg" ]; then
        printf 'SKIP  %s（目录不存在）\n' "$pkg"
        failed=1
        continue
    fi
    if [ ! -f "$root/$pkg/smoke/smoke.mjs" ]; then
        printf 'SKIP  %s（无 smoke/smoke.mjs）\n' "$pkg"
        failed=1
        continue
    fi
    log="$log_dir/$pkg.log"
    start=$(date +%s)
    printf 'RUN   %s ... ' "$pkg"
    if pnpm -C "$pkg" run smoke > "$log" 2>&1; then
        printf 'OK   %ss  %s\n' "$(($(date +%s) - start))" "$log"
    else
        printf 'FAIL %ss  %s\n' "$(($(date +%s) - start))" "$log"
        tail -n 16 "$log" | sed 's/^/      /'
        failed=1
    fi
done
exit "$failed"
