// 示例 TS 模块：覆盖函数、箭头函数、类方法与多行签名
export interface Payload {
  id: number;
  name: string;
}

export function add(a: number, b: number): number {
  return a + b;
}

export const multiply = (x: number, y: number): number => x * y;

export async function fetchPayload(
  id: number,
  options: { retry?: number; timeoutMs?: number },
  signal?: AbortSignal,
): Promise<Payload> {
  void id;
  void options;
  void signal;
  return { id, name: "x" };
}

export class Counter {
  private count = 0;

  constructor(private step: number) {}

  increment(): number {
    this.count += this.step;
    return this.count;
  }

  static from(value: number): Counter {
    return new Counter(value);
  }
}

export type Alias = string;
export enum Mode { A, B }
