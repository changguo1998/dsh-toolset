#!/usr/bin/env sh
# 新机器安装脚本：装 dsh → 构建本项目插件 → 配 profile（插件挂载）。
#
# 默认值：profile 名 fff、dsh 版本 0.2.0-rc.2、插件取 canonical_pkgs 全部包。
# 本项目只用 TUI：agent 面由 profile 全局组合提供，脚本不配置 agent preset
# （说明见 docs/host/AGENT-COMPOSITION.md）。
# 幂等：已存在的 profile 配置文件默认原样保留（--force 才覆盖，且先备份
# `.bak.<时间戳>`）；只写 $DSH_HOME（默认 ~/.dsh）下的 profile 目录与本仓库，
# 不 sudo、不动系统路径、不改 settings.yaml。
#
# 用法：scripts/install.sh [选项]（见 --help）
set -eu

dsh_version_default="0.2.0-rc.2"
profile_name="fff"
plugins_sel="all"
skip_dsh=0
skip_build=0
force=0
sync=0
dry_run=0

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
profile_asset_dir="$repo_root/profiles/example"
# 插件处理顺序（与根 package.json 的 check/build 顺序一致；子包名从各自 package.json 读）
canonical_pkgs="TUI herdr-integration knowledge-base task-engine ast-tools md-logic md-map fs-digest goal-contract hash-edit metric-loop output-compress security-guard code-map context-report rule-engine symbol-normalizer session-channel session-title-cutoff command-template"

usage() {
    cat << 'EOF'
用法：scripts/install.sh [选项]

  --profile <名字>      dsh profile 名（默认 fff）
  --plugins <列表|all>  要装的插件目录名，逗号或空格分隔（默认 all = canonical_pkgs 全部包）
  --dsh-version <版本>  安装的 dsh 版本（默认 0.2.0-rc.2）
  --skip-dsh            不安装 / 不校验 dsh（假设 PATH 上已有）
  --skip-build          跳过插件的 npm install 与 build（复用已有 dist/）
  --force               覆盖已存在的 profile 配置文件（覆盖前备份）
  --sync                更新已存在的 profile：合并式补挂本仓库插件、必要时禁用官方
                        all-prompts 标题 provider（追加 patch 片段），再跑 pnpm install
  --dry-run             只打印将要执行的操作，不落盘
  -h, --help            显示本帮助

环境变量：DSH_HOME 覆盖 Harness home（默认 ~/.dsh）；请勿在 dsh 运行中执行
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
    # 覆盖前备份（dry-run 不落盘）
    [ -e "$1" ] || return 0
    if [ "$dry_run" = 1 ]; then
        printf '[dry-run] 备份 %s -> %s.bak.<时间戳>\n' "$1" "$1"
    else
        cp -p "$1" "$1.bak.$(date +%s)"
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
        --dry-run)
            dry_run=1
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
if [ "$plugins_sel" = "all" ]; then
    selected="$canonical_pkgs"
else
    selected="$(printf '%s' "$plugins_sel" | tr ',' ' ')"
fi
final=""
for d in $selected; do
    if [ ! -d "$repo_root/$d" ]; then
        die "--plugins 里的 $d 不是本仓库的子包目录"
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
    for d in $final; do
        if [ ! -d "$repo_root/$d/node_modules" ]; then
            # npm 不支持 `link:` 协议（code-map → ast-tools、md-map → md-logic）：这些包改用 pnpm
            if grep -q '"link:' "$repo_root/$d/package.json"; then
                if command -v pnpm >/dev/null 2>&1; then
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
        log "构建：$d"
        run_in "$repo_root/$d" npm run build
        if [ "$dry_run" != 1 ] && [ ! -d "$repo_root/$d/dist" ]; then
            warn "$d 构建后仍无 dist/，挂载后可能加载失败"
        fi
    done
fi

# ── 4/5 配置 profile ────────────────────────────────────────────────────────
log "4/5 配置 profile"
pdir="$dsh_home/profiles/$profile_name"
if [ -e "$pdir" ] && [ ! -d "$pdir" ]; then
    die "$pdir 已存在且不是目录，请先移走或换个 profile 名"
fi
run mkdir -p "$pdir"
manifest="$pdir/package.json"
# 生成 profile 清单：dependencies 用 link: 指向本仓库，bundles 声明要加载的层。
render_manifest() {
    printf '{\n'
    printf '  "name": "dsh-profile-%s",\n' "$profile_name"
    printf '  "private": true,\n'
    printf '  "dependencies": {\n'
    first=1
    for d in $final; do
        [ "$first" = 1 ] || printf ',\n'
        printf '    "%s": "link:%s/%s"' "$(pkg_name "$d")" "$repo_root" "$d"
        first=0
    done
    printf '\n  },\n'
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
        backup "$manifest"
        node -e '
const fs = require("fs");
const [file, repoRoot, prefix, ...dirs] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const ours = new Set();
manifest.dependencies ??= {};
for (const dir of dirs) {
  const pkg = JSON.parse(fs.readFileSync(`${repoRoot}/${dir}/package.json`, "utf8"));
  ours.add(pkg.name);
  manifest.dependencies[pkg.name] = `link:${repoRoot}/${dir}`;
}
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
const existing = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
const extras = existing.filter((name) => !ours.has(name) && name !== "@deepseek-ai/dsh-base");
manifest.dsh.profile.bundles = ["@deepseek-ai/dsh-base", ...dirs.map((dir) => {
  const pkg = JSON.parse(fs.readFileSync(`${repoRoot}/${dir}/package.json`, "utf8"));
  return pkg.name;
}), ...extras];
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
' "$manifest" "$repo_root" link $final ||
            die "合并更新 $manifest 失败"
        log "已更新 $manifest（bundle 数：$(printf '%s' "$final" | wc -w) + dsh-base + 已保留的额外 bundle）"
    fi
elif [ -f "$manifest" ] && [ "$force" != 1 ]; then
    log "保留已有 $manifest（--force 覆盖 / --sync 合并更新）"
elif [ "$dry_run" = 1 ]; then
    printf '[dry-run] 写入 %s：\n' "$manifest"
    render_manifest
else
    backup "$manifest"
    render_manifest > "$manifest"
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$manifest" ||
        die "生成的 $manifest 不是合法 JSON"
    log "写入 $manifest（bundle 数：$(printf '%s' "$final" | wc -w) + dsh-base）"
fi
for asset in pnpm-workspace.yaml cordis.patch.yml; do
    target="$pdir/$asset"
    if [ -f "$target" ] && [ "$force" != 1 ]; then
        log "保留已有 $target（--force 可覆盖）"
        continue
    fi
    backup "$target"
    run cp "$profile_asset_dir/$asset" "$target"
done
# --sync：既有 profile 若挂了官方 all-prompts 标题 provider，追加禁用片段（幂等：带标记跳过）。
# 宿主只允许一个标题 provider；本仓库 session-title-cutoff 接管后必须禁用官方实现。
patch_file="$pdir/cordis.patch.yml"
if [ "$sync" = 1 ] && [ -f "$patch_file" ]; then
    if grep -q "session-title-cutoff 接管标题 provider" "$patch_file"; then
        log "标题 provider 禁用片段已存在，跳过"
    elif grep -v '^[[:space:]]*#' "$patch_file" | grep -q "dsh-session-title-all-prompts-llm"; then
        if [ "$dry_run" = 1 ]; then
            printf '[dry-run] 追加禁用片段到 %s\n' "$patch_file"
        else
            backup "$patch_file"
            cat >> "$patch_file" << 'EOF'

# 追加（scripts/install.sh --sync）：session-title-cutoff 接管标题 provider 后，禁用官方
# all-prompts 实现（宿主 ctx.sessionTitle 只允许注册一个 provider，二次注册会抛错）。
- id: session-title-all-prompts-llm
  disabled: true
EOF
            log "已追加：禁用官方 all-prompts 标题 provider"
            # 顺手把官方条目的 provider/model 复制给本仓库实现（all-prompts 在首条消息时
            # 可能尚无「已记录路由」，显式配对最稳）。仅当原条目同时给出两者时才生成覆盖块。
            title_provider="$(awk '/dsh-session-title-all-prompts-llm/{f=1} f&&/^[[:space:]]*provider:/{print $2; exit}' "$patch_file")"
            title_model="$(awk '/dsh-session-title-all-prompts-llm/{f=1} f&&/^[[:space:]]*model:/{print $2; exit}' "$patch_file")"
            if [ -n "$title_provider" ] && [ -n "$title_model" ]; then
                cat >> "$patch_file" << EOF

# 由 install.sh --sync 复制自官方 all-prompts 条目：显式路由（provider/model 必须成对）。
- id: session-title-cutoff
  config:
    provider: $title_provider
    model: $title_model
EOF
                log "已追加：session-title-cutoff 显式路由（provider=$title_provider model=$title_model）"
            else
                warn "未能在官方 all-prompts 条目中读到 provider/model；请手工为 session-title-cutoff 配置（否则首条消息可能因无已记录路由失败）"
            fi
        fi
    else
        log "profile 未挂载官方 all-prompts 标题 provider（跳过：无需禁用；如你另行挂载，请手工加 disabled: true 或重跑 --sync）"
    fi
fi
case " $final " in
    *" TUI "*) ;;
    *) warn "未选中 TUI：profiles/example/cordis.patch.yml 里针对 - id: tui 的配置会被跳过（启动日志有 patch 告警）" ;;
esac
case " $final " in
    *" knowledge-base "*) ;;
    *) warn "未选中 knowledge-base：profiles/example/cordis.patch.yml 里针对 - id: knowledge-base 的配置会被跳过" ;;
esac
log "profile 依赖：pnpm install（全部为 link: 本地包，无需联网下载本项目插件）"
run_in "$pdir" pnpm install
if [ "$dry_run" != 1 ]; then
    for d in $final; do
        [ -e "$pdir/node_modules/$(pkg_name "$d")" ] || warn "$pdir/node_modules 下缺少 $(pkg_name "$d")，启动前请手动 pnpm install"
    done
fi

# ── 5/5 完成 ────────────────────────────────────────────────────────────────
log "5/5 完成"
cat << EOF

安装结果
  dsh           $(if have dsh; then dsh --version 2> /dev/null || echo "已装"; else echo "需重开终端"; fi)（目标 $dsh_version_default）
  profile       $pdir（$(printf '%s' "$final" | wc -w) 个插件 + dsh-base；插件以 link: 指向本仓库）

后续步骤
  1) 核对组合树：dsh --profile $profile_name --dump-config
  2) 启动：      dsh --profile $profile_name
  3) 会话内：    /permission 看权限预设（含 full-ask）
  4) 改插件后：  npm run build（无需重跑 pnpm install，link: 依赖经 symlink 实时生效）

提示
  - 配置（provider/凭据/插件配置）由宿主按「profile 插件条目 id」命名空间写入 profile 的
    cordis.patch.yml；0.1.7 起 $dsh_home/settings.yaml 仅作一次性导入（自动改名 .imported）。
    本脚本不动这两处文件。
  - 本项目只用 TUI：agent 面走 profile 全局组合，不配置 agent preset；TUI 的 /preset
    提示「agent 预设服务不可用」属正常（依据见 docs/host/AGENT-COMPOSITION.md）。
  - 若退出码非零或启动报 patch 告警，多半是 profile 的 cordis.patch.yml 引用了未安装的条目 id。
EOF
