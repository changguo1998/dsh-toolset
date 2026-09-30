---
name: codebase-audit
description: 代码库审计：按区域并行排查问题 → 汇总清单
input: 审计范围（目录 / 主题，缺省 = 仓库根）
steps:
  - id: plan
    type: agent
    prompt: |
      把审计范围拆成 3-5 个可并行排查的区域或主题（目录 / 关注点），每行一条。
      范围：$ARGUMENTS
  - id: audit
    type: agent
    prompt: |
      按下列区域逐项审计代码（用搜索 / 读取工具取证）：找出真实缺陷、隐患与不一致，
      每条给 文件:行 + 证据 + 严重度（高 / 中 / 低）。
      区域：
      {{plan}}
    bestOf: 3
    judge:
      prompt: 合并三份审计结果：去重、按严重度排序、剔除无法定位证据的条目。
  - id: report
    type: prompt
    prompt: |
      把审计发现整理成清单（按严重度分组），每条一行：`[严重度] 文件:行 — 问题 — 建议`。
      发现：
      {{audit}}
---
