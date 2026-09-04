/**
 * Clock parsing (Appendix C §1.4, §2.4). Both sites render `m:ss`, `m:ss.t`
 * or `h:mm:ss`; lichess splits the text over `<sep>` / `<tenths>` children
 * but `textContent` yields the same string.
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

export function readChesscomClock(root: ParentNode, side: Color): ClockReading | null {
	const C = SELECTORS.chesscom;
	const clock = querySafe(root, `${C.clock}${C.clockColor[side]}`);
	if (!clock) return null;
	const time = queryFirst(C.clockTime, clock)?.element;
	const text = time?.textContent ?? "";
	const ms = parseClockText(text);
	if (Number.isNaN(ms)) return null;
	return {
		ms,
		running: hasAnyClass(clock, C.clockActive),
		hasTenths: /\.\d\s*$/.test(text),
	};
}

export function chesscomActiveClockColor(root: ParentNode): Color | null {
	const C = SELECTORS.chesscom;
	for (const active of C.clockActive) {
		const el = querySafe(root, `${C.clock}${active}`);
		if (!el) continue;
		if (el.matches(C.clockColor.w)) return "w";
		if (el.matches(C.clockColor.b)) return "b";
	}
	return null;
}

export function readLichessClock(root: ParentNode, side: Color): ClockReading | null {
	const L = SELECTORS.lichess;
	const clock = querySafe(root, `${L.clock}${L.clockColor[side]}`);
	if (!clock) return null;
	const time = querySafe(clock, L.clockTime);
	if (!time) return null;
	const ms = parseClockText(time.textContent ?? "");
	if (Number.isNaN(ms)) return null;
	return {
		ms,
		running: clock.classList.contains(L.clockRunningClass),
		hasTenths: time.querySelector(L.clockTenths) !== null,
	};
}

export function lichessRunningClockColor(root: ParentNode): Color | null {
	const L = SELECTORS.lichess;
	const el = querySafe(root, L.clockRunning);
	if (!el) return null;
	if (el.matches(L.clockColor.w)) return "w";
	if (el.matches(L.clockColor.b)) return "b";
	return null;
}
