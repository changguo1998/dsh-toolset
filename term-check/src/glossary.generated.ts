/**
 * 术语表快照（**生成产物, 禁止手改**）：由 `term-check/scripts/gen-glossary.mjs` 从
 * `docs/GLOSSARY.md`「禁止术语」表生成，解析复用 `dev/standard/rules.mjs` 的 `loadGlossary`。
 * 改术语表后重跑 `pnpm run gen:glossary`；两边不一致时 `term-check/tests/glossary.test.ts` 会报红。
 */

/** 「禁止术语」表的一行。 */
export interface GlossaryRow {
  /** 旧称（同一行可含多个, 用 `/` 分隔）。 */
  readonly from: readonly string[];
  /** 应当使用。 */
  readonly to: string;
  /** 条件与例外（原文）。 */
  readonly note: string;
  /** 是否界面名称（`term.interface`）。 */
  readonly isInterface: boolean;
  /** 条件型术语: 与包并列指层次时保留, 不自动判定。 */
  readonly conditional: boolean;
}

/** 快照正文（行序与 GLOSSARY 表一致）。 */
export const GLOSSARY_SNAPSHOT: readonly GlossaryRow[] =
  /* prettier-ignore */ [
    {"from":["模块"],"to":"包","note":"与包并列指层次时保留「模块」；「模块 = TUI 与 N 个包」改「本仓 34 个包 = TUI 与 33 个插件」","isInterface":false,"conditional":true},
    {"from":["插件包"],"to":"包 / 插件","note":"泛指代码模块用「包」，数插件用「插件」","isInterface":false,"conditional":false},
    {"from":["过程记录"],"to":"追踪文档","note":"归档不改","isInterface":false,"conditional":false},
    {"from":["符号规则"],"to":"符号规范","note":"-","isInterface":false,"conditional":false},
    {"from":["工具集"],"to":"工具面 / 插件集","note":"模型可见工具面用「工具面」，项目自称用「插件集」；`docs/host` 保留","isInterface":false,"conditional":true},
    {"from":["决策点"],"to":"决策项","note":"`docs/host` 除外","isInterface":false,"conditional":false},
    {"from":["评审"],"to":"审阅","note":"命令模板的中文活动名同改；模板文件名与 slash 命令名不变","isInterface":false,"conditional":false},
    {"from":["返回体"],"to":"回执","note":"-","isInterface":false,"conditional":false},
    {"from":["回归"],"to":"退化 / 守成测试","note":"指行为变差用「退化」，指测试用「守成测试」","isInterface":false,"conditional":false},
    {"from":["收口"],"to":"统一 / 集中 / 统合 / 收尾","note":"统一格式用「统一」，集中位置用「集中」，两者兼有用「统合」，收尾琐事用「收尾」","isInterface":false,"conditional":true},
    {"from":["落点"],"to":"见「推荐术语」","note":"按存储 / 审计 / 实现 / 投递 / 文档 / 条目分写","isInterface":false,"conditional":false},
    {"from":["影子覆盖事件"],"to":"更正事件","note":"`surfaceOp: replace` 的情况","isInterface":false,"conditional":false},
    {"from":["活动区","Turn 区","Turn 面板","活动 pane"],"to":"回合区","note":"归档不改; 历史对照句可注「原名」","isInterface":true,"conditional":false},
    {"from":["对话区","历史区","对话历史区","历史 pane","对话 pane"],"to":"会话区","note":"归档不改; 历史对照句可注「原名」","isInterface":true,"conditional":false},
    {"from":["系统状态区","系统状态栏"],"to":"状态行","note":"归档不改; 历史对照句可注「原名」","isInterface":true,"conditional":false},
    {"from":["Tool 面板区","工具面板区","Tool 面板","工具面板"],"to":"工具区","note":"归档不改; 历史对照句可注「原名」","isInterface":true,"conditional":false},
    {"from":["交互区"],"to":"输入区 + 提示行","note":"组合名拆开; 归档不改","isInterface":true,"conditional":false},
    {"from":["输入框","输入栏"],"to":"输入区","note":"历史对照句可注「原名」","isInterface":true,"conditional":false},
    {"from":["状态栏"],"to":"状态列 / 状态行","note":"按位置: 左侧竖列用「状态列」, 底部横条用「状态行」; 不再单独用「状态栏」","isInterface":true,"conditional":false},
    {"from":["底部提示","提示区"],"to":"提示行","note":"归档不改; 历史对照句可注「原名」","isInterface":true,"conditional":false},
  ];
