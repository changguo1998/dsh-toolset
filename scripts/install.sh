#!/usr/bin/env sh
# 新机器安装脚本：装 dsh → 构建本项目插件 → 配 profile（插件挂载）。
#
# 默认值：profile 名 fff、dsh 版本 0.2.1-rc.3、插件取 canonical_pkgs 全部包。
# 本项目只用 TUI：agent 面由 profile 全局组合提供，脚本不配置 agent preset
# （说明见 docs/host/AGENT-COMPOSITION.md）。
#
# 两个 profile（2026-10-27 起）：
#   主 profile（默认 fff）      —— 依赖值 `file:`：pnpm 把插件按包内容落成 node_modules
#                                  里的真实副本（快照）。改仓库源码不影响已在跑的会话，
#                                  要生效须重跑本脚本（--sync）或在该 profile 里 pnpm install。
#   伴随 profile（默认 fff-test）—— 依赖值 `link:`：符号链接指向仓库，改完 npm run build
#                                  即在新窗口生效，供实时开发 / 验证。
# 两者除依赖协议外完全一致：bundles、cordis.patch.yml、pnpm-workspace.yaml 及其它顶层
# 字段都按主 profile 的最终产物复制。--no-test-profile 可只装主 profile。
# 幂等：已存在的 profile 配置文件默认原样保留（--force 才覆盖）；写入与备份只发生
# 在内容确有变化时（--sync 可反复执行；内容未变不写、不备份），确有变化时先备份
# `.bak.<时间戳>`；只写 $DSH_HOME（默认 ~/.dsh）下的 profile 目录与本仓库，
# 不 sudo、不动系统路径、不改 settings.yaml。
#
# 用法：scripts/install.sh [选项]（见 --help）
set -eu

dsh_version_default="0.2.1-rc.3"
profile_name="fff"
plugins_sel="all"
dep_mode="copy"
test_profile_opt=""
enable_test_profile=1
skip_dsh=0
skip_build=0
force=0
sync=0
take_over_title=0
dry_run=0
skip_verify=0

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
profile_asset_dir="$repo_root/profiles/example"
# 插件清单（canonical_pkgs）：集合与根 package.json 的 check/build 链一致，顺序与
# scripts/test-parallel.sh 的 default_pkgs 同序（scripts/test-install.sh 有校验）。
# `clock-base` 置首：它注册服务 `clock`，要排在消费方（TUI / session-channel / background-daemon /
# metric-loop）之前激活，否则消费方启动时读不到服务（会回落各自的进程内定时器）。
canonical_pkgs="clock-base TUI herdr-integration herdr-use memory-base task-engine ast-tools md-logic md-map fs-digest goal-contract hash-edit metric-loop output-compress security-guard code-map context-report rule-engine behavior-correction symbol-normalizer session-channel session-title-cutoff command-template ponytail md-table-check auto-approve background-daemon preference-analysis session-paths script-interpreter agent-group coagent tool-consult escalation-hint"
usage() {
    cat << 'EOF'
用法：scripts/install.sh [选项]

  --profile <名字>      dsh profile 名（默认 fff）
  --mode <copy|link>    主 profile 的依赖形态（默认 copy）：
                          copy = `file:`，pnpm 落快照副本，改仓库不影响已装内容（稳）；
                          link = `link:`，符号链接指向仓库，改完 build 即生效（开发期）
  --profile-test <名字> 伴随 profile 名（默认 <主名>-test，即 fff-test）：依赖一律 `link:`，
                        其余内容按主 profile 最终产物复制，供新窗口实时开发
  --no-test-profile     不生成伴随 profile（只装主 profile）
  --plugins <列表|all>  要装的插件目录名，逗号或空格分隔（默认 all = canonical_pkgs 全部包）
  --dsh-version <版本>  安装的 dsh 版本（默认 0.2.1-rc.3）
  --skip-dsh            不安装 / 不校验 dsh（假设 PATH 上已有）
  --skip-build          跳过插件的 npm install 与 build（复用已有 dist/）
  --force               覆盖已存在的 profile 配置文件（内容有变化时才写入并备份）
  --sync                更新已存在的 profile：本仓库插件按**当前选择集**刷新（选择集变小则
                        移除已不在选择集的本仓库依赖 / bundle），非本仓库条目保留，再跑
                        pnpm install；不改写 cordis.patch.yml 的标题 provider 配置（见下）
  --take-over-title     与 --sync 同用：禁用 profile patch 里活跃的官方 all-prompts 标题
                        provider 条目，并把其 provider/model 复制给本仓库的
                        session-title-cutoff（宿主只允许一个标题 provider；不带本开关只提示、
                        不改 patch）。以 patch 内容为准：缺则补、取值失败下次重试；撤销 = 删除
                        patch 里以「# install.sh generated: title-takeover-」开头的生成区
  --dry-run             只打印将要执行的操作，不落盘
  --skip-verify         跳过收尾自检（dsh --profile <name> --dump-config；无 dsh / CI 场景）
  -h, --help            显示本帮助

环境变量：DSH_HOME 覆盖 Harness home（默认 ~/.dsh）；BUILD_JOBS 覆盖并行构建的并发数
（默认 CPU 核数）；BUILD_RUNNER 选调度器（auto / parallel / xargs / serial，默认 auto：
有 GNU parallel 用它、否则用 xargs、都没有则串行）；请勿在 dsh 运行中执行
（脚本会改写 profile 目录，宿主可能在读它）。本脚本不写 settings.yaml，
也不配置 agent preset——本项目只用 TUI，agent 面走 profile 全局组合。
EOF
}

log() { printf '[install] %s\n' "$*"; }
warn() { printf '[install] 注意：%s\n' "$*" >&2; }
die() {
    printf '[install] 失败：%s\n' "$*" >&2
    exit 1
}
have() { command -v "$1" > /dev/null 2>&1; }
run() {
    if [ "$dry_run" = 1 ]; then
        printf '[dry-run] %s\n' "$*"
    else
        "$@"
    fi
}
# 在指定目录里执行命令（dry-run 只打印）。
run_in() {
    dir="$1"
    shift
    if [ "$dry_run" = 1 ]; then
        printf '[dry-run] (cd %s && %s)\n' "$dir" "$*"
    else
        (cd "$dir" && "$@")
    fi
}
# 读子包 package.json 字段：pkg_name <目录> / is_bundle <目录>
pkg_name() {
    node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(m.name))' "$1/package.json"
}
is_bundle() {
    node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(m.dsh&&m.dsh.bundle?"1":"")' "$1/package.json"
}
# 名字校验：与宿主 resolveProfileDir 的口径对齐，另拒空白（脚本内部按空白分词）。
check_name() {
    case "$1" in
        "") die "$2 不能为空" ;;
        */* | *\\* | . | .. | node_modules) die "$2 非法：$1（不允许路径分隔符 / . / .. / node_modules）" ;;
        *[![:print:]]* | *" "*) die "$2 不能含空白或不可打印字符：$1" ;;
    esac
}
backup() {
    # 覆盖前备份（dry-run 不落盘）；调用方先比对内容，未变化时不调用本函数
    [ -e "$1" ] || return 0
    if [ "$dry_run" = 1 ]; then
        printf '[dry-run] 备份 %s -> %s.bak.<时间戳>\n' "$1" "$1"
    else
        bak="$1.bak.$(date +%s)"
        cp -p "$1" "$bak"
        log "已备份：$bak"
    fi
}

while [ $# -gt 0 ]; do
    case "$1" in
        --profile)
            [ $# -ge 2 ] || die "--profile 需要一个名字"
            profile_name="$2"
            shift 2
            ;;
        --profile=*)
            profile_name="${1#*=}"
            shift
            ;;
        --mode)
            [ $# -ge 2 ] || die "--mode 需要 copy 或 link"
            dep_mode="$2"
            shift 2
            ;;
        --mode=*)
            dep_mode="${1#*=}"
            shift
            ;;
        --profile-test)
            [ $# -ge 2 ] || die "--profile-test 需要一个名字"
            test_profile_opt="$2"
            shift 2
            ;;
        --profile-test=*)
            test_profile_opt="${1#*=}"
            shift
            ;;
        --no-test-profile)
            enable_test_profile=0
            shift
            ;;
        --plugins)
            [ $# -ge 2 ] || die "--plugins 需要列表或 all"
            plugins_sel="$2"
            shift 2
            ;;
        --plugins=*)
            plugins_sel="${1#*=}"
            shift
            ;;
        --dsh-version)
            [ $# -ge 2 ] || die "--dsh-version 需要一个版本号"
            dsh_version_default="$2"
            shift 2
            ;;
        --dsh-version=*)
            dsh_version_default="${1#*=}"
            shift
            ;;
        --skip-dsh)
            skip_dsh=1
            shift
            ;;
        --skip-build)
            skip_build=1
            shift
            ;;
        --force)
            force=1
            shift
            ;;
        --sync)
            sync=1
            shift
            ;;
        --take-over-title)
            take_over_title=1
            shift
            ;;
        --dry-run)
            dry_run=1
            shift
            ;;
        --skip-verify)
            skip_verify=1
            shift
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        *) die "未知参数：$1（用 --help 看用法）" ;;
    esac
done

check_name "$profile_name" "profile 名"
case "$dep_mode" in
    copy | link) ;;
    *) die "--mode 只接受 copy（file: 快照）或 link（符号链接）：$dep_mode" ;;
esac
test_profile=""
if [ "$enable_test_profile" = 1 ]; then
    test_profile="${test_profile_opt:-${profile_name}-test}"
    check_name "$test_profile" "伴随 profile 名"
    [ "$test_profile" != "$profile_name" ] || die "伴随 profile 名不能与主 profile 相同：$test_profile（用 --profile-test 换一个，或 --no-test-profile 关掉）"
fi
if [ "$take_over_title" = 1 ] && [ "$sync" != 1 ]; then
    die "--take-over-title 需要与 --sync 一起用（它更新已存在的 profile 的 cordis.patch.yml）"
fi
if [ "$sync" = 1 ] && [ "$force" = 1 ]; then
    die "『--sync --force』组合不支持：清单按 --sync 合并、资产文件按 --force 覆盖，语义不一致；且 --force 会用示例 patch 覆盖 cordis.patch.yml（本脚本生成的标题接管生成区一并丢失，示例里官方行是注释 → 之后无法自动重建），并重渲染 package.json（用户自加的依赖与额外 bundle 丢失）。二选一：
    a) 只更新挂载、保留 patch 与自加项：sh scripts/install.sh --sync [--take-over-title]
    b) 确认重置资产：先备份 profile 的 cordis.patch.yml 与 package.json（覆盖前本脚本也会留 .bak），再单独跑 sh scripts/install.sh --force（不带 --sync）；重置后恢复接管 = 用 .bak 恢复 patch，或重挂官方行（依赖 + insert 行）后再跑 --sync --take-over-title"
fi
dsh_home="${DSH_HOME:-$HOME/.dsh}"

# ── 1/5 前置检查 ────────────────────────────────────────────────────────────
log "1/5 前置检查"
[ -f "$repo_root/package.json" ] || die "仓库根不对：$repo_root"
# 后续有相对路径（`*/package.json` 发现插件、is_bundle/pkg_name），统一切到仓库根，
# 这样从 scripts/ 目录直接 `./install.sh` 运行也可用。
cd "$repo_root" || die "无法进入仓库根：$repo_root"
have node || die "需要 node（脚本用它读 package.json / 生成 manifest）"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "node 版本过低（$node_major），本项目要求 20+，建议 22+"
[ "$node_major" -ge 22 ] || warn "node $node_major 低于 22，部分包的类型剥离测试不可用（运行不受影响）"
have npm || die "需要 npm（安装 dsh 与各子包依赖）"
have pnpm || die "需要 pnpm（profile 的依赖管理走 pnpm）：corepack enable pnpm 或 npm i -g pnpm"
run mkdir -p "$dsh_home" "$dsh_home/profiles"
if [ "$dry_run" != 1 ]; then
    [ -w "$dsh_home" ] || die "DSH_HOME 不可写：$dsh_home"
fi
log "仓库 $repo_root；DSH_HOME $dsh_home；profile=$profile_name"

# ── 2/5 安装 dsh ────────────────────────────────────────────────────────────
log "2/5 安装 dsh $dsh_version_default"
if [ "$skip_dsh" = 1 ]; then
    have dsh || warn "--skip-dsh 已给，但 PATH 上没有 dsh"
else
    current="$(dsh --version 2> /dev/null | tr -d '\r' || true)"
    if [ "$current" = "$dsh_version_default" ]; then
        log "已装 dsh $current，跳过"
    else
        npm_root="$(npm root -g 2> /dev/null || true)"
        [ -n "$npm_root" ] || die "拿不到全局 npm 目录（npm root -g）"
        [ -w "$npm_root" ] || die "全局 npm 目录不可写：$npm_root。请改用用户级 node（fnm/nvm），或手动 sudo npm i -g @deepseek-ai/dsh@$dsh_version_default 后加 --skip-dsh 重跑"
        run npm install -g "@deepseek-ai/dsh@$dsh_version_default"
        if [ "$dry_run" != 1 ]; then
            have dsh || warn "装完仍未在 PATH 上找到 dsh，请重开终端或执行 hash -r"
            log "dsh 版本：$(dsh --version 2> /dev/null || echo 未知)"
        fi
    fi
fi

# ── 2.5/5 检查 profile 树外官方插件版本 ─────────────────────────────────────
# 树外加装的官方包（例：@deepseek-ai/dsh-session-title-all-prompts-llm）必须与宿主
# dsh 同版；不同版时 pnpm install 不报错、启动才暴露。只读：扫 dependencies /
# devDependencies 里的 @deepseek-ai/dsh-*（排除 link:/file: 值；bundles 不扫——
# @deepseek-ai/dsh-base 随宿主树解析）。
check_manifest="$dsh_home/profiles/$profile_name/package.json"
if [ -f "$check_manifest" ]; then
    host_version=""
    if [ "$skip_dsh" = 1 ]; then
        if have dsh; then
            host_version="$(dsh --version 2> /dev/null | tr -d '\r' | sed 's/[[:space:]]*$//' || true)"
            [ -n "$host_version" ] || warn "拿不到 dsh --version 输出，跳过树外官方插件版本检查"
        fi # 无 dsh：第 2 步已告警（--skip-dsh），这里静默跳过
    else
        host_version="$dsh_version_default"
    fi
    if [ -n "$host_version" ]; then
        if result="$(node -e '
const fs = require("fs");
const [file, hostVersion] = process.argv.slice(1);
const m = JSON.parse(fs.readFileSync(file, "utf8"));
const deps = Object.assign({}, m.dependencies, m.devDependencies);
const lines = [];
let candidates = 0;
for (const [name, spec] of Object.entries(deps)) {
  if (!name.startsWith("@deepseek-ai/dsh-")) continue;
  if (typeof spec !== "string" || spec.startsWith("link:") || spec.startsWith("file:")) continue;
  candidates += 1;
  const clean = spec.replace(/^[\^~]/, "");
  if (!/^\d+\.\d+\.\d+/.test(clean)) lines.push(`unknown ${name} ${spec}`);
  else if (clean !== hostVersion) lines.push(`mismatch ${name} ${spec}`);
}
if (!candidates) console.log("none");
else if (!lines.length) console.log("ok");
else console.log(lines.join("\n"));
' "$check_manifest" "$host_version" 2> /dev/null)"; then
            case "$result" in
                none) log "profile 无树外官方插件依赖，跳过版本检查" ;;
                ok) log "profile 树外官方插件版本与宿主 dsh 一致（$host_version）" ;;
                *)
                    warn "profile 树外官方插件版本检查（宿主 dsh $host_version）："
                    printf '%s\n' "$result" | while IFS=" " read -r kind name spec; do
                        case "$kind" in
                            mismatch) warn "  $name：$spec → 与宿主不一致，请把 pin 改为 $host_version" ;;
                            unknown) warn "  $name：$spec → 非精确版本，无法自动判定，请人工确认" ;;
                        esac
                    done
                    if printf '%s\n' "$result" | grep -q "^mismatch "; then
                        warn "改完 pin 后，在该 profile 目录重跑 pnpm install："
                        warn "  cd $dsh_home/profiles/$profile_name && pnpm install"
                    fi
                    ;;
            esac
        else
            warn "无法解析 $check_manifest，跳过树外官方插件版本检查"
        fi
    fi
fi

# ── 3/5 构建插件 ────────────────────────────────────────────────────────────
log "3/5 构建本项目插件"
discovered=""
for manifest in */package.json; do
    [ -f "$manifest" ] || continue
    dir="${manifest%/package.json}"
    if [ -n "$(is_bundle "$dir")" ]; then discovered="$discovered $dir"; fi
done
for d in $discovered; do
    case " $canonical_pkgs " in
        *" $d "*) ;;
        *) warn "发现未列入脚本清单的插件包 $d（已忽略；请同步 canonical_pkgs）" ;;
    esac
done
# 反向校验（与上一条对称）：canonical_pkgs 里有、仓库里没有的目录 → 告警（不 die：
# 子集选择不应被历史残留项误伤；all / 默认选择会在下方选择循环里 die）。
for d in $canonical_pkgs; do
    [ -d "$repo_root/$d" ] || warn "canonical_pkgs 里的 $d 目录不存在（请同步 canonical_pkgs）"
done
if [ "$plugins_sel" = "all" ]; then
    selected="$canonical_pkgs"
else
    selected="$(printf '%s' "$plugins_sel" | tr ',' ' ')"
fi
final=""
for d in $selected; do
    if [ ! -d "$repo_root/$d" ]; then
        die "$d 不是本仓库的子包目录（--plugins all / 默认选择时请同步 canonical_pkgs）"
    fi
    if [ -z "$(is_bundle "$d")" ]; then
        die "$d 未声明 dsh.bundle，不能作为 profile bundle 挂载"
    fi
    final="$final $d"
done
[ -n "$final" ] || die "没有选中任何插件"
log "选中插件：$(printf '%s' "$final" | sed 's/^ //')"
if [ "$skip_build" = 1 ]; then
    log "按 --skip-build 跳过 npm install / build（要求各包 dist/ 已存在）"
else
    # 依赖安装仍串行：npm/pnpm 并发会争同一份缓存与 lock 文件，失败定位也更难。
    for d in $final; do
        if [ ! -d "$repo_root/$d/node_modules" ]; then
            # npm 不支持 `link:` 协议（code-map → ast-tools、md-map → md-logic）：这些包改用 pnpm
            if grep -q '"link:' "$repo_root/$d/package.json"; then
                if command -v pnpm > /dev/null 2>&1; then
                    log "安装依赖（pnpm；含 link: 本地依赖）：$d"
                    run_in "$repo_root/$d" pnpm install
                else
                    die "$d 声明了 link: 本地依赖，需要 pnpm（npm install 不支持该协议）：请先安装 pnpm"
                fi
            else
                log "安装依赖：$d"
                run_in "$repo_root/$d" npm install --no-audit --no-fund
            fi
        fi
    done
    # 构建并行。跨包源码依赖只有两处（code-map → ast-tools、md-map → md-logic），
    # 依赖方放到第二批，保证全新环境（dist/ 尚不存在）也能一次构建成功。
    if [ "$dry_run" = 1 ]; then
        for d in $final; do
            run_in "$repo_root/$d" npm run build
        done
    else
        phase1=""
        phase2=""
        for d in $final; do
            case "$d" in
                code-map | md-map) phase2="$phase2 $d" ;;
                *) phase1="$phase1 $d" ;;
            esac
        done
        build_jobs="${BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2> /dev/null || echo 4)}"
        build_runner="${BUILD_RUNNER:-auto}"
        case "$build_runner" in
            auto | parallel | xargs | serial) ;;
            *) die "BUILD_RUNNER 只接受 auto / parallel / xargs / serial：$build_runner" ;;
        esac
        case "$build_jobs" in
            "" | *[!0-9]*) die "BUILD_JOBS 必须是正整数：$build_jobs" ;;
        esac
        [ "$build_jobs" -ge 1 ] || die "BUILD_JOBS 必须 >= 1：$build_jobs"
        log "并行构建：$(printf '%s' "$final" | wc -w | tr -d ' ') 个包，并发 $build_jobs（依赖方后置）"
        build_log_dir="${TMPDIR:-/tmp}/dsh-install-build.$$"
        mkdir -p "$build_log_dir"
        build_worker="$build_log_dir/build-one.sh"
        cat > "$build_worker" << 'EOS'
#!/bin/sh
# install.sh 的单包构建单元：日志 / 退出码 / 耗时各落一个文件，供宿主脚本汇总。
set -u
d="$1"
root="${INSTALL_BUILD_ROOT:?}"
lb="${INSTALL_BUILD_LOGDIR:?}"
safe=$(printf '%s' "$d" | tr '/.' '__')
start=$(date +%s%N 2> /dev/null || echo 0)
case "$start" in
    "" | *[!0-9]*) start=0 ;;
esac
if (cd "$root/$d" && npm run build) > "$lb/$safe.log" 2>&1; then
    rc=0
else
    rc=$?
fi
end=$(date +%s%N 2> /dev/null || echo 0)
case "$end" in
    "" | *[!0-9]*) end=0 ;;
esac
printf '%s' "$rc" > "$lb/$safe.exit"
if [ "$start" -gt 0 ] && [ "$end" -ge "$start" ]; then
    printf '%s' $(((end - start) / 1000000)) > "$lb/$safe.ms"
else
    printf '0' > "$lb/$safe.ms"
fi
exit "$rc"
EOS
        chmod +x "$build_worker"
        INSTALL_BUILD_ROOT="$repo_root"
        INSTALL_BUILD_LOGDIR="$build_log_dir"
        export INSTALL_BUILD_ROOT INSTALL_BUILD_LOGDIR
        run_build_batch() { # run_build_batch <包列表>：parallel → xargs → 串行兜底
            batch="$1"
            [ -n "$batch" ] || return 0
            if { [ "$build_runner" = "auto" ] || [ "$build_runner" = "parallel" ]; } && have parallel; then
                # shellcheck disable=SC2086
                printf '%s\n' $batch | parallel -j "$build_jobs" --will-cite "$build_worker" {} || true
            elif { [ "$build_runner" = "auto" ] || [ "$build_runner" = "xargs" ]; } && have xargs; then
                # shellcheck disable=SC2086
                printf '%s\n' $batch | xargs -P "$build_jobs" -n 1 "$build_worker" || true
            else
                for d in $batch; do
                    "$build_worker" "$d" || true
                done
            fi
        }
        run_build_batch "$phase1"
        run_build_batch "$phase2"
        failed=""
        for d in $final; do
            safe=$(printf '%s' "$d" | tr '/.' '__')
            rc=$(cat "$build_log_dir/$safe.exit" 2> /dev/null || echo 1)
            ms=$(cat "$build_log_dir/$safe.ms" 2> /dev/null || echo 0)
            if [ "$rc" = 0 ]; then
                printf '[install] OK   %-20s %6s ms\n' "$d" "$ms"
                if [ ! -d "$repo_root/$d/dist" ]; then
                    warn "$d 构建后仍无 dist/，挂载后可能加载失败"
                fi
            else
                printf '[install] FAIL %-20s %6s ms\n' "$d" "$ms"
                failed="$failed $d"
            fi
        done
        if [ -n "$failed" ]; then
            for d in $failed; do
                safe=$(printf '%s' "$d" | tr '/.' '__')
                printf '\n--- %s 构建日志尾部（完整日志：%s）---\n' "$d" "$build_log_dir/$safe.log" >&2
                tail -n 30 "$build_log_dir/$safe.log" >&2 || true
            done
            die "并行构建失败：$(printf '%s' "$failed" | sed 's/^ //')（日志目录：$build_log_dir）"
        fi
        rm -rf "$build_log_dir"
    fi
fi

# ── 4/5 配置 profile ────────────────────────────────────────────────────────
log "4/5 配置 profile"
pdir="$dsh_home/profiles/$profile_name"
if [ -e "$pdir" ] && [ ! -d "$pdir" ]; then
    die "$pdir 已存在且不是目录，请先移走或换个 profile 名"
fi
run mkdir -p "$pdir"
manifest="$pdir/package.json"
# 主 profile 的依赖协议：copy → `file:`（pnpm 落快照副本），link → `link:`（符号链接）
dep_proto="link"
[ "$dep_mode" = "copy" ] && dep_proto="file"
# 生成 profile 清单：dependencies 按 dep_proto 指向本仓库，bundles 声明要加载的层。
render_manifest() {
    printf '{\n'
    printf '  "name": "dsh-profile-%s",\n' "$profile_name"
    printf '  "private": true,\n'
    printf '  "dependencies": {\n'
    # 键序与合并路径（--sync）一致：两条路径共用 node 默认排序（包名全 ASCII，等价于字节序）
    node -e '
const fs = require("fs");
const [root, proto, ...dirs] = process.argv.slice(1);
const rows = dirs
  .map((dir) => [
    JSON.parse(fs.readFileSync(`${root}/${dir}/package.json`, "utf8")).name,
    dir,
  ])
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
process.stdout.write(
  rows
    .map(
      ([name, dir], i) =>
        `    "${name}": "${proto}:${root}/${dir}"${i === rows.length - 1 ? "" : ","}`,
    )
    .join("\n") + "\n",
);
' "$repo_root" "$dep_proto" $final
    printf '  },\n'
    printf '  "dsh": {\n    "profile": {\n      "bundles": [\n        "@deepseek-ai/dsh-base"'
    for d in $final; do
        printf ',\n        "%s"' "$(pkg_name "$d")"
    done
    printf '\n      ]\n    }\n  }\n}\n'
}
if [ -f "$manifest" ] && [ "$sync" = 1 ]; then
    # --sync：合并式更新既有 manifest——本仓库插件的依赖与 bundles 按当前选择刷新，
    # 用户自行添加的其它依赖 / bundle 原样保留（例：官方标题 provider）。
    log "合并更新 $manifest（--sync：保留非本仓库条目）"
    if [ "$dry_run" = 1 ]; then
        printf '[dry-run] 合并更新 %s\n' "$manifest"
    else
        # 先算合并结果（stdout）再与现状比对：内容未变则不写、不备份（避免堆积 .bak）
        # 合并语义（--sync）：本仓库插件的依赖与 bundles **按当前选择集刷新**（选择集变小则
        # 移除已不在选择集的本仓库条目），非本仓库条目（用户自加依赖 / 额外 bundle）一律保留。
        # 移除清单经 stderr 回传（stdout 只放 manifest JSON，便于直接落盘）。
        merge_err="$(mktemp "${TMPDIR:-/tmp}/dsh-install-merge.XXXXXX")"
        if ! merged="$(node -e '
const fs = require("fs");
const argv = process.argv.slice(1);
const split = argv.indexOf("--all");
const head = split < 0 ? argv : argv.slice(0, split);
const allDirs = split < 0 ? [] : argv.slice(split + 1);
const [file, repoRoot, proto, ...dirs] = head;
const protoName = proto === "copy" ? "file" : "link";
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const readName = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(`${repoRoot}/${dir}/package.json`, "utf8")).name;
  } catch {
    return undefined;
  }
};
const ours = new Set();
// 仓库内全部插件名（canonical_pkgs）——用来区分「本仓库已移出选择集」与「用户自加」
const repoNames = new Set(allDirs.map(readName).filter((name) => typeof name === "string"));
manifest.dependencies ??= {};
// 依赖值仍 link: / file: 指向本仓库的既有条目也算「本仓库条目」：包改名后旧名已不在仓库
// 目录列表里（repoNames 取的是**当前**目录），只按名字判会被当成「用户自加」永久残留——
// 依赖与 bundles 各留一条、dsh 收尾自检只 WARN。改名时唯一没变的是链接目标，故以它补判；
// 两种协议都认（主 profile 从 link: 切到 file: 时不留旧条目）。
const linkedRepo = new Set(
  Object.entries(manifest.dependencies)
    .filter(
      ([, value]) =>
        typeof value === "string" &&
        [`link:${repoRoot}/`, `file:${repoRoot}/`].some((p) => value.startsWith(p)),
    )
    .map(([name]) => name),
);
const isRepoEntry = (name) => repoNames.has(name) || linkedRepo.has(name);
for (const dir of dirs) {
  const name = readName(dir);
  if (name === undefined) continue;
  ours.add(name);
  manifest.dependencies[name] = `${protoName}:${repoRoot}/${dir}`;
}
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
// 移除本仓库中已不在选择集的依赖（非本仓库依赖原样保留）
const removedDeps = Object.keys(manifest.dependencies).filter(
  (name) => isRepoEntry(name) && !ours.has(name),
);
for (const name of removedDeps) delete manifest.dependencies[name];
// 键序对齐 pnpm 的生成物约定（本仓库生成物与 fff 侧都是字母序）
manifest.dependencies = Object.fromEntries(
  Object.entries(manifest.dependencies).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ),
);
const existing = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
const removedBundles = existing.filter(
  (name) => isRepoEntry(name) && !ours.has(name),
);
const extras = existing.filter(
  (name) => !ours.has(name) && !isRepoEntry(name) && name !== "@deepseek-ai/dsh-base",
);
manifest.dsh.profile.bundles = ["@deepseek-ai/dsh-base", ...dirs.map(readName).filter((name) => name !== undefined), ...extras];
process.stderr.write(`REMOVED_BUNDLES=${removedBundles.join(",")}\nREMOVED_DEPS=${removedDeps.join(",")}\nKEPT_EXTRAS=${extras.length}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
' "$manifest" "$repo_root" "$dep_mode" $final --all $discovered 2> "$merge_err")"; then
            # 排障信息（node 的报错）先回显，再清理并退出
            cat "$merge_err" >&2 2> /dev/null || true
            rm -f "$merge_err"
            die "合并更新 $manifest 失败"
        fi
        removed_bundles="$(sed -n 's/^REMOVED_BUNDLES=//p' "$merge_err")"
        removed_deps="$(sed -n 's/^REMOVED_DEPS=//p' "$merge_err")"
        kept_extras="$(sed -n 's/^KEPT_EXTRAS=//p' "$merge_err")"
        rm -f "$merge_err"
        if [ "$merged" = "$(cat "$manifest")" ]; then
            log "清单内容未变，跳过备份与写入：$manifest"
        else
            backup "$manifest"
            printf '%s\n' "$merged" > "$manifest"
            log "已更新 $manifest（本仓库 bundle $(printf '%s' "$final" | wc -w) 个 + dsh-base + 非本仓库额外 ${kept_extras:-0} 个）"
            if [ -n "${removed_bundles}${removed_deps}" ]; then
                log "已按当前选择集移除本仓库条目：bundle [${removed_bundles:-无}]、依赖 [${removed_deps:-无}]（非本仓库条目保留）"
            fi
        fi
    fi
elif [ -f "$manifest" ] && [ "$force" != 1 ]; then
    log "保留已有 $manifest（--force 覆盖 / --sync 合并更新）"
elif [ "$dry_run" = 1 ]; then
    printf '[dry-run] 写入 %s：\n' "$manifest"
    render_manifest
else
    rendered="$(render_manifest)"
    printf '%s\n' "$rendered" |
        node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' ||
        die "生成的 $manifest 不是合法 JSON"
    if [ -f "$manifest" ] && [ "$rendered" = "$(cat "$manifest")" ]; then
        log "清单内容未变，跳过备份与写入：$manifest"
    else
        backup "$manifest"
        printf '%s\n' "$rendered" > "$manifest"
        log "写入 $manifest（bundle 数：$(printf '%s' "$final" | wc -w) + dsh-base）"
    fi
fi
# hmr 生成区的 begin/end 标记：资产复制路径也要用它识别「差异只在生成区」的情况。
hmr_begin="# install.sh generated: hmr-root-begin v1"
hmr_end="# install.sh generated: hmr-root-end v1"
patch_copied=0
for asset in pnpm-workspace.yaml cordis.patch.yml; do
    target="$pdir/$asset"
    if [ -f "$target" ] && [ "$force" != 1 ]; then
        log "保留已有 $target（--force 可覆盖）"
        continue
    fi
    if [ -f "$target" ] && cmp -s "$profile_asset_dir/$asset" "$target"; then
        log "内容未变，跳过备份与复制：$target"
        continue
    fi
    # --force 覆盖 cordis.patch.yml 时，若与示例资产的差异只在 hmr 生成区，视为内容未变：
    # 避免每次 --force 都因生成区追加而备份并丢弃生成区。
    if [ -f "$target" ] && [ "$asset" = cordis.patch.yml ] &&
        node -e '
const fs = require("fs");
const [asset, target, begin, end] = process.argv.slice(1);
const lines = fs.readFileSync(target, "utf8").split(/\r?\n/);
const bi = lines.indexOf(begin);
const ei = lines.indexOf(end);
const stripped = (bi >= 0 && ei > bi ? [...lines.slice(0, bi), ...lines.slice(ei + 1)] : lines)
  .join("\n")
  .replace(/\n*$/, "\n");
process.exit(stripped === fs.readFileSync(asset, "utf8") ? 0 : 1);
' "$profile_asset_dir/$asset" "$target" "$hmr_begin" "$hmr_end"; then
        log "内容未变（仅 hmr 生成区随机器不同），跳过备份与复制：$target"
        continue
    fi
    if [ -f "$target" ] && [ "$force" = 1 ] &&
        grep -q -E '^# install\.sh (generated: title-takeover|title-takeover (route )?marker v1)' "$target"; then
        warn "--force 将用示例文件覆盖 $target：其中的标题接管生成区 / 标记会丢失（覆盖前会备份，恢复用 .bak；之后可重跑 --sync --take-over-title 重建）"
    fi
    backup "$target"
    run cp "$profile_asset_dir/$asset" "$target"
    [ "$asset" = cordis.patch.yml ] && patch_copied=1
done
# --sync：标题 provider 接管是**显式开关**（--take-over-title）。
# 文本判据分不清「宿主挂载的行」与「用户自己 insert 的行」，故 --sync 单独**绝不改写** patch
# （只按内容提示）；带开关时才维护**本脚本的生成区**——判定全部以 patch 内容为准：命中条目按
# 官方包名匹配（token 边界）、禁用态按条目 id + `disabled: true` 认、生成区按 sentinel 注释认；
# 缺则补、取值失败只 warn 留待重试；**删除生成区 = 放弃接管**。
# 注：--dump-default-config 不是只读判据（会物化 profile 派生文件），故不用它做判据。
patch_file="$pdir/cordis.patch.yml"
title_official_key="dsh-session-title-all-prompts-llm"
title_disable_sentinel="# install.sh generated: title-takeover-disable v1"
title_route_sentinel="# install.sh generated: title-takeover-route v1"

# ── hmr 模块监听根（生成区）─────────────────────────────────────────────────
# 必须同时给 base 与 root：hmr 的 baseDir 默认是 profile 目录（boot 时 ctx.baseUrl 取
# `<profile>/cordis.yml` 所在目录），root/ignored 都相对它解析；把 base 指向仓库后，
# root ['.'] 才落到仓库，默认 ignored（`**/node_modules` / `**/.*`）也才匹配得上
# （ignored 收的是相对 baseDir 的路径，带 `..` 前缀时 picomatch 一律不命中）。
# 文档类不参与重载，生成区里一并忽略以减少文件事件。
# 生成区用 begin/end 标记维护（幂等）；检测到标记之外的手写 `- id: hmr` 时不写。
render_hmr_block() {
    printf '%s\n' "$hmr_begin"
    printf '# 模块热重载：base 指向安装时的仓库，root 相对 base；文档类直接忽略减事件。\n'
    printf -- '- id: hmr\n'
    printf '  config:\n'
    printf "    base: '%s'\n" "$(printf '%s' "$repo_root" | sed "s/'/''/g")"
    printf "    root: ['.']\n"
    printf '    ignored:\n'
    printf "      - '**/node_modules'\n"
    printf "      - '**/.*'\n"
    printf "      - 'cache'\n"
    printf "      - 'data'\n"
    printf "      - '**/*.md'\n"
    printf "      - '**/docs/**'\n"
    printf '%s\n' "$hmr_end"
}
# 只在首次写入资产（patch_copied）或显式 --sync / --force 时维护生成区：
# 既有的 cordis.patch.yml 在普通重跑里保持原样（脚本「已存在配置文件默认保留」的约定）。
if [ -f "$patch_file" ] && { [ "$patch_copied" = 1 ] || [ "$sync" = 1 ] || [ "$force" = 1 ]; }; then
    hmr_state="$(node -e '
const fs = require("fs");
const [file, begin, end] = process.argv.slice(1);
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const bi = lines.indexOf(begin);
const ei = lines.indexOf(end);
const manual = lines.some(
  (l, i) =>
    /^-\s*id:\s*hmr\s*$/.test(l) && !(bi >= 0 && i >= bi && (ei < 0 || i <= ei)),
);
const mode = bi >= 0 && ei > bi ? "update" : bi >= 0 || ei >= 0 ? "broken" : manual ? "manual" : "append";
process.stdout.write(mode);
' "$patch_file" "$hmr_begin" "$hmr_end")" || die "读取 hmr 生成区状态失败：$patch_file"
    case "$hmr_state" in
        manual) log "检测到手写 - id: hmr，保留其配置（不写模块热重载生成区）" ;;
        update | append | broken)
            if [ "$hmr_state" = broken ]; then
                warn "$patch_file 的 hmr 生成区标记不完整（begin/end 缺一）：按追加重建，旧残块请手工清理"
            fi
            hmr_mode="$hmr_state"
            [ "$hmr_mode" = broken ] && hmr_mode=append
            if [ "$dry_run" = 1 ]; then
                printf '[dry-run] 更新 hmr 生成区（root=%s）：%s\n' "$repo_root" "$patch_file"
            else
                hmr_block="$(mktemp "${TMPDIR:-/tmp}/dsh-install-hmr.XXXXXX")"
                render_hmr_block > "$hmr_block"
                if ! hmr_next="$(node -e '
const fs = require("fs");
const [file, begin, end, blockFile, mode] = process.argv.slice(1);
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const block = fs.readFileSync(blockFile, "utf8").replace(/\n$/, "").split("\n");
let out;
if (mode === "update") {
  const bi = lines.indexOf(begin);
  const ei = lines.indexOf(end);
  out = [...lines.slice(0, bi), ...block, ...lines.slice(ei + 1)];
} else {
  const base = [...lines];
  while (base.length > 0 && base[base.length - 1] === "") base.pop();
  out = [...base, "", ...block];
}
process.stdout.write(out.join("\n").replace(/\n*$/, "\n"));
' "$patch_file" "$hmr_begin" "$hmr_end" "$hmr_block" "$hmr_mode")"; then
                    rm -f "$hmr_block"
                    die "更新 hmr 生成区失败：$patch_file"
                fi
                rm -f "$hmr_block"
                if [ "$hmr_next" = "$(cat "$patch_file")" ]; then
                    log "hmr 生成区未变，跳过写入：$patch_file"
                else
                    # 本轮刚由示例资产写出 patch 时不必再备份（复制路径已备份 / 首次安装无旧内容）
                    [ "$patch_copied" = 1 ] || backup "$patch_file"
                    printf '%s\n' "$hmr_next" > "$patch_file"
                    log "已写入 hmr 生成区（root=$repo_root）：$patch_file"
                fi
            fi
            ;;
    esac
fi
if [ "$sync" = 1 ] && [ -f "$patch_file" ]; then
    # 结构化读取（node；只读）：`id <id> <行>` / `disabled <id>` / `value <p> <m>` / `route <p> <m>` /
    # `generated-disable <id> <行>` / `generated-route <行>` / `legacy-marker`。
    # 取值一律白名单清洗（剥成对引号 / 去行内注释；含空格或非法字符视为取不到）。
    title_state="$(
        node -e '
const fs = require("fs");
const [file, key] = process.argv.slice(1);
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const active = (s) => !/^\s*#/.test(s);
const clean = (v) => {
  let t = (v == null ? "" : v).trim();
  if (/^["\x27].*["\x27]$/.test(t)) t = t.slice(1, -1).trim();
  t = t.replace(/\s+#.*$/, "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(t) ? t : "";
};
const hasKey = (s) => {
  for (let i = s.indexOf(key); i >= 0; i = s.indexOf(key, i + 1)) {
    const b = i === 0 ? "" : s[i - 1];
    const a = s[i + key.length] == null ? "" : s[i + key.length];
    if (!/[A-Za-z0-9._-]/.test(b) && !/[A-Za-z0-9._-]/.test(a)) return true;
  }
  return false;
};
const items = [];
let cur = null;
for (let idx = 0; idx < lines.length; idx += 1) {
  const line = lines[idx];
  if (!active(line)) continue;
  const m = line.match(/^(\s*)- /);
  if (m) {
    if (cur && m[1].length <= cur.indent) {
      items.push(cur);
      cur = null;
    }
    if (!cur) cur = { indent: m[1].length, line: idx + 1, fields: {} };
    const fm = line.slice(m[0].length).match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (fm) cur.fields[fm[1]] = fm[2];
    continue;
  }
  if (!cur) continue;
  const im = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
  if (!im) continue;
  if (im[1].length <= cur.indent) {
    items.push(cur);
    cur = null;
    continue;
  }
  if (!(im[2] in cur.fields)) cur.fields[im[2]] = im[3];
}
if (cur) items.push(cur);
const out = [];
const hits = items.filter((it) =>
  [it.fields.name, it.fields.id].some((v) => v && hasKey(v)),
);
const seen = new Set();
for (const it of hits) {
  const id = clean(it.fields.id);
  if (!id || seen.has(id)) continue;
  seen.add(id);
  out.push(`id ${id} ${it.line}`);
  if (/^true$/.test((it.fields.disabled == null ? "" : it.fields.disabled).trim()))
    out.push(`disabled ${id}`);
}
// 禁用态按 id 扫**全部**条目（本脚本生成的禁用块只有 id、没有 name，不在 hits 里）
for (const it of items) {
  const id = clean(it.fields.id);
  if (!id || !seen.has(id)) continue;
  if (/^true$/.test((it.fields.disabled == null ? "" : it.fields.disabled).trim()))
    out.push(`disabled ${id}`);
}
const val = hits
  .map((it) => [clean(it.fields.provider), clean(it.fields.model)])
  .find((pair) => pair[0] && pair[1]);
if (val) out.push(`value ${val[0]} ${val[1]}`);
const cutoff = items.find((it) => clean(it.fields.id) === "session-title-cutoff");
if (cutoff) {
  const cp = clean(cutoff.fields.provider);
  const cm = clean(cutoff.fields.model);
  if (cp && cm) out.push(`route ${cp} ${cm}`);
}
for (let idx = 0; idx < lines.length; idx += 1) {
  const line = lines[idx];
  if (line.indexOf("# install.sh generated: title-takeover-disable v1") === 0) {
    const rest = lines.slice(idx + 1).find((l) => l.trim() !== "" && active(l));
    const m = rest == null ? null : rest.match(/^\s*- id:\s*(\S+)/);
    out.push(`generated-disable ${m ? clean(m[1]) : "-"} ${idx + 1}`);
  }
  if (line.indexOf("# install.sh generated: title-takeover-route v1") === 0)
    out.push(`generated-route ${idx + 1}`);
  if (/^# install\.sh title-takeover (route )?marker v1/.test(line)) out.push("legacy-marker");
}
process.stdout.write(`${out.join("\n")}\n`);
' "$patch_file" "$title_official_key"
    )" || die "读取标题条目状态失败：$patch_file"
    title_ids="$(printf '%s\n' "$title_state" | awk '/^id /{printf "%s ", $2}')"
    title_missing=""
    for title_id in $title_ids; do
        printf '%s\n' "$title_state" | grep -qx "disabled $title_id" || title_missing="$title_missing $title_id"
    done
    title_route="$(printf '%s\n' "$title_state" | awk '/^route /{print $2 " " $3; exit}')"
    if [ "$take_over_title" != 1 ]; then
        # 只读：绝不改写（按内容给精确提示）
        case " $final " in
            *" session-title-cutoff "*)
                if [ -n "$title_missing" ]; then
                    warn "$patch_file 里官方 all-prompts 标题 provider 仍启用（id:$title_missing），而本 profile 也挂了 session-title-cutoff（宿主只允许一个标题 provider，同挂会有一个注册失败、且可能静默不生效）。二选一："
                    warn "  a) 让 cutoff 接管：sh scripts/install.sh --sync --take-over-title（禁用这些条目并按需复制 provider/model）"
                    warn "  b) 保留官方实现：把 session-title-cutoff 从 profile 的 bundles 移除，或给它加 disabled: true"
                elif [ -n "$title_ids" ] && [ -z "$title_route" ]; then
                    log "标题接管：禁用块已在，但未见 session-title-cutoff 的显式路由（provider/model）——带 --take-over-title 可补齐"
                else
                    log "profile patch 未见活跃的官方 all-prompts 标题 provider 行（不判断宿主基础层；如你另行挂载，请手工加 disabled: true）"
                fi
                ;;
            *)
                if [ -n "$title_missing" ]; then
                    log "profile patch 有活跃的 all-prompts 行，但本 profile 未挂 session-title-cutoff（不冲突）：不改动 patch"
                else
                    log "profile patch 未见活跃的官方 all-prompts 标题 provider 行（不判断宿主基础层）"
                fi
                ;;
        esac
    else
        case " $final " in
            *" session-title-cutoff "*) ;;
            *) die "--take-over-title 需要 profile 里挂 session-title-cutoff（否则禁用官方实现后没有替代标题 provider）：请把它加进 --plugins" ;;
        esac
        if [ "$dry_run" = 1 ]; then
            printf '[dry-run] 按当前 patch 补齐 / 校正标题接管生成区（含旧标记行清理）：%s\n' "$patch_file"
        else
            # 宿主按 patch 顺序索引（insert 先于 disabled）→ 生成区必须排在命中条目之后
            title_gen_line="$(printf '%s\n' "$title_state" | awk '/^generated-disable /{print $3; exit}')"
            title_last_hit="$(printf '%s\n' "$title_state" | awk '/^id /{l=$3} END{print l}')"
            title_order_bad=0
            if [ -n "$title_gen_line" ] && [ -n "$title_last_hit" ] && [ "$title_gen_line" -lt "$title_last_hit" ]; then
                title_order_bad=1
            fi
            title_wrote=0
            # 生成区写入：本次运行首次写入前备份一次
            title_write() {
                [ "$title_wrote" = 1 ] || backup "$patch_file"
                title_wrote=1
                cat >> "$patch_file"
            }
            if [ -n "$title_missing" ]; then
                title_write << EOF

$title_disable_sentinel
# 禁用官方 all-prompts 实现（宿主 ctx.sessionTitle 只允许注册一个 provider，二次注册会抛错）。
# id 取自 patch 里命中的官方条目本身；删除本生成区 = 放弃接管。
EOF
                for title_id in $title_missing; do
                    title_write << EOF
- id: $title_id
  disabled: true
EOF
                done
                log "已补写标题接管禁用块（id:$title_missing）"
            elif [ "$title_order_bad" = 1 ]; then
                title_write << EOF

$title_disable_sentinel
# 生成区重放（原生成区在命中条目之前，宿主按 patch 顺序索引会失效）：同 id 再禁用一次。
EOF
                for title_id in $title_ids; do
                    title_write << EOF
- id: $title_id
  disabled: true
EOF
                done
                log "已按顺序重放禁用块（原生成区在命中条目之前）"
                warn "旧生成区（第 $title_gen_line 行起）在命中条目之前、可能不生效：已补一份到文件尾；建议手工删除旧生成区（以 $title_disable_sentinel 开头）"
            fi
            if [ -z "$title_route" ]; then
                title_value="$(printf '%s\n' "$title_state" | awk '/^value /{print $2 " " $3; exit}')"
                if [ -n "$title_value" ]; then
                    title_write << EOF

$title_route_sentinel
# 复制自官方 all-prompts 条目的显式路由（provider/model 必须成对）。注意：本条 config 是整键替换，
# session-title-cutoff 的其它配置走插件默认值（与本仓库 bundle 层缺省一致）。
- id: session-title-cutoff
  config:
    provider: ${title_value%% *}
    model: ${title_value##* }
EOF
                    log "已补写 session-title-cutoff 显式路由（${title_value%% *} / ${title_value##* }）"
                else
                    warn "未能在官方 all-prompts 条目块内读到可用的 provider/model（缺失或格式不受支持）；未补路由——修正后重跑 --sync --take-over-title 会重试"
                fi
            fi
            # 过期生成区（id 已无对应活跃条目）：只提示、不自动删（删是破坏性动作）
            title_gen_id="$(printf '%s\n' "$title_state" | awk '/^generated-disable /{print $2; exit}')"
            if [ -n "$title_gen_id" ] && [ "$title_gen_id" != "-" ]; then
                case " $title_ids " in
                    *" $title_gen_id "*) ;;
                    *) warn "生成区里的禁用条目「$title_gen_id」已无对应的活跃官方行（可能已撤挂载）：未自动删除——确认无用后可手工删掉该生成区" ;;
                esac
            fi
            # 上一版实现的权威标记行不再使用：带开关时清理（我们的行，行首锚定）
            if printf '%s\n' "$title_state" | grep -q '^legacy-marker$'; then
                tmp_patch="$patch_file.tmp.$$"
                if grep -v -E '^# install\.sh title-takeover (route )?marker v1' "$patch_file" > "$tmp_patch" &&
                    cat "$tmp_patch" > "$patch_file"; then
                    rm -f "$tmp_patch"
                    log "已清理上一版的权威标记行（生成区自证接管；删除生成区 = 放弃接管）"
                else
                    rm -f "$tmp_patch"
                    die "清理旧标记行失败：$patch_file"
                fi
            fi
            if [ "$title_wrote" = 1 ]; then
                log "标题接管生成区已更新（$patch_file；删除以「# install.sh generated: title-takeover-」开头的生成区 = 放弃接管）"
            else
                log "标题接管生成区与当前 patch 一致（幂等：未写盘）"
            fi
        fi
    fi
fi
case " $final " in
    *" TUI "*) ;;
    *) warn "未选中 TUI：profiles/example/cordis.patch.yml 里针对 - id: tui 的配置会被跳过（启动日志有 patch 告警）" ;;
esac
case " $final " in
    *" memory-base "*) ;;
    *) warn "未选中 memory-base：profiles/example/cordis.patch.yml 里针对 - id: memory-base 的配置会被跳过" ;;
esac
log "profile 依赖：pnpm install（依赖协议：$dep_proto；本地包，无需联网下载本项目插件）"
# copy 模式要拿到**当前**仓库内容：pnpm 对 `file:` 目录依赖不跟踪内容变化（lockfile +
# node_modules 标记为 up-to-date 时直接跳过），删掉它的「已是最新」标记逼它重建（幂等、无需联网）
if [ "$dep_mode" = "copy" ] && [ "$dry_run" != 1 ]; then
    rm -f "$pdir/node_modules/.modules.yaml" "$pdir/node_modules/.pnpm-workspace-state-v1.json"
fi
run_in "$pdir" pnpm install
# 断开硬链接（copy 模式的关键一步）：pnpm 对 `file:` 目录依赖是把仓库文件**硬链接**进
# profile，原地改写（tsc 重编译、`>>` 追加）会顺着同一个 inode 传到运行中的 profile。
# 这里逐包整体复制一份再替换目录，让 profile 与新仓库内容彻底解耦（内容不变，只换 inode）。
break_hardlinks() { # break_hardlinks <包目录>：有共享 inode 时整目录复制替换
    entry="$1"
    [ -d "$entry" ] && [ ! -L "$entry" ] || return 0
    # 没有链接数 > 1 的文件 = 已是独立副本，跳过（保持幂等、不产生无谓 IO）
    [ -n "$(find "$entry" -type f -links +1 -print -quit 2> /dev/null)" ] || return 0
    stage="$entry.snapshot.$$"
    rm -rf "$stage"
    cp -R "$entry" "$stage" || {
        rm -rf "$stage"
        warn "复制快照失败：$entry（profile 仍与仓库共享文件，改代码可能影响运行中的会话）"
        return 0
    }
    rm -rf "$entry" && mv "$stage" "$entry" ||
        warn "替换快照目录失败：$entry（请手动删掉该目录后重跑 pnpm install）"
}
if [ "$dry_run" != 1 ]; then
    if [ "$dep_mode" = "copy" ]; then
        for d in $final; do
            break_hardlinks "$pdir/node_modules/$(pkg_name "$d")"
        done
    fi
    for d in $final; do
        pkg_entry="$pdir/node_modules/$(pkg_name "$d")"
        [ -e "$pkg_entry" ] || warn "$pdir/node_modules 下缺少 $(pkg_name "$d")，启动前请手动 pnpm install"
        # 形态自检：主 profile 应为真实目录（快照），不该还是指向仓库的符号链接
        if [ "$dep_mode" = "copy" ] && [ -L "$pkg_entry" ]; then
            warn "$pkg_entry 仍是符号链接（应为 file: 快照副本）：请在该 profile 里重跑 pnpm install，或先删掉 node_modules 再重跑本次安装"
        fi
        if [ "$dep_mode" = "copy" ] && [ -d "$pkg_entry" ] && [ -n "$(find "$pkg_entry" -type f -links +1 -print -quit 2> /dev/null)" ]; then
            warn "$pkg_entry 内仍有与仓库共享的文件（硬链接），改代码可能影响运行中的会话"
        fi
        if [ "$dep_mode" = "link" ] && [ -d "$pkg_entry" ] && [ ! -L "$pkg_entry" ]; then
            warn "$pkg_entry 是真实目录（--mode link 期望符号链接）：请先删掉 $pdir/node_modules 再重跑本次安装"
        fi
    done
fi

# ── 4b/5 生成伴随 profile（软链接，默认 <主名>-test）────────────────────────
# 派生规则：除依赖协议改为 link: 外，与主 profile 完全一致——bundles 与原样顶层字段取自
# 主 profile 的最终 package.json，cordis.patch.yml / pnpm-workspace.yaml 直接复制主 profile
# 的成品（不二次渲染，避免两条渲染路径漂移）。
if [ -n "$test_profile" ]; then
    # 前置：伴随 profile 是主 profile 的派生品，主清单不可读时不生成（也不 die——主 profile
    # 的既有流程照旧，例如清单被外部写坏时用户只需修好再重跑）。
    if [ ! -f "$manifest" ] || ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$manifest" 2> /dev/null; then
        warn "主 profile 清单缺失或无法解析，跳过伴随 profile（$test_profile）生成：$manifest"
        test_profile=""
    fi
fi
if [ -n "$test_profile" ]; then
    log "4b/5 生成伴随 profile（$test_profile，依赖 link: 指向本仓库）"
    tpdir="$dsh_home/profiles/$test_profile"
    if [ -e "$tpdir" ] && [ ! -d "$tpdir" ]; then
        die "$tpdir 已存在且不是目录，请先移走或换一个伴随 profile 名（--profile-test）"
    fi
    if [ "$dry_run" = 1 ]; then
        printf '[dry-run] 生成 %s（清单=%s 的 link: 版；资产复制自 %s）\n' "$tpdir" "$manifest" "$pdir"
        printf '[dry-run] (cd %s && pnpm install)\n' "$tpdir"
    else
        run mkdir -p "$tpdir"
        tmanifest="$tpdir/package.json"
        tname="dsh-profile-$test_profile"
        if ! tmanifest_next="$(node -e '
const fs = require("fs");
const [mainFile, name, repoRoot] = process.argv.slice(1);
const main = JSON.parse(fs.readFileSync(mainFile, "utf8"));
const out = JSON.parse(JSON.stringify(main));
out.name = name;
if (out.dependencies) {
  // 本仓库的依赖一律改成 link:（其余依赖原样保留，保证两 profile 依赖清单同集）
  out.dependencies = Object.fromEntries(
    Object.entries(out.dependencies).map(([pkg, spec]) => {
      const value = typeof spec === "string" ? spec : "";
      const ours = [`file:${repoRoot}/`, `link:${repoRoot}/`].some((p) => value.startsWith(p));
      return [pkg, ours ? `link:${value.slice(value.indexOf(":") + 1)}` : spec];
    }),
  );
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
' "$manifest" "$tname" "$repo_root")"; then
            die "生成伴随 profile 清单失败：$manifest -> $tmanifest"
        fi
        if [ -f "$tmanifest" ] && [ "$tmanifest_next" = "$(cat "$tmanifest")" ]; then
            log "伴随清单内容未变，跳过备份与写入：$tmanifest"
        else
            backup "$tmanifest"
            printf '%s\n' "$tmanifest_next" > "$tmanifest"
            log "写入 $tmanifest（依赖 link: 指向本仓库，其余与主 profile 一致）"
        fi
        for asset in pnpm-workspace.yaml cordis.patch.yml; do
            [ -f "$pdir/$asset" ] || continue
            if [ -f "$tpdir/$asset" ] && cmp -s "$pdir/$asset" "$tpdir/$asset"; then
                log "伴随 profile 的 $asset 与主 profile 一致，跳过复制"
                continue
            fi
            backup "$tpdir/$asset"
            run cp "$pdir/$asset" "$tpdir/$asset"
        done
        log "伴随 profile 依赖：pnpm install（依赖协议：link）"
        run_in "$tpdir" pnpm install
        for d in $final; do
            pkg_name_d="$(pkg_name "$d")"
            if [ ! -e "$tpdir/node_modules/$pkg_name_d" ]; then
                warn "$tpdir/node_modules 下缺少 $pkg_name_d，启动前请手动 pnpm install"
            elif [ ! -L "$tpdir/node_modules/$pkg_name_d" ]; then
                warn "$tpdir/node_modules/$pkg_name_d 不是符号链接（伴随 profile 应为 link:）：请先删掉 $tpdir/node_modules 再重跑本次安装"
            fi
        done
    fi
fi

# ── 5/5 完成 ────────────────────────────────────────────────────────────────
# 收尾自检：代跑一次 --dump-config，捕捉「未命中条目 id」等 patch 告警（dsh 会顺带在
# profile 目录物化 cordis.yml 等派生文件，仍在 $DSH_HOME 内）。告警不改变脚本退出码。
verify_profile() { # verify_profile <profile 名>：代跑 --dump-config 并回显 stderr 前 20 行
    vname="$1"
    # 2>&1 > /dev/null：stderr 进变量（先接到命令替换管道）、stdout 丢弃；< /dev/null 防交互挂起
    if dump_err="$(DSH_HOME="$dsh_home" dsh --profile "$vname" --dump-config < /dev/null 2>&1 > /dev/null)"; then
        dump_rc=0
    else
        dump_rc=$?
    fi
    if [ "$dump_rc" = 0 ] && [ -z "$dump_err" ]; then
        log "收尾自检通过（$vname）：--dump-config 解析无告警（不实例化插件）"
        return 0
    fi
    warn "收尾自检未通过：dsh --profile $vname --dump-config（退出码 $dump_rc）"
    warn "以下为 dsh stderr 原文（若与 profile patch 无关可忽略）："
    if [ -n "$dump_err" ]; then
        dump_lines="$(printf '%s\n' "$dump_err" | wc -l | tr -d ' ')"
        printf '%s\n' "$dump_err" | sed -e 's/^/    /' -e '20q' >&2
        [ "$dump_lines" -le 20 ] || warn "…（stderr 共 $dump_lines 行，仅显示前 20 行）"
    fi
    warn "排查提示：多为 profile 的 cordis.patch.yml 引用了未安装/不存在的条目 id；修正后重跑（或加 --skip-verify 跳过自检）"
    return 1
}
if [ "$skip_verify" = 1 ]; then
    log "按 --skip-verify 跳过收尾自检（--dump-config）"
elif [ "$dry_run" = 1 ]; then
    printf '[dry-run] DSH_HOME=%s dsh --profile %s --dump-config（收尾自检）\n' "$dsh_home" "$profile_name"
    if [ -n "$test_profile" ]; then
        printf '[dry-run] DSH_HOME=%s dsh --profile %s --dump-config（收尾自检）\n' "$dsh_home" "$test_profile"
    fi
elif ! have dsh; then
    log "未找到 dsh，跳过收尾自检（--dump-config）"
else
    verify_profile "$profile_name" || true
    [ -z "$test_profile" ] || verify_profile "$test_profile" || true
fi
log "5/5 完成"
cat << EOF

安装结果
  dsh           $(if have dsh; then dsh --version 2> /dev/null || echo "已装"; else echo "需重开终端"; fi)（目标 $dsh_version_default）
  profile       $pdir（$(printf '%s' "$final" | wc -w) 个插件 + dsh-base；依赖 ${dep_proto}: 快照副本，改仓库不影响已装内容）
$(if [ -n "$test_profile" ]; then
    printf '  profile-test  %s（同一套插件 / bundles / patch；依赖 link: 指向本仓库，改完 build 即生效）\n' "$tpdir"
fi)
后续步骤
  1) 核对组合树：dsh --profile $profile_name --dump-config
  2) 启动：      dsh --profile $profile_name
  3) 会话内：    /permission 看权限预设
$(if [ -n "$test_profile" ]; then
    printf '  4) 开发验证：  dsh --profile %s（改完 npm run build 即生效，无需重装）\n' "$test_profile"
    printf '  5) 同步到主 profile：sh scripts/install.sh --profile %s --sync（重跑 pnpm install 刷新快照）\n' "$profile_name"
else
    printf '  4) 改插件后：  npm run build，然后重跑 sh scripts/install.sh --profile %s --sync 刷新快照\n' "$profile_name"
fi)
提示
  - 配置（provider/凭据/插件配置）由宿主按「profile 插件条目 id」命名空间写入 profile 的
    cordis.patch.yml；0.1.7 起 $dsh_home/settings.yaml 仅作一次性导入（自动改名 .imported）。
    本脚本不动这两处文件。
  - 本项目只用 TUI：agent 面走 profile 全局组合，不配置 agent preset；TUI 的 /preset
    提示「agent 预设服务不可用」属正常（依据见 docs/host/AGENT-COMPOSITION.md）。
  - 收尾自检代跑 dsh --profile <名字> --dump-config（dsh 会物化 cordis.yml 等派生文件）；
    「未命中条目 id」等 patch 告警见上方输出，修正后重跑；--skip-verify 可跳过自检。
EOF
