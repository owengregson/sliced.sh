/**
 * Clock parsing (Appendix C §1.4). chess.com renders `m:ss`, `m:ss.t` or
 * `h:mm:ss`.
 */

import type { Color } from "@typedefs/game";
import type { ClockReading } from "./adapter";
import { queryFirst, querySafe } from "./query";
import { SELECTORS } from "./selectors";

const CLOCK_RE = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d))?$/;

/** `"0:16.0"` → 16000, `"2:59"` → 179000, `"1:00:00"` → 3600000; `NaN` on junk. */
export function parseClockText(text: string): number {
	const m = CLOCK_RE.exec(text.trim());
	if (!m) return Number.NaN;
	const [, h, mm, ss, tenth] = m;
	const hours = h ? Number(h) : 0;
	return ((hours * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + (tenth ? Number(tenth) * 100 : 0);
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
		hasTenths: /\.\d\s*$/.test(text),
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
