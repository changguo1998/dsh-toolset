#!/usr/bin/env python3
"""输出 East_Asian_Width 区间 JSON（供 scripts/gen-width-table.mts 生成 TS 宽度表）。

Python 的 unicodedata 提供 EAW（UAX #11）但不提供 emoji 属性；Node 反之。
故 EAW 侧由本脚本 dump，emoji 侧在 Node 脚本里判定，最终表由 Node 生成。

用法：python3 TUI/scripts/eaw-dump.py   # stdout: {"unicode":"15.0.0","wide":[...],"ambiguous":[...]}
"""

import json
import unicodedata as u


def build(pred) -> list[list[int]]:
    """遍历全部码点，收集满足 pred 的连续区间（跳过未分配码点）。"""
    ranges: list[list[int]] = []
    start = prev = None
    for cp in range(0x110000):
        ch = chr(cp)
        hit = False if u.category(ch) == "Cn" else pred(u.east_asian_width(ch))
        if hit:
            if start is None:
                start = cp
            elif cp != prev + 1:
                ranges.append([start, prev])
                start = cp
            prev = cp
        elif start is not None:
            ranges.append([start, prev])
            start = None
    if start is not None:
        ranges.append([start, prev])
    return ranges


print(
    json.dumps(
        {
            "unicode": u.unidata_version,
            "wide": build(lambda w: w in ("W", "F")),
            "ambiguous": build(lambda w: w == "A"),
        },
        separators=(",", ":"),
    )
)
