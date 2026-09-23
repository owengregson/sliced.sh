import type { TimerScheduler } from "@core/util/scheduler";

/** Timers and clock the client runs on; tests inject a fake. */
export type UciScheduler = TimerScheduler;
