/**
 * 运行期 stderr 桥（项目级 BACKLOG #61 方案 A）：把运行期的 `process.stderr.write` 文本
 * 按行转交 App 的活动区（`appendExternalLog`），避免裸写落在输入区光标处——渲染器是
 * 增量（delta）重绘，输入区未被重写的行不会覆盖这些字节（机制见追踪文档 2026-10-01）。
 *
 * 边界：
 * - 安装前的写入照旧直写（启动诊断不受影响）；`restore` 后还原原始 write，缓冲残行透传；
 * - 交付期间桥内再写 stderr（例如活动区渲染自身出错）直通原始 write，防递归；
 * - 多参调用形态（encoding / callback）一律透传原始流，避免破坏回调契约；
 * - 只接管 stderr；stdout 是渲染器通道，不动。
 */

/** 活动区 notice/log 行的 tone 子集（log 灰 / warn 黄 / error 红）。 */
export type ExternalLogTone = "log" | "warn" | "error";

/** 完整行交付口（App 侧接 `appendExternalLog`）。 */
export type ExternalLogSink = (line: string, tone: ExternalLogTone) => void;

/** 最小 stderr 形态（测试可注入假流；缺省 `process.stderr`）。 */
export interface StderrLike {
  write(chunk: unknown, ...rest: unknown[]): unknown;
}

/** 桥还原句柄。 */
export interface StderrBridge {
  /** 还原原始 write；未成行的缓冲残行透传给原始 write（字节不丢）。 */
  restore(): void;
}

/** 文本 tone 判定：含 `error`/`fatal` → error；含 `warn(ing)`/`警告` → warn；其余 log。 */
export function externalLogTone(line: string): ExternalLogTone {
  if (/\b(error|fatal)\b/i.test(line)) return "error";
  if (/\bwarn(ing)?\b|警告/i.test(line)) return "warn";
  return "log";
}

/**
 * 安装桥：替换 `target.write`，按 `\n` 分行把完整行交给 `sink`。
 * @param sink - 完整行交付口（App 侧入活动区）。
 * @param target - 被接管的流（缺省 `process.stderr`；测试传假流）。
 * @returns 还原句柄（App dispose 时调用）。
 */
export function installStderrBridge(
  sink: ExternalLogSink,
  target: StderrLike = process.stderr,
): StderrBridge {
  const original = target.write.bind(target);
  let buffer = "";
  let delivering = false;
  target.write = (chunk: unknown, ...rest: unknown[]): unknown => {
    if (delivering || rest.length > 0) {
      return (original as (...args: unknown[]) => unknown)(chunk, ...rest);
    }
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      delivering = true;
      try {
        sink(line, externalLogTone(line));
      } finally {
        delivering = false;
      }
    }
    return true;
  };
  return {
    restore(): void {
      target.write = original as StderrLike["write"];
      const rest = buffer;
      buffer = "";
      if (rest !== "") (original as (chunk: unknown) => unknown)(rest);
    },
  };
}
