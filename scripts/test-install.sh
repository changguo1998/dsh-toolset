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
lastlog="$work/last.log"
mkdir -p "$home" "$fakebin"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT INT TERM

# 假 pnpm：install.sh 只要求 pnpm 存在、并能在 profile 目录里执行 install
printf '#!/bin/sh\nexit 0\n' > "$fakebin/pnpm"
chmod +x "$fakebin/pnpm"
# 假 dsh：--version 给固定宿主版本；--dump-config 默认成功且无告警（收尾自检用）
fake_dsh_ok() {
    printf '#!/bin/sh\ncase "$*" in\n*--dump-config*) exit 0 ;;\n*) echo 0.2.0-rc.2 ;;\nesac\n' > "$fakebin/dsh"
    chmod +x "$fakebin/dsh"
}
fake_dsh_dump() { # fake_dsh_dump <stderr 文本> <退出码>：--dump-config 时输出该文本并退出
    printf '#!/bin/sh\ncase "$*" in\n*--dump-config*) printf "%%s\\n" "%s" >&2; exit %s ;;\n*) echo 0.2.0-rc.2 ;;\nesac\n' "$1" "$2" > "$fakebin/dsh"
    chmod +x "$fakebin/dsh"
}
fake_dsh_ok

checks=0
fail() {
    printf '[test-install] 失败：%s\n' "$1" >&2
    printf '%s\n' '--- 最近一次 install.sh 输出 ---' >&2
    cat "$lastlog" >&2 || true
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
assert_log_contains() { # assert_log_contains <固定串> <说明>：断言最近一次 install.sh 输出
    checks=$((checks + 1))
    grep -q -F -- "$1" "$lastlog" || fail "$2（最近输出中未找到「$1」）"
    printf '[test-install] 通过：%s\n' "$2"
}
assert_log_not_contains() { # assert_log_not_contains <固定串> <说明>
    checks=$((checks + 1))
    if grep -q -F -- "$1" "$lastlog"; then
        fail "$2（最近输出中出现不应有的「$1」）"
    fi
    printf '[test-install] 通过：%s\n' "$2"
}
count_glob() { # count_glob <目录> <通配模式>
    n=0
    for f in "$1"/$2; do
        [ -e "$f" ] && n=$((n + 1))
    done
    printf '%s' "$n"
}
assert_same_file() { # assert_same_file <文件> <快照> <说明>：字节级不变（cmp）
    checks=$((checks + 1))
    cmp -s "$1" "$2" || fail "$3（$1 与快照不一致：$(diff "$2" "$1" | head -5)）"
    printf '[test-install] 通过：%s\n' "$3"
}
assert_count_eq() { # assert_count_eq <文件> <固定串> <期望次数> <说明>
    checks=$((checks + 1))
    n="$(grep -c -F -- "$2" "$1" || true)"
    [ "$n" = "$3" ] || fail "$4（$1 中「$2」出现 $n 次；期望 $3）"
    printf '[test-install] 通过：%s\n' "$4"
}
assert_active_count_eq() { # 同 assert_count_eq，但只数**非注释行**（示例 patch 里有注释掉的行）
    checks=$((checks + 1))
    n="$(grep -v '^[[:space:]]*#' "$1" | grep -c -F -- "$2" || true)"
    [ "$n" = "$3" ] || fail "$4（$1 的非注释行中「$2」出现 $n 次；期望 $3）"
    printf '[test-install] 通过：%s\n' "$4"
}
install_() { # install_ [install.sh 选项...]；最近一次输出落 $lastlog
    PATH="$fakebin:$PATH" DSH_HOME="$home" sh "$repo_root/scripts/install.sh" \
        --skip-dsh --skip-build "$@" > "$lastlog" 2>&1 || {
        cat "$lastlog" >> "$log"
        fail "install.sh $* 退出非 0"
    }
    cat "$lastlog" >> "$log"
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

# 7）标题 provider 守卫：--sync 单独不改写 patch（只提示）；显式 --take-over-title 才追加；
#    幂等 marker 在文件头（清理追加块后仍幂等）；旧标记走迁移（只补文件头 marker）
tguard="$home/profiles/tguard"
install_ --plugins "TUI session-title-cutoff" --profile tguard
tpatch="$tguard/cordis.patch.yml"
cat >> "$tpatch" << 'EOF'

- id: session-title-all-prompts-llm
  name: '@deepseek-ai/dsh-session-title-all-prompts-llm'
  config:
    provider: ustc
    model: deepseek-flash
EOF
cp "$tpatch" "$work/tpatch.before"

# 7a）不带开关：只提示、patch 字节不变、不产生 patch 备份
install_ --plugins "TUI session-title-cutoff" --profile tguard --sync
assert_same_file "$tpatch" "$work/tpatch.before" "守卫：不带 --take-over-title 不改写 patch"
assert_eq "$(count_glob "$tguard" 'cordis.patch.yml.bak.*')" 0 "守卫：不改写也不备份"
assert_log_contains "--take-over-title" "守卫：提示给出 --take-over-title 出路"

# 7b）带开关：追加禁用块 + 路由块 + 文件头 marker，备份 1 份
install_ --plugins "TUI session-title-cutoff" --profile tguard --sync --take-over-title
assert_active_count_eq "$tpatch" '- id: session-title-all-prompts-llm' 2 "守卫：追加禁用块（用户 1 + 禁用 1）"
assert_active_count_eq "$tpatch" 'disabled: true' 1 "守卫：禁用块 1 处"
assert_contains "$tpatch" 'provider: ustc' "守卫：复制 provider 路由"
assert_contains "$tpatch" 'model: deepseek-flash' "守卫：复制 model 路由"
assert_count_eq "$tpatch" 'title-takeover marker v1' 1 "守卫：文件头 marker 恰 1 行"
assert_eq "$(head -n 1 "$tpatch" | grep -c -F 'title-takeover marker v1' || true)" 1 "守卫：marker 在文件头（第 1 行）"
assert_eq "$(count_glob "$tguard" 'cordis.patch.yml.bak.*')" 1 "守卫：追加时恰好备份 1 份"

# 7c）带开关重跑：字节不变、不新增备份
cp "$tpatch" "$work/tpatch.after"
install_ --plugins "TUI session-title-cutoff" --profile tguard --sync --take-over-title
assert_same_file "$tpatch" "$work/tpatch.after" "守卫：重跑幂等（字节不变）"
assert_eq "$(count_glob "$tguard" 'cordis.patch.yml.bak.*')" 1 "守卫：重跑不新增备份"

# 7d）幂等不依赖被保护片段：清掉追加块（保留文件头 marker）后重跑，不重复追加
node -e '
const fs = require("fs");
const file = process.argv[1];
const text = fs.readFileSync(file, "utf8");
const head = "# 追加（scripts/install.sh --sync --take-over-title）";
const i = text.indexOf(head);
if (i < 0) throw new Error("找不到追加块表头");
fs.writeFileSync(file, text.slice(0, i).replace(/\n+$/, "\n"));
' "$tpatch"
assert_active_count_eq "$tpatch" 'disabled: true' 0 "守卫：夹具已清掉追加块"
assert_count_eq "$tpatch" 'title-takeover marker v1' 1 "守卫：清理后 marker 仍在"
cp "$tpatch" "$work/tpatch.cleaned"
install_ --plugins "TUI session-title-cutoff" --profile tguard --sync --take-over-title
assert_same_file "$tpatch" "$work/tpatch.cleaned" "守卫：marker 独立于片段（清理片段后仍幂等）"

# 7e）旧标记（标记在被保护片段内）：普通 --sync 不改字节；带开关只补文件头 marker
tlegacy="$home/profiles/tlegacy"
install_ --plugins "TUI session-title-cutoff" --profile tlegacy
lpatch="$tlegacy/cordis.patch.yml"
cat >> "$lpatch" << 'EOF'

- id: session-title-all-prompts-llm
  disabled: true
# 追加（scripts/install.sh --sync）：session-title-cutoff 接管标题 provider 后，禁用官方
EOF
cp "$lpatch" "$work/lpatch.before"
install_ --plugins "TUI session-title-cutoff" --profile tlegacy --sync
assert_same_file "$lpatch" "$work/lpatch.before" "守卫：旧标记存在时普通 --sync 不改字节"
install_ --plugins "TUI session-title-cutoff" --profile tlegacy --sync --take-over-title
assert_count_eq "$lpatch" 'title-takeover marker v1' 1 "守卫：旧标记迁移补文件头 marker"
assert_active_count_eq "$lpatch" 'disabled: true' 1 "守卫：迁移不重复追加 payload"

# 7f）带开关但 patch 无活跃行：不追加；--dry-run + 开关：不改文件
tnoline="$home/profiles/tnoline"
install_ --plugins "TUI session-title-cutoff" --profile tnoline
nfile="$tnoline/cordis.patch.yml"
cp "$nfile" "$work/nfile.before"
install_ --plugins "TUI session-title-cutoff" --profile tnoline --sync --take-over-title
assert_same_file "$nfile" "$work/nfile.before" "守卫：无活跃行时不追加"
install_ --plugins "TUI session-title-cutoff" --profile tnoline --sync --take-over-title --dry-run
assert_same_file "$nfile" "$work/nfile.before" "守卫：--dry-run 不改文件"

# 7g）manifest 依赖键序：字母序（与 pnpm 生成物 / fff 侧约定一致）
if node -e '
const fs = require("fs");
const deps = Object.keys(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dependencies);
for (let i = 1; i < deps.length; i += 1) {
  if (!(deps[i - 1] < deps[i])) {
    console.error(`键序不对：${deps[i - 1]} >= ${deps[i]}`);
    process.exit(1);
  }
}
' "$manifest"; then
    checks=$((checks + 1))
    printf '[test-install] 通过：%s\n' "manifest 依赖键序为字母序"
else
    fail "manifest 依赖键序应为字母序"
fi

# 8）收尾：备份总数符合预期、无临时文件残留
assert_eq "$(count_glob "$pdir" '*.bak.*')" 2 "备份总数 2 份（清单 2；标题守卫走独立 profile）"
assert_eq "$(count_glob "$pdir" '*.tmp.*')" 0 "无临时文件残留"

# 9）树外官方插件版本检查（独立 profile 夹具，只读）
vdir="$home/profiles/vercheck"
write_vmanifest() { # write_vmanifest <dependencies 的 JSON>
    mkdir -p "$vdir"
    node -e '
const fs = require("fs");
const [file, json] = process.argv.slice(1);
fs.writeFileSync(file, `${JSON.stringify({
  name: "dsh-profile-vercheck",
  private: true,
  dependencies: JSON.parse(json),
}, null, 2)}\n`);
' "$vdir/package.json" "$1"
}
install_v() { install_ --profile vercheck --plugins "TUI ponytail"; }

# 9a）无此类依赖：跳过（不告警）
write_vmanifest '{"@dsh-toolset/tui":"link:/tmp/nowhere"}'
install_v
assert_log_contains "无树外官方插件依赖" "无树外依赖时跳过检查"
assert_eq "$(count_glob "$vdir" '*.bak.*')" 0 "版本检查为只读（无备份产生）"

# 9b）不一致（多条目）：逐条告警 + 精确提示，且不落盘、仍退出 0
write_vmanifest '{"@deepseek-ai/dsh-session-title-all-prompts-llm":"0.1.7-rc.2","@deepseek-ai/dsh-session-stats":"^0.1.0"}'
install_v
assert_log_contains "dsh-session-title-all-prompts-llm：0.1.7-rc.2 → 与宿主不一致" "报出第 1 条不一致"
assert_log_contains "dsh-session-stats：^0.1.0 → 与宿主不一致" "报出第 2 条不一致"
assert_log_contains "cd $vdir && pnpm install" "给出精确修复提示"
assert_eq "$(count_glob "$vdir" '*.bak.*')" 0 "不一致告警不落盘"

# 9c）一致（~ 前缀兼容）
write_vmanifest '{"@deepseek-ai/dsh-session-title-all-prompts-llm":"~0.2.0-rc.2"}'
install_v
assert_log_contains "与宿主 dsh 一致（0.2.0-rc.2）" "~ 前缀下判定一致"
assert_log_not_contains "与宿主不一致" "一致时不告警"

# 9d）非精确版本：单列「无法自动判定」，不给改 pin 的强建议
write_vmanifest '{"@deepseek-ai/dsh-session-title-all-prompts-llm":">=0.2.0"}'
install_v
assert_log_contains "无法自动判定" "非精确版本单列"
assert_log_not_contains "cd $vdir && pnpm install" "非精确版本不给改 pin 提示"

# 9e）link: 值排除（无候选）
write_vmanifest '{"@deepseek-ai/dsh-session-title-all-prompts-llm":"link:../somewhere"}'
install_v
assert_log_contains "无树外官方插件依赖" "link: 值被排除"

# 9f）manifest 解析失败：warn 跳过，退出码仍为 0（install_ 已隐含断言）
printf '{ broken json\n' > "$vdir/package.json"
install_v
assert_log_contains "无法解析" "解析失败时告警跳过"

# 9g）dsh 存在但版本输出为空：告警跳过（「PATH 无 dsh」态受本机真实 dsh 限制，无法安全模拟）
write_vmanifest '{"@deepseek-ai/dsh-session-title-all-prompts-llm":"0.1.7-rc.2"}'
printf '#!/bin/sh\nexit 0\n' > "$fakebin/dsh"
install_v
assert_log_contains "拿不到 dsh --version 输出" "版本取不到时告警跳过"
assert_log_not_contains "与宿主不一致" "版本取不到时不判不一致"
fake_dsh_ok

# 10）收尾自检（--dump-config）：通过 / stderr 告警 / rc≠0 / --skip-verify / --dry-run / 截断
write_vmanifest '{"@deepseek-ai/dsh-session-title-all-prompts-llm":"0.2.0-rc.2"}'

# 10a）通过：rc=0 且 stderr 为空
install_v
assert_log_contains "收尾自检通过" "自检通过输出"
assert_log_not_contains "自检未通过" "通过时不告警"

# 10b）stderr 非空（多行 + % 与反斜杠）：告警，但不改退出码（install_ 已隐含断言）
fake_dsh_dump 'dsh: [patch] entry no-such-id not found
line2: 50% done
line3: back\slash path' 0
install_v
assert_log_contains "收尾自检未通过" "stderr 非空时告警"
assert_log_contains "no-such-id" "stderr 原文透出"
assert_log_contains "50% done" "格式串安全（% 原样）"
assert_log_contains "back\slash path" "转义安全（反斜杠原样）"

# 10c）退出码非 0：告警含退出码
fake_dsh_dump 'boom: dump-config failed' 3
install_v
assert_log_contains "退出码 3" "报出退出码"
assert_log_contains "boom: dump-config failed" "报出错误文本"

# 10d）--skip-verify：跳过且不执行自检（失败态 stub 仍生效）
install_ --profile vercheck --plugins "TUI ponytail" --skip-verify
assert_log_contains "按 --skip-verify 跳过" "skip-verify 生效"
assert_log_not_contains "自检未通过" "skip-verify 下不执行自检"

# 10e）--dry-run：只打印将执行的命令
install_v --dry-run
assert_log_contains "dsh --profile vercheck --dump-config" "dry-run 打印自检命令"
assert_log_not_contains "收尾自检通过" "dry-run 不执行自检"

# 10f）超长 stderr：截到前 20 行并注明
long_msg="$(
    i=1
    while [ "$i" -le 25 ]; do
        printf 'err line %s\n' "$i"
        i=$((i + 1))
    done
)"
fake_dsh_dump "$long_msg" 0
install_v
assert_log_contains "仅显示前 20 行" "超长 stderr 有截断提示"
assert_log_contains "err line 20" "截断保留前 20 行"
assert_log_not_contains "err line 21" "截断丢弃后续行"

fake_dsh_ok

# 11）接线一致性：canonical_pkgs ←→ 根 check/build 链、test-parallel.sh default_pkgs
canonical="$(sed -n 's/^canonical_pkgs="\(.*\)"$/\1/p' "$repo_root/scripts/install.sh")"
[ -n "$canonical" ] || fail "无法从 install.sh 提取 canonical_pkgs（sed 模式失效？）"
default_pkgs="$(sed -n 's/^default_pkgs="\(.*\)"$/\1/p' "$repo_root/scripts/test-parallel.sh")"
[ -n "$default_pkgs" ] || fail "无法从 test-parallel.sh 提取 default_pkgs（sed 模式失效？）"
assert_eq "$canonical" "$default_pkgs" "canonical_pkgs 与 test-parallel.sh default_pkgs 同序"
consistency="$(node -e '
const fs = require("fs");
const [pkgJson, canonical] = process.argv.slice(1);
const scripts = JSON.parse(fs.readFileSync(pkgJson, "utf8")).scripts;
const extract = (name) => (scripts[name].match(/--prefix (\S+) run /g) || []).map((s) => s.split(" ")[1]);
const check = extract("check");
const build = extract("build");
const canon = canonical.trim().split(/\s+/);
const sorted = (list) => [...new Set(list)].sort();
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const problems = [];
if (!check.length || !build.length) problems.push("check/build 链提取为空");
if (!eq(check, build)) problems.push("check 与 build 不同序");
if (!eq(sorted(check), sorted(canon))) problems.push(`集合不一致：${sorted(check).join(",")} vs ${sorted(canon).join(",")}`);
console.log(problems.length ? problems.join("；") : "ok");
' "$repo_root/package.json" "$canonical")"
assert_eq "$consistency" "ok" "canonical_pkgs 与根 check/build 链一致（集合 + check==build 同序）"
missing=""
for d in $canonical; do
    [ -d "$repo_root/$d" ] || missing="$missing $d"
done
assert_eq "$missing" "" "canonical_pkgs 每个目录都存在"

printf '[test-install] 全部 %s 项通过\n' "$checks"
