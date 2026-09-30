---
name: multi-perspective
description: 同一问题的多角色视角（产品 / 实现 / 运维 / 用户）
input: 待评估的问题或方案
steps:
  - id: product
    type: agent
    prompt: 以产品负责人视角评估：$ARGUMENTS。给出收益、体验影响与优先级判断。
  - id: implement
    type: agent
    prompt: 以实现者视角评估：$ARGUMENTS。给出改动面、风险、工期与替代方案。
  - id: operate
    type: agent
    prompt: 以运维 / 排障视角评估：$ARGUMENTS。给出可观测性、回滚与故障场景。
  - id: user
    type: agent
    prompt: 以终端用户视角评估：$ARGUMENTS。给出最可能被抱怨的三件事。
  - id: digest
    type: prompt
    prompt: |
      汇总四个视角，输出「一致结论 / 分歧点 / 建议决策」，并指出现有证据不足之处。
      产品：{{product}}
      实现：{{implement}}
      运维：{{operate}}
      用户：{{user}}
---
