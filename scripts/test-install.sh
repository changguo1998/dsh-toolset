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
assert_not_contains() { # assert_not_contains <文件> <固定串> <说明>
    if grep -qF -- "$2" "$1"; then
        fail "$3（不应包含：$2；文件 $1）"
    else
        checks=$((checks + 1))
    fi
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
assert_generated_count_eq() { # 同 assert_active_count_eq，但只数**生成区**（首个 sentinel 起至文件尾）：示例 patch 自带的活跃行不干扰
    checks=$((checks + 1))
    n="$(awk '/^# install\.sh generated: title-takeover-/{f=1} f' "$1" | grep -v '^[[:space:]]*#' | grep -c -F -- "$2" || true)"
    [ "$n" = "$3" ] || fail "$4（$1 的生成区内「$2」出现 $n 次；期望 $3）"
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
install_expect_fail() { # install_expect_fail <期望文案> [install.sh 选项...]：断言失败且输出含文案
    expect="$1"
    shift
    if PATH="$fakebin:$PATH" DSH_HOME="$home" sh "$repo_root/scripts/install.sh" \
        --skip-dsh --skip-build "$@" > "$lastlog" 2>&1; then
        cat "$lastlog" >> "$log"
        fail "install.sh $* 应当失败但退出 0"
    fi
    cat "$lastlog" >> "$log"
    assert_log_contains "$expect" "失败文案含「$expect」"
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

# 5b）包改名残留（独立 profile）：旧名（依赖值仍 link: 指向本仓库）按本仓条目移除，
#     不被当成「用户自加」保留；同一轮里真·用户自加 bundle 仍保留
rpdir="$home/profiles/trename"
rmanifest="$rpdir/package.json"
install_ --plugins "TUI ponytail" --profile trename
node -e '
const fs = require("fs");
const file = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.dependencies["@dsh-toolset/ponytail-old"] = manifest.dependencies["@dsh-toolset/ponytail"];
delete manifest.dependencies["@dsh-toolset/ponytail"];
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.map((name) =>
  name === "@dsh-toolset/ponytail" ? "@dsh-toolset/ponytail-old" : name,
);
manifest.dsh.profile.bundles.push("some-third-party-bundle");
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
' "$rmanifest"
install_ --plugins "TUI ponytail" --profile trename --sync
assert_not_contains "$rmanifest" '@dsh-toolset/ponytail-old' "改名残留（依赖 + bundle）被移除"
assert_contains "$rmanifest" '"@dsh-toolset/ponytail"' "当前名照常挂载"
assert_contains "$rmanifest" '"some-third-party-bundle"' "真·用户自加 bundle 仍保留"

# 6）--force 且内容有变：备份 1 份并覆盖
install_ --plugins "TUI ponytail" --force
assert_eq "$(count_glob "$pdir" 'package.json.bak.*')" 2 "--force 内容有变时备份 1 份"

# 7）标题 provider 接管（生成区口径）：--sync 单独绝不改写 patch（只提示）；
#    --take-over-title 按 patch 内容补齐生成区（禁用块 / 路由块 / sentinel）：
#    取值限定在命中条目块内、id 取自条目本身，取值失败可重试、旧标记行流量清理
tguard="$home/profiles/tguard"
install_ --plugins "TUI session-title-cutoff" --profile tguard
tpatch="$tguard/cordis.patch.yml"
cat >> "$tpatch" << 'EOF'

# 注释里的旧引用（旧 awk 会以它为起点、取到下面注释里的 bogus 值）：
#   - name: '@deepseek-ai/dsh-session-title-all-prompts-llm'
#     config:
#       provider: bogus
#       model: bogus-model
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

# 7b）带开关：补禁用块 + 路由（取活跃条目的值，不取注释里的 bogus）+ 两段 sentinel，备份 1 份
install_ --plugins "TUI session-title-cutoff" --profile tguard --sync --take-over-title
assert_generated_count_eq "$tpatch" 'disabled: true' 1 "守卫：补 1 处禁用块"
assert_count_eq "$tpatch" 'provider: bogus' 1 "守卫：未把注释里的 bogus 值复制进来（仍只 1 处注释）"
assert_count_eq "$tpatch" 'provider: ustc' 2 "守卫：复制活跃条目的 provider（原条目 + 路由）"
assert_count_eq "$tpatch" 'model: deepseek-flash' 2 "守卫：复制活跃条目的 model（原条目 + 路由）"
assert_count_eq "$tpatch" '# install.sh generated: title-takeover-disable v1' 1 "守卫：禁用生成区 sentinel 1 处"
assert_count_eq "$tpatch" '# install.sh generated: title-takeover-route v1' 1 "守卫：路由生成区 sentinel 1 处"
assert_eq "$(count_glob "$tguard" 'cordis.patch.yml.bak.*')" 1 "守卫：补齐时恰好备份 1 份"

# 7c）带开关重跑：字节不变、不新增备份（内容为准幂等）
cp "$tpatch" "$work/tpatch.after"
install_ --plugins "TUI session-title-cutoff" --profile tguard --sync --take-over-title
assert_same_file "$tpatch" "$work/tpatch.after" "守卫：重跑幂等（字节不变）"
assert_eq "$(count_glob "$tguard" 'cordis.patch.yml.bak.*')" 1 "守卫：重跑不新增备份"

# 7d）用户清掉生成区：普通 --sync 仍不改写（只提示）；带开关按内容补回（不重复）
node -e '
const fs = require("fs");
const file = process.argv[1];
const text = fs.readFileSync(file, "utf8");
const head = "# install.sh generated: title-takeover-disable v1";
const i = text.indexOf(head);
if (i < 0) throw new Error("找不到生成区");
fs.writeFileSync(file, text.slice(0, i).replace(/\n+$/, "\n"));
' "$tpatch"
assert_generated_count_eq "$tpatch" 'disabled: true' 0 "守卫：夹具已清掉生成区"
cp "$tpatch" "$work/tpatch.cleaned"
install_ --plugins "TUI session-title-cutoff" --profile tguard --sync
assert_same_file "$tpatch" "$work/tpatch.cleaned" "守卫：清掉生成区后普通 --sync 仍不改写"
install_ --plugins "TUI session-title-cutoff" --profile tguard --sync --take-over-title
assert_generated_count_eq "$tpatch" 'disabled: true' 1 "守卫：带开关按内容补回生成区"
assert_count_eq "$tpatch" '# install.sh generated: title-takeover-disable v1' 1 "守卫：补回后 sentinel 不重复"

# 7e）路由重试：首轮取不到 provider/model → 只补禁用 + warn；补上值后带开关重跑补路由
tretry="$home/profiles/tretry"
install_ --plugins "TUI session-title-cutoff" --profile tretry
rpatch="$tretry/cordis.patch.yml"
cat >> "$rpatch" << 'EOF'

- id: session-title-all-prompts-llm
  name: '@deepseek-ai/dsh-session-title-all-prompts-llm'
EOF
install_ --plugins "TUI session-title-cutoff" --profile tretry --sync --take-over-title
assert_generated_count_eq "$rpatch" 'disabled: true' 1 "守卫：无 provider/model 时仍补禁用"
assert_log_contains "未能在官方 all-prompts 条目块内读到可用的 provider/model" "守卫：取不到值时 warn"
assert_generated_count_eq "$rpatch" '- id: session-title-cutoff' 0 "守卫：首轮不写路由"
# 「用户后来补上取值」：追加一条带官方 name + provider/model 的启用条目
cat >> "$rpatch" << 'EOF'

- id: title-llm-again
  name: '@deepseek-ai/dsh-session-title-all-prompts-llm'
  provider: ustc
  model: deepseek-flash
EOF
install_ --plugins "TUI session-title-cutoff" --profile tretry --sync --take-over-title
assert_generated_count_eq "$rpatch" '- id: session-title-cutoff' 1 "守卫：补齐值后重试补上路由"
assert_contains "$rpatch" 'provider: ustc' "守卫：重试取到 provider"

# 7f）payload id 取自命中条目（自定义 id 不被硬编码覆盖）
tcustom="$home/profiles/tcustom"
install_ --plugins "TUI session-title-cutoff" --profile tcustom
cpatch="$tcustom/cordis.patch.yml"
cat >> "$cpatch" << 'EOF'

- id: my-title-llm
  name: '@deepseek-ai/dsh-session-title-all-prompts-llm'
  provider: ustc
  model: deepseek-flash
EOF
install_ --plugins "TUI session-title-cutoff" --profile tcustom --sync --take-over-title
assert_active_count_eq "$cpatch" '- id: my-title-llm' 2 "守卫：生成区用命中条目的 id（用户 1 + 禁用 1）"
assert_active_count_eq "$cpatch" '- id: session-title-all-prompts-llm' 0 "守卫：不写内置默认 id"

# 7g）前置校验：开关必须挂 cutoff；--sync --force 组合被拒（写盘前）
cp "$tpatch" "$work/tpatch.guard"
install_expect_fail "需要 profile 里挂 session-title-cutoff" --plugins TUI --profile tguard --sync --take-over-title
install_expect_fail "组合不支持" --plugins "TUI session-title-cutoff" --profile tguard --sync --force
assert_same_file "$tpatch" "$work/tpatch.guard" "守卫：两条校验失败都在写盘前（patch 不变）"

# 7h）旧权威标记行（上一版实现）在带开关时被清理；--force 覆盖含生成区的 patch 会告警 + 打印备份路径
tlegacy="$home/profiles/tlegacy"
install_ --plugins "TUI session-title-cutoff" --profile tlegacy
lpatch="$tlegacy/cordis.patch.yml"
node -e '
const fs = require("fs");
const file = process.argv[1];
const text = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, "# install.sh title-takeover marker v1（--take-over-title）：旧版标记\n" + text);
' "$lpatch"
install_ --plugins "TUI session-title-cutoff" --profile tlegacy --sync --take-over-title
assert_count_eq "$lpatch" '# install.sh title-takeover marker v1' 0 "守卫：清理上一版权威标记行"
assert_log_contains "已清理上一版的权威标记行" "守卫：清理有日志"
install_ --plugins "TUI session-title-cutoff" --profile tguard --force
assert_log_contains "标题接管生成区 / 标记会丢失" "守卫：--force 覆盖前告警"
assert_log_contains "已备份：" "守卫：备份打印真实路径"

# 7i）带开关但 patch 无活跃行：不追加；--dry-run + 开关：不改文件
tnoline="$home/profiles/tnoline"
install_ --plugins "TUI session-title-cutoff" --profile tnoline
nfile="$tnoline/cordis.patch.yml"
cp "$nfile" "$work/nfile.before"
install_ --plugins "TUI session-title-cutoff" --profile tnoline --sync --take-over-title
assert_same_file "$nfile" "$work/nfile.before" "守卫：无活跃行时不追加"
install_ --plugins "TUI session-title-cutoff" --profile tnoline --sync --take-over-title --dry-run
assert_same_file "$nfile" "$work/nfile.before" "守卫：--dry-run 不改文件"

# 7j）manifest 依赖键序：字母序（与 pnpm 生成物 / fff 侧约定一致）
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

# 10c）--sync 收窄选择集：按当前选择集移除本仓库条目（依赖 + bundle），非本仓库条目保留
#    注：第 6 步的 --force 会重渲染 package.json（用户自加项按设计丢失），故此处先补回自加项
install_ --plugins "TUI ponytail" --sync
node -e '
const fs = require("fs");
const file = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.dependencies["@deepseek-ai/dsh-session-title-all-prompts-llm"] = "0.2.0-rc.2";
manifest.dsh.profile.bundles.push("@deepseek-ai/dsh-session-title-all-prompts-llm", "some-third-party-bundle");
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
' "$manifest"
install_ --plugins TUI --sync
assert_not_contains "$manifest" '"@dsh-toolset/ponytail"' "--sync 移除已不在选择集的本仓库条目（依赖 / bundle）"
assert_contains "$manifest" '"@deepseek-ai/dsh-session-title-all-prompts-llm"' "--sync 收窄后非本仓库依赖仍保留"
assert_contains "$manifest" '"some-third-party-bundle"' "--sync 收窄后非本仓库 bundle 仍保留"
assert_log_contains "已按当前选择集移除本仓库条目：bundle [@dsh-toolset/ponytail]" "收窄时打移除日志并列明移除名单"

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
