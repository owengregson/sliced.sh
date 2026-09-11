/**
 * UI sounds (Appendix F §6.6): every UI event maps to a `SOUNDS` file, gated by
 * `Settings.display.uiSounds` (the shell calls `setUiSoundsEnabled` from each snapshot), and
 * played from `chrome.runtime.getURL("assets/sounds/…")` through the runtime wrapper.
 */

import { runtimeGetURL } from "@core/chrome/runtime";
import { SLIDER_SOUND, SOUNDS, SOUNDS_DIR } from "@core/constants/sounds";
import { log } from "@core/logger";
import { clamp } from "@core/util/clamp";

export type UiSoundEvent =
	| "toggleOn"
	| "toggleOff"
	| "arm"
	| "disarm"
	| "sliderMove"
	| "navigate"
	| "stepper"
	| "keybindSaved"
	| "movePlayed"
	| "assistantDisabled"
	| "assistantEnabled";

/** Appendix F §6.6 mapping. `slamLight`, `slamHeavy` and `guiOff` are retired. */
export const UI_SOUND_MAP: Readonly<Record<UiSoundEvent, keyof typeof SOUNDS>> = {
	toggleOn: "clickLight",
	toggleOff: "clickLightOff",
	arm: "clickHeavy",
	disarm: "clickHeavyOff",
	sliderMove: "smallSlide",
	navigate: "clickLight",
	stepper: "smallSlide",
	keybindSaved: "tick",
	movePlayed: "makeMove",
	assistantDisabled: "slamLow",
	assistantEnabled: "guiOpen",
};

export interface SoundSource {
	play(): Promise<void> | void;
	pause?(): void;
	playbackRate?: number;
	preservesPitch?: boolean;
	volume?: number;
}

export type SoundFactory = (url: string) => SoundSource | null;

function defaultFactory(url: string): SoundSource | null {
	const w = globalThis as { Audio?: new (src: string) => SoundSource };
	if (typeof w.Audio !== "function") return null;
	try {
		return new w.Audio(url);
	} catch {
		return null;
	}
}

export interface SoundPlayer {
	readonly enabled: boolean;
	setEnabled(enabled: boolean): void;
	play(event: UiSoundEvent): boolean;
	slider(position: number, phase?: "move" | "release"): boolean;
	urlFor(event: UiSoundEvent): string;
}

export function createSoundPlayer(factory: SoundFactory = defaultFactory): SoundPlayer {
	let enabled = false;
	let lastSliderAt = Number.NEGATIVE_INFINITY;
	let lastSliderPosition = Number.NEGATIVE_INFINITY;
	let sliderSource: SoundSource | null = null;
	const urlFor = (event: UiSoundEvent): string =>
		runtimeGetURL(`${SOUNDS_DIR}${SOUNDS[UI_SOUND_MAP[event]]}`);
	return {
		get enabled() {
			return enabled;
		},
		setEnabled(next) {
			enabled = next;
			if (!next) {
				sliderSource?.pause?.();
				sliderSource = null;
			}
		},
		urlFor,
		slider(position, phase = "move") {
			if (!enabled || !Number.isFinite(position)) return false;
			const fraction = clamp(position, 0, 1);
			const now = Date.now();
			if (
				phase !== "release" &&
				(now - lastSliderAt < SLIDER_SOUND.intervalMs ||
					Math.abs(fraction - lastSliderPosition) < SLIDER_SOUND.minDelta)
			)
				return false;
			try {
				const source = factory(urlFor("sliderMove"));
				if (!source) return false;
				sliderSource?.pause?.();
				sliderSource = source;
				source.preservesPitch = false;
				source.playbackRate = SLIDER_SOUND.pitchMin + fraction * SLIDER_SOUND.pitchRange;
				source.volume = SLIDER_SOUND.volume;
				lastSliderAt = now;
				lastSliderPosition = fraction;
				const result = source.play();
				if (result && typeof result.catch === "function")
					result.catch((error: unknown) => log.debug("sounds: slider rejected", { error }));
				return true;
			} catch (error) {
				log.debug("sounds: slider failed", { error });
				return false;
			}
		},
		play(event) {
			if (!enabled || event === "movePlayed") return false;
			try {
				const source = factory(urlFor(event));
				if (!source) return false;
				const result = source.play();
				if (result && typeof result.catch === "function")
					result.catch((error: unknown) => log.debug("sounds: play rejected", { event, error }));
				return true;
			} catch (error) {
				log.debug("sounds: play failed", { event, error });
				return false;
			}
		},
	};
}

/** Shared player used by components; the shell gates it from `display.uiSounds`. */
let shared: SoundPlayer = createSoundPlayer();

export function playUiSound(event: UiSoundEvent): boolean {
	return shared.play(event);
}

export function playSliderSound(position: number, phase: "move" | "release" = "move"): boolean {
	return shared.slider(position, phase);
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
