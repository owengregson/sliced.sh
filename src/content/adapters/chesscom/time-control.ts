import type { TimeControl } from "@typedefs/game";
import { readClock, readComputerClock } from "../clocks";
import { timeControlFromBridge } from "../time-control";

/**
 * The game's time control as the site reports it (§4.3). The MAIN-world bridge is the only
 * source: `game.timeControl.get()`. There is no DOM fallback — the live page's header shows a
 * formatted label, not the pair, and `game.times` / `game.timestamps` are both `{}` — so a
 * game whose bridge never answers runs untimed, which is what the timing model's clockless
 * branch is for.
 *
 * The clocks are the unit cross-check (§4.3): a no-increment base a credible page clock exceeds a
 * hundredfold is not in milliseconds. Both sides come from the same reading, so the two cannot
 * disagree. The raw elements are read here, not `getClock`: that uses this time control to gate
 * the computer page's clocks.
 */
export function timeControlOf(
	doc: Document,
	computer: boolean,
	bridgeTimeControl: unknown
): TimeControl | null {
	const hint = Math.max(
		...(["w", "b"] as const).map(
			(side) => (readClock(doc, side) ?? (computer ? readComputerClock(doc, side) : null))?.ms ?? 0
		)
	);
	return timeControlFromBridge(bridgeTimeControl, hint);
}
