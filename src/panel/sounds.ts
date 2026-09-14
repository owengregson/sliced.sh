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

// ── detent scheduler ────────────────────────────────────────────────────────────────────────

export interface DetentRange {
	min: number;
	max: number;
	step: number;
}

/** One audible slider tick: where the thumb is (0..1, sets the pitch) and how loud (0..1). */
export interface SliderTick {
	position: number;
	gain: number;
	kind: "detent" | "settle";
}

export interface DetentScheduler {
	/** The pointer went down at `value` (the value *before* the press moves it). */
	press(value: number): void;
	/** The thumb moved to `value` under the pointer; a tick when a detent was crossed and the limiter allows it. */
	move(value: number): SliderTick | null;
	/** A keyboard step to `value`: always a tick when the value changed (the cap still holds). */
	key(value: number): SliderTick | null;
	/** The pointer let go at `value`: a soft settle tick only when the value changed since the press. */
	release(value: number): SliderTick | null;
	/** The slider's range changed (the detent grouping follows). */
	setRange(range: DetentRange): void;
	/** Audible detent crossings from one end of the range to the other (≤ `maxDetents`). */
	readonly detents: number;
}

const MS_PER_S = 1_000;

/** Volume multiplier for a crossing speed in detents per second: full when slow, quieter when fast. */
export function gainForSpeed(detentsPerSec: number): number {
	const { slowDetentsPerSec, fastDetentsPerSec, minFraction } = SLIDER_SOUND.volumeAtSpeed;
	if (detentsPerSec <= slowDetentsPerSec) return 1;
	if (detentsPerSec >= fastDetentsPerSec) return minFraction;
	const t = (detentsPerSec - slowDetentsPerSec) / (fastDetentsPerSec - slowDetentsPerSec);
	return 1 - t * (1 - minFraction);
}

export function createDetentScheduler(
	initial: DetentRange,
	now: () => number = Date.now
): DetentScheduler {
	let range = initial;
	let steps = 1;
	let group = 1;
	/** Detent index of the last value seen (press, move or key); `null` before any press. */
	let lastDetent: number | null = null;
	let lastValue: number | null = null;
	/** When the last detent crossing happened, for the crossing speed. */
	let lastCrossingAt = Number.NEGATIVE_INFINITY;
	/** The last detent that actually ticked, for the every-k-th thinning. */
	let lastTickDetent: number | null = null;
	let lastTickAt = Number.NEGATIVE_INFINITY;
	let pressValue: number | null = null;
	let crossingsSincePress = 0;
	const minIntervalMs = MS_PER_S / SLIDER_SOUND.maxTicksPerSecond;

	function regroup(): void {
		const span = range.step > 0 ? (range.max - range.min) / range.step : 0;
		steps = Math.max(1, Math.round(span));
		group = Math.max(1, Math.ceil(steps / SLIDER_SOUND.maxDetents));
	}
	regroup();

	const positionOf = (value: number): number =>
		range.max > range.min ? clamp((value - range.min) / (range.max - range.min), 0, 1) : 0;
	const detentOf = (value: number): number =>
		Math.floor(Math.round((value - range.min) / range.step) / group);

	function tick(value: number, gain: number, kind: SliderTick["kind"], at: number): SliderTick {
		lastTickAt = at;
		lastTickDetent = detentOf(value);
		return { position: positionOf(value), gain, kind };
	}

	return {
		get detents() {
			return Math.floor(steps / group);
		},
		setRange(next) {
			range = next;
			regroup();
			lastDetent = lastValue === null ? null : detentOf(lastValue);
		},
		press(value) {
			pressValue = value;
			lastValue = value;
			lastDetent = detentOf(value);
			lastCrossingAt = now();
			crossingsSincePress = 0;
			lastTickDetent = null;
		},
		move(value) {
			const at = now();
			const detent = detentOf(value);
			const previous = lastDetent ?? detent;
			lastValue = value;
			if (detent === previous) return null;
			lastDetent = detent;
			const crossed = Math.abs(detent - previous);
			// The first crossing after the press is the deliberate one: full volume, no thinning.
			// After that the speed is the crossings over the time since the previous crossing.
			const speed =
				crossingsSincePress === 0 ? 0 : (crossed * MS_PER_S) / Math.max(1, at - lastCrossingAt);
			crossingsSincePress += 1;
			lastCrossingAt = at;
			const k = Math.max(1, Math.ceil(speed / SLIDER_SOUND.maxTicksPerSecond));
			const dueByDetent = lastTickDetent === null || Math.abs(detent - lastTickDetent) >= k;
			const dueByTime = at - lastTickAt >= minIntervalMs;
			if (!dueByDetent || !dueByTime) return null;
			return tick(value, gainForSpeed(speed), "detent", at);
		},
		key(value) {
			const at = now();
			const changed = lastValue !== value;
			lastValue = value;
			lastDetent = detentOf(value);
			if (!changed || at - lastTickAt < minIntervalMs) return null;
			return tick(value, 1, "detent", at);
		},
		release(value) {
			const from = pressValue;
			pressValue = null;
			lastValue = value;
			lastDetent = detentOf(value);
			if (from === null || from === value) return null;
			return tick(value, SLIDER_SOUND.settleFraction, "settle", now());
		},
	};
}

// ── the player ──────────────────────────────────────────────────────────────────────────────

export interface SoundPlayer {
	readonly enabled: boolean;
	setEnabled(enabled: boolean): void;
	play(event: UiSoundEvent): boolean;
	/** Play one scheduled slider tick: pitch from its position, volume from its gain. */
	slider(tick: SliderTick): boolean;
	urlFor(event: UiSoundEvent): string;
}

export function createSoundPlayer(factory: SoundFactory = defaultFactory): SoundPlayer {
	let enabled = false;
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
		slider(tick) {
			if (!enabled || !Number.isFinite(tick.position) || !Number.isFinite(tick.gain)) return false;
			const fraction = clamp(tick.position, 0, 1);
			try {
				const source = factory(urlFor("sliderMove"));
				if (!source) return false;
				sliderSource?.pause?.();
				sliderSource = source;
				source.preservesPitch = false;
				source.playbackRate = SLIDER_SOUND.pitchMin + fraction * SLIDER_SOUND.pitchRange;
				source.volume = clamp(SLIDER_SOUND.volume * clamp(tick.gain, 0, 1), 0, 1);
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
