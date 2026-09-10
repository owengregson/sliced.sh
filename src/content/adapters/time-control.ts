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
 * shows none). It is the third witness of the unit guard: the magnitude test
 * alone cannot tell a 30-minute game reported in seconds (`1800`) from a 1.8 s
 * base, and getting that wrong puts every move of the game in the §8.5
 * emergency regime. It is only consulted when the increment is zero — see
 * below. Every branch logs loudly rather than planning quietly.
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

	// The two fields are guarded **independently**, because the object can legitimately be mixed:
	// `baseTime` is confirmed milliseconds (the owner's capture) while the increment's unit is not,
	// so `{baseTime: 180_000, increment: 2}` is a plausible way for chess.com to say 3+2.
	//
	// The base is in seconds when it is under a second (no game is that short), or when the clock on
	// the page is a hundred times larger than it **and there is no increment** — with nothing adding
	// to the clock it can never exceed the base, so the units must differ.
	//
	// Both halves of that third witness matter. Without `inc === 0` it is wrong: an increment-heavy
	// control reaches any multiple of its base by being played (a 1+60 game passes ten times its base
	// after nine moves), and reading that as seconds gives `{baseMs: 60_000_000}` — a one-minute game
	// as 16.7 hours, under `maxPlausibleMs` so nothing drops it, with `tcClass` flipping to classical
	// mid-game. A closeness test (is `base` nearer `clock` or `clock / 1000`?) has the same false
	// positive for the same reason: mid-game the clock is not the base, so "near" says nothing about
	// the unit. And the factor must be large, not 2: the clocks on the page can still belong to the
	// previous game for a moment after a rematch, which is a ratio of ten or thirty, while the
	// seconds hypothesis predicts a thousand.
	//
	// A seconds-reported pair *with* an increment (`{1800, 30}` for 30+30) is caught by the pair
	// witness below rather than by the clock one, which stays gated on `inc === 0`.
	const tooSmallBase = base < TIME_CONTROL.minPlausibleMs;
	// The clock witness is only admissible when the unit hypothesis it supports is itself credible:
	// …and the rescale it implies must yield a base a live game could have. A stale clock from the
	// previous game is not evidence about this one, and it can be any size.
	const secondsBaseIsLive = base * TIME_CONTROL.msPerSecond <= TIME_CONTROL.maxLiveBaseMs;
	const clockExceedsBase =
		inc === 0 &&
		clockHintMs > 0 &&
		secondsBaseIsLive &&
		clockHintMs > base * TIME_CONTROL.clockExceedsBaseFactor;
	const incInSeconds = inc > 0 && inc < TIME_CONTROL.minPlausibleMs;
	// A seconds-reported *pair* is self-witnessing: no real control starts with less time on the
	// clock than it hands back per move, so a base below the rescaled increment proves both fields
	// are seconds. This catches {1800, 30} and {1200, 10} — which the clock witness cannot, because
	// admitting it with an increment present is the false positive above — and cannot fire on a
	// genuine mixed pair, since {180_000, 2} has a base far above 2000.
	const pairInSeconds = incInSeconds && base < inc * TIME_CONTROL.msPerSecond;
	const baseInSeconds = tooSmallBase || clockExceedsBase || pairInSeconds;
	if (baseInSeconds || incInSeconds) {
		log.warn("adapter: time control is not in milliseconds", {
			baseTime: base,
			increment: inc,
			clockMs: clockHintMs,
			baseWitness: tooSmallBase
				? "the base is under a second"
				: clockExceedsBase
					? "the clock on the page exceeds the base with no increment to explain it"
					: pairInSeconds
						? "the base is below the increment, so both fields are seconds"
						: "none (the base reads as milliseconds)",
			incrementWitness: incInSeconds ? "the increment is under a second" : "none",
		});
	}
	const baseMs = baseInSeconds ? base * TIME_CONTROL.msPerSecond : base;
	const incRaw = incInSeconds ? inc * TIME_CONTROL.msPerSecond : inc;
	if (baseMs > TIME_CONTROL.maxPlausibleMs) return null;
	if (incRaw > TIME_CONTROL.maxPlausibleMs) {
		log.warn("adapter: time-control increment out of range, ignoring it", { increment: inc });
		return { baseMs, incMs: 0 };
	}
	return { baseMs, incMs: incRaw };
}
