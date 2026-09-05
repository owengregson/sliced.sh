/**
 * The brand mark in a view (Appendix F §4.1 / §4.8 / §4.10): sourced through the runtime
 * wrapper, never recoloured, and host of the easter egg — `UI_TIMINGS.easterEggClicks` clicks
 * inside `UI_TIMINGS.easterEggWindowMs` open the cat-facts popover. The window is a timer so
 * it is deterministic under fake time; the returned cleanup clears it and closes the popover.
 */

import { runtimeGetURL } from "@core/chrome/runtime";
import { IMAGES } from "@core/constants/images";
import { UI_TIMINGS } from "@core/constants/ui";
import type { PopoverHandle } from "../components/popover";
import { openCatFacts } from "./cat-facts";

export function mountMark(img: HTMLImageElement): () => void {
	img.src = runtimeGetURL(IMAGES.mark);
	let clicks = 0;
	let windowTimer: ReturnType<typeof setTimeout> | null = null;
	let popover: PopoverHandle | null = null;

	const reset = (): void => {
		clicks = 0;
		if (windowTimer !== null) {
			clearTimeout(windowTimer);
			windowTimer = null;
		}
	};
	const onClick = (): void => {
		if (clicks === 0) windowTimer = setTimeout(reset, UI_TIMINGS.easterEggWindowMs);
		clicks += 1;
		if (clicks < UI_TIMINGS.easterEggClicks) return;
		reset();
		popover?.close();
		popover = openCatFacts(img);
	};
	img.addEventListener("click", onClick);

	return () => {
		img.removeEventListener("click", onClick);
		reset();
		popover?.close();
		popover = null;
	};
}
