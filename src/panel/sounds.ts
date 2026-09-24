/**
 * UI sounds (Appendix F §6.6): every UI event maps to a `SOUNDS` file, gated by
 * `Settings.display.uiSounds` (the shell calls `setUiSoundsEnabled` from each snapshot), and
 * played from `chrome.runtime.getURL("assets/sounds/…")` through the runtime wrapper.
 *
 * Slider scrubbing (2026-09-13) is scheduled per slider by `createDetentScheduler`: the slider's
 * steps are grouped into at most `SLIDER_SOUND.maxDetents` audible detents, a tick may play only
 * when the thumb crosses one, a per-slider rate limiter keeps ticks at or under
 * `SLIDER_SOUND.maxTicksPerSecond` by thinning to every k-th detent at high crossing rates, the
 * volume falls with the crossing speed, keyboard steps always tick, and the release plays one
 * softer settle tick only when the value changed since the press. The scheduler is pure (a
 * clock is injected); the shared player only turns a tick into a pitch-mapped sample.
 */

import type { SliderTick } from "./sounds/detents";
import { createSoundPlayer, type SoundPlayer, type UiSoundEvent } from "./sounds/player";

export {
	createDetentScheduler,
	type DetentRange,
	type DetentScheduler,
	gainForSpeed,
	type SliderTick,
} from "./sounds/detents";
export {
	createSoundPlayer,
	type SoundFactory,
	type SoundPlayer,
	type SoundSource,
	UI_SOUND_MAP,
	type UiSoundEvent,
} from "./sounds/player";

/** Shared player used by components; the shell gates it from `display.uiSounds`. */
let shared: SoundPlayer = createSoundPlayer();

export function playUiSound(event: UiSoundEvent): boolean {
	return shared.play(event);
}

export function playSliderSound(tick: SliderTick): boolean {
	return shared.slider(tick);
}

export function setUiSoundsEnabled(enabled: boolean): void {
	shared.setEnabled(enabled);
}

/** Swap the shared player (tests). Returns the previous one. */
export function setUiSoundPlayer(player: SoundPlayer): SoundPlayer {
	const prev = shared;
	shared = player;
	return prev;
}
