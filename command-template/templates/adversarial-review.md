---
name: adversarial-review
description: 对抗评审：正方结论 → 反方攻击 → 裁决
input: 待评审的结论 / 设计 / 方案
steps:
  - id: claim
    type: agent
    prompt: |
      用不超过 10 行陈述下列方案的结论与关键假设（假设要显式标号，便于反驳）：
      $ARGUMENTS
  - id: attack
    type: agent
    prompt: |
      你是对抗评审者：只做攻击，不客气。逐条找出上述结论的错误假设、缺失证据、
      边界反例与更差后果；每条给出反例或可验证的检验方式。
      方案与假设：
      {{claim}}
    bestOf: 3
    judge:
      prompt: 合并三份攻击：去重、按杀伤力排序，剔除无依据的指控。
  - id: verdict
    type: prompt
    prompt: |
      基于原始结论与攻击清单，给出裁决：哪些假设必须修正、哪些结论不成立、
      在什么条件下结论才成立。
      结论：{{claim}}
      攻击：{{attack}}
---
