/**
 * Clock parsing (Appendix C §1.4). chess.com renders `m:ss`, `m:ss.t` or
 * `h:mm:ss`, and adds tenths below roughly a minute — where it may also drop
 * the leading `0:` (the owner's report; the exact sub-minute string is still
 * unconfirmed, so both shapes read).
 *
 * The parse is by *part count*, not by one regex with an optional group: a
 * regex that requires a colon drops a bare-seconds rendering entirely
 * (`"59.8"` → no match → `NaN` → `readClock` returns `null`), and a dropped
 * clock is worse than a wrong one — it silently re-inflates the think time in
 * the one regime the timing model exists to handle (§8 compression, §8.5
 * emergency).
 */

import type { Color } from "@typedefs/game";
import type { ClockReading } from "./adapter";
import { queryFirst, querySafe } from "./query";
import { SELECTORS } from "./selectors";

/** Whole field (hours, minutes): 1–3 digits, no fraction. */
const WHOLE_RE = /^\d{1,3}$/;
/** Trailing field: 1–2 digits with an optional 1–2 digit fraction. */
const TRAILING_RE = /^(\d{1,2})(?:\.(\d{1,2}))?$/;

const SEC_PER_MIN = 60;
const MS_PER_SEC = 1000;
/** `h:mm:ss` is the widest shape chess.com renders. */
const MAX_PARTS = 3;

/**
 * `"0:16.0"` → 16000, `"2:59"` → 179000, `"1:00:00"` → 3600000,
 * `"59.8"` → 59800, `"9.8"` → 9800, `"59"` → 59000; `NaN` on junk.
 *
 * Part count decides the meaning: 1 = seconds, 2 = `m:ss`, 3 = `h:mm:ss`. Only
 * the last part may carry a fraction. A bare reading is capped at two digits so
 * stray text inside a clock element (a year, a rating) is junk rather than a
 * clock of thirty-three minutes.
 */
export function parseClockText(text: string): number {
	const parts = text.trim().split(":");
	if (parts.length > MAX_PARTS) return Number.NaN;
	const trailing = TRAILING_RE.exec(parts[parts.length - 1] ?? "");
	if (!trailing) return Number.NaN;
	let seconds = Number(trailing[1]);
	const fraction = trailing[2];
	if (fraction !== undefined) seconds += Number(fraction) / 10 ** fraction.length;
	for (let i = parts.length - 2; i >= 0; i--) {
		const part = parts[i] ?? "";
		if (!WHOLE_RE.test(part)) return Number.NaN;
		seconds += Number(part) * SEC_PER_MIN ** (parts.length - 1 - i);
	}
	return Math.round(seconds * MS_PER_SEC);
}

function hasAnyClass(el: Element, selectors: readonly string[]): boolean {
	return selectors.some((s) => {
		try {
			return el.matches(s);
		} catch {
			return false;
		}
	});
}

export function readClock(root: ParentNode, side: Color): ClockReading | null {
	const clock = querySafe(root, `${SELECTORS.clock}${SELECTORS.clockColor[side]}`);
	if (!clock) return null;
	const time = queryFirst(SELECTORS.clockTime, clock)?.element;
	const text = time?.textContent ?? "";
	const ms = parseClockText(text);
	if (Number.isNaN(ms)) return null;
	return {
		ms,
		running: hasAnyClass(clock, SELECTORS.clockActive),
		hasTenths: /\.\d{1,2}\s*$/.test(text),
	};
}

export function activeClockColor(root: ParentNode): Color | null {
	for (const active of SELECTORS.clockActive) {
		const el = querySafe(root, `${SELECTORS.clock}${active}`);
		if (!el) continue;
		if (el.matches(SELECTORS.clockColor.w)) return "w";
		if (el.matches(SELECTORS.clockColor.b)) return "b";
	}
	return null;
}

/**
 * Colour of the clock at the bottom of the board — i.e. the colour the page
 * shows at the bottom. The clocks keep their colour class on the WebGL board,
 * where the player panel has none (owner's live capture, 2026-09-09:
 * `clock-component clock-bottom clock-black clock-player-turn`).
 */
export function bottomClockColor(root: ParentNode): Color | null {
	const el = querySafe(root, SELECTORS.clockBottom);
	if (!el) return null;
	if (hasAnyClass(el, [SELECTORS.clockColor.w])) return "w";
	if (hasAnyClass(el, [SELECTORS.clockColor.b])) return "b";
	return null;
}
