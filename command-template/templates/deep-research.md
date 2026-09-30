---
name: deep-research
description: 多源调研一个主题：并行取证 → 汇总 → 交叉验证
input: 调研主题
steps:
  - id: angles
    type: agent
    prompt: |
      把调研主题拆成 3 个互补的取证角度（例如：官方文档 / 实现细节 / 反例与争议），
      每行一条，只输出角度清单，不要展开。
      主题：$ARGUMENTS
  - id: gather
    type: agent
    prompt: |
      用可用的搜索 / 抓取工具，围绕下列角度取证，每条结论都附来源链接与原文要点。
      角度：
      {{angles}}
      主题：$ARGUMENTS
    bestOf: 3
    judge:
      prompt: 合并三份取证结果：去重、标注冲突、保留所有带来源的结论。
  - id: report
    type: agent
    prompt: |
      基于以下材料写一份结论报告：先给 5 行以内摘要，再列证据（带链接），最后列仍未解决的问题。
      材料：
      {{gather}}
---
