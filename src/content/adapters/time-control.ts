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
 * The clock reading *is* used as a cross-check on the unit, though — see
 * `timeControlFromBridge`.
 */

import { TIME_CONTROL } from "@core/constants/timings";
import { log } from "@core/logger";
import type { TimeControl } from "@typedefs/game";

/** chess.com's own field names on the `timeControl.get()` object. */
const BASE_FIELD = "baseTime";
const INCREMENT_FIELD = "increment";

/** A finite, non-negative number, else `null`. */
function numberOf(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	return value;
}

/**
 * `{baseTime, increment}` → `TimeControl`, or `null` when the site has not
 * answered yet (the pre-game state) or answered something unusable. A zero base
 * with a zero increment is `null` too: that is "no clock", which the timing
 * model already has a meaning for (`tcClass` → `untimed`) and which must not be
 * confused with "the site told us 0 + 0".
 *
 * `clockHintMs` is the largest clock the page is currently *showing* (0 when it
 * shows none). It is the second half of the unit guard: the magnitude test alone
 * cannot tell a 30-minute game reported in seconds (`1800`) from a 1.8 s base,
 * and getting that wrong puts every move of the game in the §8.5 emergency
 * regime. Both branches log loudly rather than planning quietly.
 */
export function timeControlFromBridge(value: unknown, clockHintMs = 0): TimeControl | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const base = numberOf(record[BASE_FIELD]);
	if (base === null || base <= 0) return null;
	if (base > TIME_CONTROL.maxPlausibleMs) {
		log.warn("adapter: time-control base out of range, ignoring it", { baseTime: base });
		return null;
	}
	const inc = numberOf(record[INCREMENT_FIELD]) ?? 0;

	// Is the pair in seconds? Either it is too small to be milliseconds at all, or the clock the
	// page is showing dwarfs it — chess.com's increments and base times are whole seconds, so a
	// nonzero field under a second is not a millisecond reading either way.
	const tooSmall = base < TIME_CONTROL.minPlausibleMs;
	const clockDwarfsIt = clockHintMs > 0 && base * TIME_CONTROL.unitMismatchFactor < clockHintMs;
	if (tooSmall || clockDwarfsIt) {
		log.warn("adapter: time control is in seconds, not milliseconds", {
			baseTime: base,
			increment: inc,
			clockMs: clockHintMs,
			reason: tooSmall ? "below the millisecond floor" : "the clock on the page dwarfs it",
		});
		const baseMs = base * TIME_CONTROL.msPerSecond;
		return baseMs > TIME_CONTROL.maxPlausibleMs
			? null
			: { baseMs, incMs: inc * TIME_CONTROL.msPerSecond };
	}

	// The base reads as milliseconds. The increment's unit is the unconfirmed one, so it keeps its
	// own guard: a nonzero value under a second cannot be a real chess.com increment in ms.
	if (inc > 0 && inc < TIME_CONTROL.minPlausibleMs) {
		log.warn("adapter: implausible time-control increment, reading it as seconds", {
			increment: inc,
			thresholdMs: TIME_CONTROL.minPlausibleMs,
		});
		return { baseMs: base, incMs: inc * TIME_CONTROL.msPerSecond };
	}
	if (inc > TIME_CONTROL.maxPlausibleMs) {
		log.warn("adapter: time-control increment out of range, ignoring it", { increment: inc });
		return { baseMs: base, incMs: 0 };
	}
	return { baseMs: base, incMs: inc };
}
