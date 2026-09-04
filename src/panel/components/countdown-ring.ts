/**
 * Countdown ring (Appendix F §5.10): a 20/24 px SVG whose progress stroke drains clockwise
 * from full at plan start to empty at execution. `update(remainingMs, totalMs)` drives
 * `stroke-dashoffset` (real time, so the CSS transition uses the linear easing token); under
 * reduced motion the ring is replaced by "in 3.1s". `aria-hidden` — the button label speaks.
 */

import { COPY } from "../copy";
import { instantiate, part } from "../template";
import { isReducedMotion } from "../theme";
import html from "../views/templates/components/ring.html?raw";

/** Matches `r="10"` in `ring.html` (viewBox 24 with a 2 px stroke). */
export const RING_RADIUS = 10;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const MS_PER_SECOND = 1000;

export interface CountdownRingOptions {
	/** `sm` = 20 px (plan line), `md` = 24 px (inside the play button). */
	size?: "sm" | "md";
}

export interface CountdownRingHandle {
	readonly el: HTMLElement;
	readonly remainingMs: number;
	update(remainingMs: number, totalMs: number): void;
	/** Freeze the visual (cancel-on-hover); the underlying plan keeps time. */
	pause(): void;
	resume(): void;
	dispose(): void;
}

export function createCountdownRing(
	host: HTMLElement | null,
	options: CountdownRingOptions = {}
): CountdownRingHandle {
	const el = instantiate(html);
	const svg = part<HTMLElement>(el, ".sl-ring__svg");
	const progress = part<HTMLElement>(el, ".sl-ring__progress");
	const text = part(el, ".sl-ring__text");
	el.classList.add(`sl-ring--${options.size ?? "sm"}`);
	progress.setAttribute("stroke-dasharray", String(RING_CIRCUMFERENCE));
	progress.setAttribute("stroke-dashoffset", "0");

	let remaining = 0;
	let total = 0;
	let paused = false;

	function paint(): void {
		const reduced = isReducedMotion();
		el.classList.toggle("sl-ring--text", reduced);
		svg.toggleAttribute("hidden", reduced); // SVG elements have no `hidden` property
		text.hidden = !reduced;
		if (reduced) {
			text.textContent = COPY.ring.remaining((Math.max(0, remaining) / MS_PER_SECOND).toFixed(1));
			return;
		}
		const fraction = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
		progress.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - fraction)));
	}

	paint();
	host?.append(el);

	return {
		el,
		get remainingMs() {
			return remaining;
		},
		update(remainingMs, totalMs) {
			remaining = remainingMs;
			total = totalMs;
			if (!paused) paint();
		},
		pause() {
			paused = true;
			el.classList.add("sl-ring--paused");
		},
		resume() {
			paused = false;
			el.classList.remove("sl-ring--paused");
			paint();
		},
		dispose() {
			el.remove();
		},
	};
}
