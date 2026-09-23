/**
 * The numeric readout under the thumb for sliders whose resting text is a label: shown while the
 * value changes, faded out `UI_TIMINGS.sliderReadoutFadeMs` after the last change.
 */

import { UI_TIMINGS } from "@core/constants/ui";

export interface Readout {
	/** Show the readout for this change and (re)start its fade-out timer (no-op without a format). */
	show(value: number): void;
	hide(): void;
}

export function createReadout(
	el: HTMLElement,
	readoutEl: HTMLElement,
	format: ((value: number) => string) | null
): Readout {
	let readoutTimer: ReturnType<typeof setTimeout> | null = null;
	if (format) {
		el.classList.add("sl-slider--has-readout");
		readoutEl.hidden = false;
	}
	return {
		show(value) {
			if (!format) return;
			if (readoutTimer !== null) clearTimeout(readoutTimer);
			readoutEl.textContent = format(value);
			el.classList.add("sl-slider--readout");
			readoutTimer = setTimeout(() => {
				readoutTimer = null;
				el.classList.remove("sl-slider--readout");
			}, UI_TIMINGS.sliderReadoutFadeMs);
		},
		hide() {
			if (readoutTimer !== null) {
				clearTimeout(readoutTimer);
				readoutTimer = null;
			}
			el.classList.remove("sl-slider--readout");
		},
	};
}
