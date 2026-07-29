import type {
  ReportScheduler,
  ScheduledHandle,
  Sleeper,
} from "./types";

export class IntervalReportScheduler implements ReportScheduler {
  every(
    _id: string,
    intervalMs: number,
    task: () => void | Promise<void>,
  ): ScheduledHandle {
    const timer = setInterval(() => {
      void task();
    }, intervalMs);
    timer.unref?.();
    return {
      cancel: () => clearInterval(timer),
    };
  }
}

export const timerSleeper: Sleeper = Object.freeze({
  sleep: (milliseconds: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref?.();
    }),
});
