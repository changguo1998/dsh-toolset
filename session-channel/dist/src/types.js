// src/types.ts — session-channel 的类型面与错误分类。
//
// 与实现解耦：配置项、在线对端、发送/收件结果、错误码（调用方按 code 分支，不解析 message）。
/** 结构化错误。 */
export class SessionChannelError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "SessionChannelError";
        this.code = code;
    }
}
//# sourceMappingURL=types.js.map