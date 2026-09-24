/**
 * Timing log (§8.6): a `TimingLogEntry` per planned move in a
 * `LIMITS.timingLogMax`-entry ring buffer persisted under
 * `LOCAL_KEYS.timingLog`. The service worker calls `flush()` on the
 * `ALARM_NAMES.timingLogFlush` alarm and on game end; the Engine view exports
 * the rows as JSON.
 *
 * The pure entry builder (`./timing-log/entry`) is separate from the storage-backed writer
 * (`./timing-log/writer`), so the timing model builds entries without the chrome wrappers.
 */

export { buildTimingLogEntry, type TimingLogInput } from "./timing-log/entry";
export { TimingLogWriter } from "./timing-log/writer";
