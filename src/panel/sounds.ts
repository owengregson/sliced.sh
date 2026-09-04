/**
 * UI sounds (Appendix F §6.6): every UI event maps to a `SOUNDS` file, gated by
 * `Settings.display.uiSounds` (the shell calls `setUiSoundsEnabled` from each snapshot), and
 * played from `chrome.runtime.getURL("assets/sounds/…")` through the runtime wrapper.
 */

import { runtimeGetURL } from "@core/chrome/runtime";
import { SOUNDS } from "@core/constants/sounds";
import { log } from "@core/logger";

export type UiSoundEvent =
	| "toggleOn"
	| "toggleOff"
	| "arm"
	| "disarm"
	| "sliderRelease"
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
	sliderRelease: "slide",
	stepper: "smallSlide",
	keybindSaved: "tick",
	movePlayed: "makeMove",
	assistantDisabled: "slamLow",
	assistantEnabled: "guiOpen",
};

export const SOUNDS_DIR = "assets/sounds/";

export interface SoundSource {
	play(): Promise<void> | void;
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
	urlFor(event: UiSoundEvent): string;
}

export function createSoundPlayer(factory: SoundFactory = defaultFactory): SoundPlayer {
	let enabled = false;
	const urlFor = (event: UiSoundEvent): string =>
		runtimeGetURL(`${SOUNDS_DIR}${SOUNDS[UI_SOUND_MAP[event]]}`);
	return {
		get enabled() {
			return enabled;
		},
		setEnabled(next) {
			enabled = next;
		},
		urlFor,
		play(event) {
			if (!enabled) return false;
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

export function setUiSoundsEnabled(enabled: boolean): void {
	shared.setEnabled(enabled);
}

/** Swap the shared player (tests). Returns the previous one. */
export function setUiSoundPlayer(player: SoundPlayer): SoundPlayer {
	const prev = shared;
	shared = player;
	return prev;
}
