# 模型面工具详细规划(新代)

## 目的

各模型面包的工具清单(细化); 包结构与职责见 TOOLS-PACKAGES.md。

> 本文件记录的全部是模型面工具(模型直接调用); 进程内的服务面接口见 SERVICES.md。
> 命名: 模型面工具 `c_<对象>_<动作>`(如 c_file_structure); 保留现状实现的 TUI / preference-analysis 工具沿用现名。

## 命名与取向

- 命名: 模型面工具 `c_<对象>_<动作>`(如 c_file_structure)。
- 取向: 工具小而专, 只作用于动作维度; 语言与格式(代码 / Markdown / 通用文本)由工具内部按扩展名与内容自动识别, 不按语言拆工具、不按格式分包。
- 语言支持渐进扩充, 通用骨架起步(先覆盖 ts / js / py / md / json / yaml / shell)。
- 包结构与职责见 TOOLS-PACKAGES.md。

## 一、c-file(文件交互)

### 读侧(统一, 6 个)

- `c_file_structure` 结构读取: 代码符号树 / md 节树 / 泛语言大纲
- `c_file_links` 链接清单: 链接 / 图片 / 引用式定义
- `c_file_refs` 引用查询: 谁引用了某符号 / 文档 / 锚点
- `c_file_impact` 影响面: 反向引用闭包
- `c_file_report` 汇总报告: 项目 / 文档级统计、孤儿、环
- `c_file_read` 行锚点定位读取

### 写侧(按改写方式分, 3 个, 跨格式)

- `c_file_edit` 行锚点编辑: 改 / 插 / 删行
- `c_file_replace` 语法树级替换, 带版本校验
- `c_file_patch` 节 / 块级整段替换, 带漂移锚点

## 二、c-flow(流程控制)

- `c_flow_run` 运行: new / continue / pause 合一 — 创建根节点(不开始) / 交引擎按设定自动推进 / 暂停; 只作用于根节点, 引擎决定做哪个节点
- `c_flow_decompose` 展开: 展开任务节点(自由给子任务, 或选已注册固定模式), 需审计
- `c_flow_status` 状态: 只读查任务树与推进状态

## 三、固定模式(经 c-flow 注册, 各留入口工具)

- `c_flow_plan`(拟定名) 三段模式: 规划-执行-审计; 建根时指定, 或 decompose 时直接套用
- `c_flow_pipeline`(拟定名) 八段模式: 目标-调研-决策-规划-任务-执行-审计-收尾; 建根时指定, 或 decompose 时直接套用

## 四、c-group(编排合作)

- `c_group` 群组编排(单工具, action 分派): 建组 / 加成员 / 建主从或平等连接 / 发指令 / 结算查询, 对齐现状 agent_group 形态
- 通信与拉起不单独设模型工具: 经底座 cSync / cChannel / cSpawn(进程内委派经宿主 subagents); 可选接入 c-flow 指定任务流程, 通信只做载体

## 五、preference-analysis(内容分析)

沿用现名三工具:

- `preference_list` 偏好账簿列表(只读)
- `preference_add` 登记偏好建议(落候选待审)
- `preference_remove` 撤销偏好

## 六、TUI

沿用现名只读回读工具:

- `tui_local_log` 读 TUI 本地输出旁路日志(命令结果与提示行)
- `notice_history` 读宿主 notice 历史原文

## 七、工具咨询与揭示(c-tool)

- `c_tool_query` 查询并揭示: 按名取工具的完整说明与完整参数 schema; 查询命中即写会话授权并投递全文。模型面短定义常驻(header 全量短清单), 全文按需取
- 投递: 揭示后的全文经 cMemory C 级保持(跨压缩、跨轮在场, 可撤销), 非一次性注入
- 可见性: 经 cBoundary 注册「工具执行前」判别, 拦未揭示工具的调用(揭示后放行)

注: 底座(cBoundary / cSync / cChannel / cSpawn / cTool)只提供服务面, 无模型面工具, 不进本文件。
