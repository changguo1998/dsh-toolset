/**
 * 进程内总开关：守护**默认关闭**，`/daemon start` 开启、`/daemon stop` 关闭。
 *
 * 口径（追踪文档 `docs/implementation/2026-10-21-daemon-switch-and-target-check.md` 决策 D1）：
 * 状态**不落盘**——重启复位为关闭，需人工重新开启；不做跨实例同步（各进程各持一份）。
 * 关闭态由装配层保证「调度器未启动」（D2）：`Scheduler.arm()` 在未运行时是空转，
 * 故关闭态不排任何 timer，到点也不投递。
 */
export class DaemonSwitch {
  #enabled: boolean;

  /**
   * @param enabled 初始状态（缺省 `false` = 关闭；`config.enabled` 为唯一开箱放行口）
   */
  constructor(enabled = false) {
    this.#enabled = enabled;
  }

  /** 是否已开启。 */
  get enabled(): boolean {
    return this.#enabled;
  }

  /** 开启（命令面在 `/daemon start` 里调用；幂等）。 */
  enable(): void {
    this.#enabled = true;
  }

  /** 关闭（命令面在 `/daemon stop` 里调用；幂等）。 */
  disable(): void {
    this.#enabled = false;
  }
}
