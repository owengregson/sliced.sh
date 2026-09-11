/**
 * Clock (Appendix F §5.9): `mm:ss`, `h:mm:ss` over an hour, `ss.t` under 10 s. States active /
 * inactive / low (<20 s active → danger-text) / unknown ("—:—"). Never blinks; mirrors the
 * site's clock.
 */

import { UI_TIMINGS } from "@core/constants/ui";
import { COPY } from "../copy";
import { instantiate, part } from "../template";
import html from "../views/templates/components/clock.html?raw";

const MS = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

export interface ClockState {
	/** Remaining time, or null when the site clock cannot be read. */
	ms: number | null;
	active?: boolean;
	/** Running is independent of the active-row highlight (for paused/site-stopped clocks). */
	running?: boolean;
	/** Epoch time of the site reading. Repeated snapshots must retain this anchor. */
	at?: number;
}

export interface ClockHandle {
	readonly el: HTMLElement;
	update(state: ClockState): void;
	dispose(): void;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Format remaining time per §5.9. */
export function formatClock(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms)) return COPY.clock.unknown;
	const clamped = Math.max(0, ms);
	if (clamped < UI_TIMINGS.clockTenthsBelowMs)
		return (Math.floor(clamped / (MS / 10)) / 10).toFixed(1);
	const totalSeconds = Math.floor(clamped / MS);
	const seconds = totalSeconds % SECONDS_PER_MINUTE;
	const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
	const minutes = totalMinutes % MINUTES_PER_HOUR;
	const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
	if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
	return `${pad(minutes)}:${pad(seconds)}`;
}

export function createClock(host: HTMLElement | null): ClockHandle {
	const el = instantiate(html);
	const time = part(el, ".sl-clock__time");
	const tenths = part(el, ".sl-clock__tenths");
	let current: ClockState = { ms: null };
	let capturedAt = Date.now();
	let timer: ReturnType<typeof setInterval> | null = null;

	function paint(): void {
		const ms =
			current.ms === null
				? null
				: Math.max(0, current.ms - (current.running ? Math.max(0, Date.now() - capturedAt) : 0));
		const active = current.active === true;
		time.textContent = formatClock(ms);
		const known = ms !== null && Number.isFinite(ms);
		const low = known && active && (ms as number) < UI_TIMINGS.clockLowMs;
		el.dataset.state = !known ? "unknown" : low ? "low" : active ? "active" : "inactive";
		if (!known) {
			// §5.9: the row says why the numeral is a dash.
			tenths.textContent = COPY.clock.unavailable;
			tenths.hidden = false;
		} else if ((ms as number) < UI_TIMINGS.clockTenthsBelowMs) {
			// Under 10 s the numeral shows whole seconds and the tenths sit in the label slot.
			const [seconds, tenth] = formatClock(ms).split(".");
			time.textContent = seconds ?? "";
			tenths.textContent = `.${tenth ?? "0"}`;
			tenths.hidden = false;
		} else {
			tenths.textContent = "";
			tenths.hidden = true;
		}
	}

	function update(state: ClockState): void {
		if (state.at !== undefined && Number.isFinite(state.at)) capturedAt = state.at;
		else if (current.ms !== state.ms || current.running !== state.running) capturedAt = Date.now();
		current = { ...state };
		if (timer !== null) clearInterval(timer);
		timer = state.running && state.ms !== null ? setInterval(paint, UI_TIMINGS.clockTickMs) : null;
		paint();
	}

	update({ ms: null });
	host?.append(el);
	return {
		el,
		update,
		dispose() {
			if (timer !== null) clearInterval(timer);
			timer = null;
			el.remove();
		},
	};
}
