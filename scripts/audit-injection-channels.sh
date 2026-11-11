#!/usr/bin/env bash
# scripts/audit-injection-channels.sh — 注入三分类落地的机械审计（1110 T1 至 T15）。
#
# 只读；在仓库根执行。每条断言写明任务号与期望值，不符即打印实测值并以 1 退出。
# 用法:
#   bash scripts/audit-injection-channels.sh               # 逐任务断言（默认）
#   AUDIT_FULL=1 bash scripts/audit-injection-channels.sh  # 额外跑全量 check / build / test

set -euo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0

# need <任务号> <说明> <期望值> <实际值>：严格相等
need() {
  if [ "$3" = "$4" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL %s: %s（期望 %s，实际 %s）\n' "$1" "$2" "$3" "$4" >&2
  fi
}

# need_ge <任务号> <说明> <下限> <实际值>：大于等于
need_ge() {
  if [ "$4" -ge "$3" ] 2>/dev/null; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL %s: %s（期望 ≥ %s，实际 %s）\n' "$1" "$2" "$3" "$4" >&2
  fi
}

# count <文件> <固定串>：命中行数（无命中输出 0）
count() {
  local n
  n=$(grep -cF -- "$2" "$1" 2>/dev/null || true)
  printf '%s' "${n:-0}"
}

# count_re <文件> <正则>：命中行数（无命中输出 0）
count_re() {
  local n
  n=$(grep -cE -- "$2" "$1" 2>/dev/null || true)
  printf '%s' "${n:-0}"
}

# files_with <目录> <正则>：含匹配的文件数
files_with() {
  local n
  n=$(grep -rlE -- "$2" "$1" 2>/dev/null | wc -l | tr -d ' ')
  printf '%s' "${n:-0}"
}

# ---- T1 pin-note 服务面 hold ----
need_ge T1 'pin-note 有 hold 口' 1 "$(count pin-note/src/index.ts 'hold(')"
need_ge T1 'pin-note 有 release 口' 1 "$(count pin-note/src/index.ts 'release(')"
need_ge T1 'pin-note 测试覆盖 hold' 1 "$(files_with pin-note/tests 'hold')"

# ---- T2 pin-note 多来源折叠 ----
need_ge T2 'pin-note 使用 provider' 1 "$(count pin-note/src/index.ts 'provider')"
need_ge T2 'pin-note 有 compare 注释' 2 "$(count pin-note/src/index.ts 'compare')"
need_ge T2 'pin-note 多来源测试' 1 "$(files_with pin-note/tests '两个 key')"

# ---- T3 symbol-normalizer 静态 section ----
need_ge T3 'symbol-normalizer 注册 section' 1 "$(count_re symbol-normalizer/src/index.ts '\.section\(')"
need T3 'symbol-normalizer 不再引用一次性节点' 0 "$(files_with symbol-normalizer/src 'session-start|step-end|compaction')"

# ---- T4 ponytail 静态 section ----
need_ge T4 'ponytail 注册 section' 1 "$(count_re ponytail/src/index.ts '\.section\(')"
need_ge T4 'ponytail 保留 enabled 开关' 1 "$(count ponytail/src/index.ts 'enabled')"
need T4 'ponytail 不再引用 session-start' 0 "$(files_with ponytail/src 'session-start')"

# ---- T5 term-check 术语表 section ----
need_ge T5 'term-check 注册 section' 1 "$(count_re term-check/src/index.ts '\.section\(')"
need_ge T5 'term-check 保留旧称审查节点' 1 "$(count term-check/src/index.ts 'assistant-text')"
need_ge T5 '术语表 section 含禁止段' 1 "$(count term-check/src/terms.ts '禁止')"

# ---- T6 工具总则登记 ----
need_ge T6 '1111 文档登记工具总则' 1 "$(count docs/implementation/2026-11-11-tool-description-registry.md '工具总则')"
need_ge T6 '1111 文档登记 section 名' 1 "$(count docs/implementation/2026-11-11-tool-description-registry.md 'tool-consult/tool-index')"

# ---- T7 preference-analysis 改 hold ----
need_ge T7 'preference-analysis 登记 preference hold' 1 "$(count preference-analysis/src/index.ts 'hold("preference"')"
need T7 'preference-analysis 不再注册消费者' 0 "$(count_re preference-analysis/src/index.ts 'registerConsumer|CONSUMER_REGISTRATION')"
need T7 'preference-analysis 不再按 session-start 唤醒' 0 "$(files_with preference-analysis/src 'session-start')"

# ---- T8 flow-track 改 hold ----
need_ge T8 'flow-track 登记 flow hold' 1 "$(count flow-track/src/index.ts 'hold("flow"')"
need_ge T8 'flow-track 保留 enabled 门槛' 1 "$(count flow-track/src/index.ts 'enabled')"
need T8 'flow-track 不再按 turn-start 唤醒' 0 "$(files_with flow-track/src 'turn-start')"

# ---- T9 tool-consult 揭示用法 hold ----
need_ge T9 'tool-consult 登记 revealed-tools hold' 1 "$(count tool-consult/src/index.ts 'hold("revealed-tools"')"
need_ge T9 'consult_tools 工具名仍在' 1 "$(count tool-consult/src/aliases.ts 'consult_tools')"
need_ge T9 '1111 文档仍登记工具总则' 1 "$(count docs/implementation/2026-11-11-tool-description-registry.md '工具总则')"

# ---- T10 pin-note 自身要点并入 ----
need T10 'pin_note 工具名唯一' 1 "$(count pin-note/src/tools.ts 'name: "pin_note"')"
need_ge T10 'pin-note 两来源按正文比对' 2 "$(count pin-note/src/index.ts 'compare')"

# ---- T11 rule-engine 文案下沉（选不做） ----
need T11 '未做时 rule-engine 不出现新注册口' 0 "$(count_re rule-engine/src/index.ts 'registerTemplate')"

# ---- T12 README 同步 ----
for term in 静态保持 动态保持 一次性注入; do
  miss=0
  for pkg in pin-note symbol-normalizer ponytail term-check preference-analysis flow-track tool-consult; do
    if [ ! -f "$pkg/README.md" ] || [ "$(count "$pkg/README.md" "$term")" = "0" ]; then
      printf '  缺少「%s」: %s/README.md\n' "$term" "$pkg" >&2
      miss=$((miss + 1))
    fi
  done
  need T12 "七个包 README 均含「$term」" 0 "$miss"
done

# ---- T13 端到端与会话日志断言 ----
need T13 'e2e 用例存在' 1 "$([ -f e2e/injection-channels.test.ts ] && echo 1 || echo 0)"
need_ge T13 'e2e 断言 surface' 1 "$(count e2e/injection-channels.test.ts 'surface')"

# ---- T14 全量与白名单 ----
dirty=$( { git status --porcelain | awk '{print $2}' | grep -vE '^(pin-note|symbol-normalizer|ponytail|term-check|preference-analysis|flow-track|tool-consult|rule-engine|e2e|scripts)/|^docs/(implementation/2026-11-10-injection-inventory|archived/2026-11-09-tool-description-audit|archived/2026-11-10-injection-inventory|implementation/2026-11-11-tool-description-registry)\.md$|^docs/BACKLOG\.md$' || true; } | wc -l | tr -d ' ')
need T14 '改动面限白名单（工作区干净时恒 0）' 0 "${dirty:-0}"
new_names=$( { git diff -U0 | grep -cE '^\+.*name: "' || true; } | tail -1)
need T14 '工具面 name 零新增' 0 "${new_names:-0}"
schema=$( { git diff -U0 | grep -c 'input_schema' || true; } | tail -1)
need T14 'input_schema 零改动' 0 "${schema:-0}"

if [ "${AUDIT_FULL:-0}" = "1" ]; then
  echo '== 全量门禁（check / build / test）' >&2
  pnpm run check >/dev/null
  pnpm run build >/dev/null
  pnpm run test >/dev/null
  pass=$((pass + 1))
else
  echo '提示: 全量门禁未跑（AUDIT_FULL=1 可一并执行 check / build / test）' >&2
fi

if [ "$fail" -ne 0 ]; then
  printf '审计失败: %d 项通过, %d 项失败\n' "$pass" "$fail" >&2
  exit 1
fi
printf '审计通过: %d 项\n' "$pass"
