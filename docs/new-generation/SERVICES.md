# 服务面工具详细规划(新代)

## 目的

各服务面包的接口工具清单(细化); 包结构与职责见 SERVICES-PACKAGES.md。

> 本文件记录的全部是服务面接口(进程内由插件 / 包调用), 接口划分与形态不考虑模型交互。
> 划分原则: 服务面接口按「一次调用一个独立目的」划分, 倾向分开、不合并; 「单工具 + 参数切换」与「多工具」的形态取舍只属于模型面(见 TOOLS.md)。

## 命名

- 服务面接口工具 = `<服务>.<方法>`: 服务名 `c` + 单词 camelCase(如 cSync), 方法名 camelCase(如 register), 对齐宿主 `ctx.<服务>.<方法>`(如 `ctx.sessions.create`)。库面形态的包(cTool / cCommand)不挂 ctx 服务, 接口经库导出 import。
- 模型面工具仍按 `c_<对象>_<动作>`(见 TOOLS.md), 与本文件的接口工具区分。
- 动作语义与参数在 DESIGN 阶段定稿。

## 一、最底层能力

### 同步(cSync)

- `cSync.register` 登记: 共享资源(会话状态 / 队列 / 锁 / 时间 / 别名)的持有者与等待次序
- `cSync.unregister` 释放: 显式注销登记; 残留靠 TTL 与懒清理兜底
- `cSync.allocate` 取号(含等待): 按时间与顺序发号; 计数不足则挂到资源等待队列, 可带截止时间(超时返回「等了没等到」)
- `cSync.wake` 唤醒: 向资源投信号; 发送方不限 agent(守护进程 / 定时器 / 常驻循环均可)
- `cSync.exclusive` 串行化: 上层不自行抢占资源, 一律经本层; 跨进程互斥带 TTL 租约与心跳续期
- `cSync.status` 快照: 只读查登记的资源、持有者与等待次序
- `cSync.report` 会话上报: 会话启动后经本层上报自身信息(别名 / id 等)到共享表, 供寻址与在线判定; 退出时撤销
- `cSync.aliasSet` 别名登记: alias → sessionId 的共享映射, 无 TTL(用户意图, 不随会话离线过期), 可覆盖
- `cSync.aliasList` 别名列表: 列全部别名
- `cSync.aliasClear` 别名清除: 按别名或按会话清除

### 多级记忆(cMemory)

- `cMemory.read` 读取: 取 G / P / S 三级内容(从持久化读到内存)
- `cMemory.snapshot` 快照: 取 C(上下文)级保持项状态快照, 供展示层(如 TUI)显示
- `cMemory.write` 写入: 统一 `write(等级, 分类, ...)`, 写 G / P / S 持久层
- `cMemory.retain` 保持: 写 C 级内容, 按动态保持原则注入上下文(跨压缩、跨轮), 写空字符串 = 撤销该条保持项; 需要长期固化的内容写 S 级

### 边界(cBoundary)

- `cBoundary.register` 注册判别: 声明判别时机(工具执行前 / 审批时 / 工具执行后)与判定回调; 到点时 cBoundary 把宿主各步骤信息汇聚成一份上下文整份喂给回调, 插件自行取所需; 回调返回的判定(放 / 拦 / 送审)由 cBoundary 转交宿主相应通道。同一时机多个注册者按注册顺序串行: 「拦 / 送审」短路(立即定, 其余不再判);「放」不否决后续; 全部「放」才放; 同时命中时原因取先注册者

### 工具注册(cTool)

- `cTool.register` 登记 / 包装: 包一层宿主 `ctx.tools` 接口, 内部固定完成判面可注册、套精简呈现(短说明 + 宽松占位)、全文与完整参数 schema 收进 catalog、注册进宿主; 缺面时告警降级。精简呈现(minify)并入登记, 不设独立接口

### 事件订阅(cCascade)

- `cCascade.subscribe` 订阅: 会话、回合、步骤、压缩等生命周期节点, 统一走一个订阅面; 频率控制是注册时的选项

### 命令注册(cCommand)

- `cCommand.register` 登记(库面函数): 插件声明命令结构(命令名 + 多级子命令 + 参数 schema + 校验规则)与回调列表(每个子命令一个回调), 本层注册进宿主并维护结构目录; 命令输入到达时按结构解析、校验、路由到对应回调
- `cCommand.completions` 补全投影(库导出): 把命令结构投影为结构化子命令表(含参数提示), 供 TUI 补全到子命令一级
- 执行借宿主 `ctx.commands.execute`, 不另开接口; 本层不 provide 服务面(库面形态)

### 增员(cSpawn)

- `cSpawn.create` 创建常驻会话: 拉起独立进程会话并启动; 会话启动后经 cSync 上报自身别名 / id 等到共享表(身份登记), 可指定使用的模型、权限、cwd 等
- `cSpawn.exit` 退出常驻会话: 停止进程并清理生命周期登记
- 进程内委派直接用宿主 `ctx.subagents`(subagent / subagent_fork), 本层不重复提供

### 会话目录(cPath)

- `cPath.resolve` 解析 / 建目录: 复刻宿主目录编码(`encodeSegment` / `projectKey` / `projectDir` / `sessionDir`), 按会话 id 取 `header.cwd` 推导目录; 带 ensure 选项时建目录(0700、幂等, 唯一写盘入口), 缺省只算不建

### 解析(cParse)

- `cParse.detectLanguage` 语言识别
- `cParse.structure` 结构访问
- `cParse.extractTargets` 命令目标 / 调用点提取
- 解析失败不调模型: 回执里带明确信号(未知语言 / 空结构 / 空目标)并提示用模型解析, 由上层决定是否兜底

## 二、基础能力(组合)

### 共享 / 通信(cChannel)

- `cChannel.send` 消息传递: 一个会话向另一个会话发送消息, 消息作为同步共享状态经 cSync 送达、等待与唤醒; 需要跨进程存续时经 cMemory 落盘
- `cChannel.receive` 消息接收: 读目标会话的收件箱(收件箱经 cSync 的队列资源承载), 与 send 成对(推 / 拉)
- `cChannel.lookup` 寻址: 把稳定目标标识(会话 id / 别名)解析为在线目标会话, 供消息投递定位; 别名是 cSync 的共享映射, 本层消费

### 自主推进(cPush)

- `cPush.advance` 推进: 切到「自动」推进状态, 持续进行 — 经 cCascade 订阅的生命周期事件驱动, 持续注入提醒(固定提醒「查询并完成正在进行的任务」, 或取 stage 目标描述反复提醒), 直到 c-flow 完成完工审查后调 pause 才停止
- `cPush.pause` 暂停: 退出自动推进状态, 不再持续注入(由上层如 c-flow 在完工审查通过时调用)
- `cPush.checkpoint` 进度记忆: 经 cMemory 记住当前进度
- `cPush.schedule` 定时: 经 cSync 取得定时
- `cPush.wake` 唤醒: 在需要时唤醒自己或继续循环
- 注: 发起下一回合的一次性注入直接用宿主 `agents.followup`, 不经 cGuide

### 注入引导(cGuide)

- `cGuide.register` 注册注入规则(统一注册面): 判定对会话节点的文本载荷做字符串匹配(文本类节点 user-message / assistant-text / tool-call / tool-result, 规则可挂多个节点; 边界节点可无条件命中), 命中后经宿主 `agents.followup` 注入一段内容引导行为; 节流 / 去重经 cCascade 的频率控制(注册选项)

### 约束(cConstrain)

- `cConstrain.gate` 阶段拦截: 控制流经它临时禁止某些工具(即使已揭示也拦), 如 plan 只读阶段禁用写类工具; 拦截的回执带阶段原因(非「工具不存在」)
- `cConstrain.evaluate` 依据: 拦的判断依据来自推进状态(读 cPush.checkpoint 经 cMemory 的进度), 具体阶段边界判定交给上层
