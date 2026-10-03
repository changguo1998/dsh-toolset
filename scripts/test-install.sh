#!/usr/bin/env sh
# install.sh 的回归测试：验证「内容未变则不写、不备份」等幂等行为。
# 无副作用：只写临时 DSH_HOME（mktemp -d），不动真实 profile、不改仓库。
# 用法：sh scripts/test-install.sh
set -eu

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
home="$work/home"
fakebin="$work/bin"
log="$work/install.log"
mkdir -p "$home" "$fakebin"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT INT TERM

# 假 pnpm：install.sh 只要求 pnpm 存在、并能在 profile 目录里执行 install
printf '#!/bin/sh\nexit 0\n' > "$fakebin/pnpm"
chmod +x "$fakebin/pnpm"

checks=0
fail() {
    printf '[test-install] 失败：%s\n' "$1" >&2
    printf '%s\n' '--- install.sh 输出 ---' >&2
    cat "$log" >&2 || true
    exit 1
}
assert_eq() { # assert_eq <实际> <期望> <说明>
    checks=$((checks + 1))
    [ "$1" = "$2" ] || fail "$3（实际：$1；期望：$2）"
    printf '[test-install] 通过：%s\n' "$3"
}
assert_contains() { # assert_contains <文件> <固定串> <说明>
    checks=$((checks + 1))
    grep -q -F -- "$2" "$1" || fail "$3（$1 中未找到「$2」）"
    printf '[test-install] 通过：%s\n' "$3"
}
count_glob() { # count_glob <目录> <通配模式>
    n=0
    for f in "$1"/$2; do
        [ -e "$f" ] && n=$((n + 1))
    done
    printf '%s' "$n"
}
install_() { # install_ [install.sh 选项...]
    PATH="$fakebin:$PATH" DSH_HOME="$home" sh "$repo_root/scripts/install.sh" \
        --skip-dsh --skip-build "$@" >> "$log" 2>&1 || fail "install.sh $* 退出非 0"
}

pdir="$home/profiles/fff"
manifest="$pdir/package.json"
: > "$log"

# 1）首次安装：不产生备份
install_ --plugins TUI
assert_eq "$(count_glob "$pdir" '*.bak.*')" 0 "首次安装不产生备份"

# 2）--sync 连跑两次：清单内容未变，不写、不备份
install_ --plugins TUI --sync
install_ --plugins TUI --sync
assert_eq "$(count_glob "$pdir" '*.bak.*')" 0 "--sync 连跑两次不新增备份"

# 3）--force 且内容未变：同样不备份
install_ --plugins TUI --force
assert_eq "$(count_glob "$pdir" '*.bak.*')" 0 "--force 同内容不新增备份"

# 4）--dry-run：不改动 profile 目录
before="$(ls -1 "$pdir")"
install_ --plugins TUI --sync --dry-run
assert_eq "$(ls -1 "$pdir")" "$before" "--dry-run 不改动 profile 目录"

# 5）内容确有变化：备份 1 份、再跑不增；用户自加依赖 / bundle 保留
node -e '
const fs = require("fs");
const file = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.dependencies["@deepseek-ai/dsh-session-title-all-prompts-llm"] = "0.2.0-rc.2";
manifest.dsh.profile.bundles.push("@deepseek-ai/dsh-session-title-all-prompts-llm", "some-third-party-bundle");
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
' "$manifest"
install_ --plugins "TUI ponytail" --sync
assert_contains "$manifest" '"@dsh-toolset/ponytail"' "合并补挂 ponytail"
assert_contains "$manifest" '"@deepseek-ai/dsh-session-title-all-prompts-llm"' "用户自加依赖保留"
assert_contains "$manifest" '"some-third-party-bundle"' "用户自加 bundle 保留"
assert_eq "$(count_glob "$pdir" 'package.json.bak.*')" 1 "内容有变化时产生 1 份备份"
install_ --plugins "TUI ponytail" --sync
assert_eq "$(count_glob "$pdir" 'package.json.bak.*')" 1 "再跑 --sync 不再新增备份"

# 6）--force 且内容有变：备份 1 份并覆盖
install_ --plugins "TUI ponytail" --force
assert_eq "$(count_glob "$pdir" 'package.json.bak.*')" 2 "--force 内容有变时备份 1 份"

# 7）标题 provider 追加：首轮备份 1 份，次轮不重复
cat >> "$pdir/cordis.patch.yml" << 'EOF'

- id: session-title-all-prompts-llm
  name: '@deepseek-ai/dsh-session-title-all-prompts-llm'
  provider: ustc
  model: deepseek-flash
EOF
install_ --plugins "TUI ponytail" --sync
assert_eq "$(count_glob "$pdir" 'cordis.patch.yml.bak.*')" 1 "标题守卫追加时备份 1 份"
assert_eq "$(grep -c -F 'session-title-cutoff 接管标题 provider' "$pdir/cordis.patch.yml" || true)" 1 "幂等 marker 只出现一次"
assert_contains "$pdir/cordis.patch.yml" 'provider: ustc' "复制标题 provider 路由"
assert_contains "$pdir/cordis.patch.yml" 'model: deepseek-flash' "复制标题 model 路由"
install_ --plugins "TUI ponytail" --sync
assert_eq "$(count_glob "$pdir" 'cordis.patch.yml.bak.*')" 1 "再跑 --sync 不重复追加"

# 8）收尾：备份总数符合预期、无临时文件残留
assert_eq "$(count_glob "$pdir" '*.bak.*')" 3 "备份总数 3 份（清单 2 + patch 1）"
assert_eq "$(count_glob "$pdir" '*.tmp.*')" 0 "无临时文件残留"

printf '[test-install] 全部 %s 项通过\n' "$checks"
