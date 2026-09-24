// src/app/clock.ts — 时间戳格式化（P6 实时 step 头与 P9 恢复概要行共用同一口径）
//
// 刻意做成零依赖叶子模块：state → layout/tool-line 已存在引用链，若把助手放 state.ts
// 会让 tool-line 反向依赖 state（成环）。放在 app 根下，两侧各自 import 即可。

/** 时间戳（epoch ms）→ `hh:mm:ss`（本地时区、24 小时制、逐段补零）；
 *  非法值/缺省返回 undefined（调用方自行决定省略时间片段的呈现）。 */
export function clockHms(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
