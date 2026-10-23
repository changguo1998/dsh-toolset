/**
 * aliases.ts — 工具别名表（纯数据）。
 *
 * 关键词索引的弱点是与模型自由表述之间的词汇鸿沟；这里给高频 / 易混工具
 * 补 2 至 4 个中英文口语词，命中别名时按 4 倍字段权重计分（见 matcher.ts）。
 * 工具改名或新增时同步维护本表。
 */
export const ALIASES: Readonly<Record<string, readonly string[]>> = {
  bash: ["shell", "命令", "执行命令", "终端", "脚本"],
  read: ["读文件", "查看文件", "读取"],
  write: ["写文件", "新建文件", "创建文件"],
  edit: ["改文件", "编辑", "修改文件"],
  glob: ["找文件", "文件列表", "匹配路径"],
  grep: ["搜索内容", "查找文本", "检索"],
  todo_write: ["待办", "任务清单", "todo"],
  ask_user_question: ["问用户", "确认", "提问"],
  skill: ["技能", "加载技能", "技能库"],
  task_decompose: ["拆任务", "分解", "任务树"],
  task_implement: ["完成任务", "写产出"],
  task_status: ["任务状态", "任务树查看"],
  task_execute: ["执行任务", "子代理执行"],
  task_stop: ["验收", "停止任务"],
  session_channel: ["跨会话", "发消息", "通知", "会话通道"],
  channel_delegate: ["委托", "交给另一个会话", "委派", "跨会话任务"],
  channel_task: ["任务状态", "委托查询"],
  rule_add: ["加规则", "注入规则"],
  rule_update: ["改规则", "更新规则"],
  rule_list: ["规则列表"],
  // herdr-use 终端面：10 个具名工具，工具名即动作（无 action 参数）。
  herdr_list: ["终端列表", "列终端", "看有哪些终端"],
  herdr_read: ["看屏", "屏幕内容", "读屏"],
  herdr_info: ["进程探活", "前台进程", "终端状态"],
  herdr_wait: ["等输出", "判稳", "等待输出"],
  herdr_create: ["开终端", "新终端", "建终端"],
  herdr_close: ["关终端", "关闭终端", "关掉终端"],
  herdr_label: ["改标题", "打标签", "终端标签"],
  herdr_text: ["输入文本", "打字", "粘贴文本"],
  herdr_key: ["按键", "中断", "组合键"],
  herdr_run: ["跑命令", "发命令", "提交命令"],
  memory_query: ["记忆", "知识库", "查记忆"],
  workflow: ["工作流", "多代理", "并行子代理"],
  subagent: ["子代理", "委派子任务"],
  md_logic: ["markdown 结构", "文档结构", "按节"],
  md_map: ["文档引用", "影响面"],
  code_map: ["代码地图", "调用关系"],
  script_run: ["跑脚本", "python", "执行脚本"],
  goal_contract_draft: ["目标契约", "done-when"],
  metric_loop: ["指标循环", "迭代优化"],
  daemon_task: ["定时任务", "守护"],
  context_report: ["上下文用量", "token 报告"],
  fs_digest: ["文件摘要", "大纲"],
  agent_group: ["分组编排", "同事模型"],
  notice_history: ["通知历史"],
};
