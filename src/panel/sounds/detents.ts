/**
 * The per-slider scrub-sound scheduler (2026-09-13): the slider's steps are grouped into at most
 * `SLIDER_SOUND.maxDetents` audible detents, a tick may play only when the thumb crosses one, a
 * rate limiter keeps ticks at or under `SLIDER_SOUND.maxTicksPerSecond` by thinning to every k-th
 * detent at high crossing rates, the volume falls with the crossing speed, keyboard steps always
 * tick, and the release plays one softer settle tick only when the value changed since the press.
 * Pure: the clock is injected.
 */

import { SLIDER_SOUND } from "@core/constants/sounds";
import { clamp } from "@core/util/clamp";

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
