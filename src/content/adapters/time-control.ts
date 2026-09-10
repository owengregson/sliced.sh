/**
 * The site's own time control, as the MAIN-world bridge reports it (§4.3,
 * Appendix C §1.4).
 *
 * chess.com answers `board.game.timeControl.get()` with `{baseTime, increment}`
 * — the bridge copies that object through verbatim (`BridgeState.timeControl`,
 * typed `unknown` because it is the site's shape, not ours). This module is the
 * only place that shape is interpreted.
 *
 * Ground truth, owner's live capture 2026-09-09: a **3 minute** game answered
 * `{"baseTime":180000,"increment":0}`, so `baseTime` is in MILLISECONDS, and the
 * whole object is **null until the game actually starts** — a 10-minute game
 * "not yet started" answered `null` while its clocks already read `10:00`. The
 * increment's unit is unconfirmed (0 in that sample); see `TIME_CONTROL`.
 *
 * Remaining time never comes from here: `game.times` and `game.timestamps` are
 * both `{}` on a live game, so the clocks are read from the DOM (`clocks.ts`).
 */

import { TIME_CONTROL } from "@core/constants/timings";
import { log } from "@core/logger";
import type { TimeControl } from "@typedefs/game";

/** chess.com's own field names on the `timeControl.get()` object. */
const BASE_FIELD = "baseTime";
const INCREMENT_FIELD = "increment";

/**
 * One ms-or-seconds reading of a clock field. `null` when the value is not a
 * usable number; the seconds branch is the guarded implausible case.
 */
function msOf(value: unknown, field: string): { ms: number; unit: "ms" | "s" } | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	if (value === 0) return { ms: 0, unit: "ms" };
	if (value < TIME_CONTROL.minPlausibleMs) {
		// Not a millisecond reading: chess.com's base times and increments are whole seconds, so a
		// nonzero value under a second would mean the unit changed under us. Read it as seconds
		// rather than plan with a 2 ms increment, and say so loudly — this is the branch QA must
		// confirm against a real increment game.
		log.warn("adapter: implausible time-control field, reading it as seconds", {
			field,
			value,
			thresholdMs: TIME_CONTROL.minPlausibleMs,
		});
		return { ms: value * TIME_CONTROL.msPerSecond, unit: "s" };
	}
	if (value > TIME_CONTROL.maxPlausibleMs) {
		log.warn("adapter: time-control field out of range, ignoring it", { field, value });
		return null;
	}
	return { ms: value, unit: "ms" };
}

/**
 * `{baseTime, increment}` → `TimeControl`, or `null` when the site has not
 * answered yet (the pre-game state) or answered something unusable. A zero base
 * with a zero increment is `null` too: that is "no clock", which the timing
 * model already has a meaning for (`tcClass` → `untimed`) and which must not be
 * confused with "the site told us 0 + 0".
 */
export function timeControlFromBridge(value: unknown): TimeControl | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const base = msOf(record[BASE_FIELD], BASE_FIELD);
	if (base === null || base.ms <= 0) return null;
	const inc = msOf(record[INCREMENT_FIELD], INCREMENT_FIELD);
	return { baseMs: base.ms, incMs: inc?.ms ?? 0 };
}
