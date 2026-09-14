// test/panel/sounds.test.ts — Appendix F §6.6 mapping, gated by display.uiSounds, played from
// chrome.runtime.getURL("assets/sounds/…"); the detent scheduler behind the slider scrub sounds
// (settings layout, 2026-09-13) against a fake clock.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LIMITS, SOUNDS, SOUNDS_DIR } from "@core/constants";
import { SLIDER_SOUND } from "@core/constants/sounds";
import {
	createDetentScheduler,
	createSoundPlayer,
	type DetentScheduler,
	gainForSpeed,
	playUiSound,
	type SliderTick,
	setUiSoundPlayer,
	setUiSoundsEnabled,
	UI_SOUND_MAP,
	type UiSoundEvent,
} from "@panel/sounds";
import { bootPanelDom, type PanelDom } from "./dom";

let dom: PanelDom;

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	await dom.teardown();
});

describe("ui sounds", () => {
	it("maps every event per §6.6 and never uses the retired files", () => {
		expect(UI_SOUND_MAP).toEqual({
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
		});
		const used = new Set(Object.values(UI_SOUND_MAP));
		expect(used.has("slamLight")).toBe(false);
		expect(used.has("slamHeavy")).toBe(false);
		expect(used.has("guiOff")).toBe(false);
	});

	it("plays a slider tick with pitch from its position and volume from its gain, stopping the previous sample", () => {
		const samples: Array<{
			playbackRate?: number;
			preservesPitch?: boolean;
			volume?: number;
			pauses: number;
			play(): void;
			pause(): void;
		}> = [];
		const player = createSoundPlayer(() => {
			const source = {
				pauses: 0,
				play() {},
				pause() {
					this.pauses++;
				},
			};
			samples.push(source);
			return source;
		});
		const tick = (position: number, gain = 1): SliderTick => ({ position, gain, kind: "detent" });
		expect(player.slider(tick(0))).toBe(false);
		player.setEnabled(true);
		expect(player.slider(tick(0))).toBe(true);
		expect(player.slider(tick(1))).toBe(true);
		expect(samples).toHaveLength(2);
		expect(samples[0]?.pauses).toBe(1);
		expect(samples[0]?.preservesPitch).toBe(false);
		expect(samples[0]?.playbackRate).toBe(SLIDER_SOUND.pitchMin);
		expect(samples[1]?.playbackRate).toBe(SLIDER_SOUND.pitchMin + SLIDER_SOUND.pitchRange);
		expect(samples[1]?.volume).toBe(SLIDER_SOUND.volume);
		// The gain scales the volume; a settle tick is the same sample, quieter.
		expect(player.slider({ position: 0.5, gain: SLIDER_SOUND.settleFraction, kind: "settle" })).toBe(
			true
		);
		expect(samples[2]?.volume).toBeCloseTo(SLIDER_SOUND.volume * SLIDER_SOUND.settleFraction);
		expect(samples[1]?.pauses).toBe(1);
		// The player is the gate: disabling stops the sample that is playing and refuses more.
		player.setEnabled(false);
		expect(samples[2]?.pauses).toBe(1);
		expect(player.slider(tick(0.5))).toBe(false);
		expect(player.slider(tick(Number.NaN))).toBe(false);
	});

	it("is gated and plays through the runtime URL", () => {
		const played: string[] = [];
		const player = createSoundPlayer((url) => {
			played.push(url);
			return { play: () => undefined };
		});
		expect(player.play("arm")).toBe(false);
		player.setEnabled(true);
		expect(player.play("arm")).toBe(true);
		expect(played).toEqual([
			`chrome-extension://${dom.sim.extensionId}/${SOUNDS_DIR}${SOUNDS.clickHeavy}`,
		]);
		const prev = setUiSoundPlayer(player);
		setUiSoundsEnabled(false);
		expect(playUiSound("movePlayed")).toBe(false);
		setUiSoundsEnabled(true);
		expect(playUiSound("movePlayed" satisfies UiSoundEvent)).toBe(false);
		expect(played.some((url) => url.includes(SOUNDS.makeMove))).toBe(false);
		setUiSoundPlayer(prev);
	});
});

// ── the detent scheduler ─────────────────────────────────────────────────────────────────────

/** A scheduler on a fake clock; `drag` moves through `values` `gapMs` apart and collects the ticks. */
function scheduler(range: { min: number; max: number; step: number }): {
	s: DetentScheduler;
	clock: { now: number };
	drag(values: number[], gapMs: number): SliderTick[];
} {
	const clock = { now: 1_000 };
	const s = createDetentScheduler(range, () => clock.now);
	return {
		s,
		clock,
		drag(values, gapMs) {
			const ticks: SliderTick[] = [];
			for (const v of values) {
				clock.now += gapMs;
				const tick = s.move(v);
				if (tick) ticks.push(tick);
			}
			return ticks;
		},
	};
}

const MIN_INTERVAL_MS = 1_000 / SLIDER_SOUND.maxTicksPerSecond;

describe("createDetentScheduler", () => {
	it("groups steps so no slider exceeds maxDetents, and a short slider keeps one detent per step", () => {
		// 20 steps: a detent per step.
		expect(createDetentScheduler({ min: 0, max: 2, step: 0.1 }).detents).toBe(20);
		// The rating slider: 68 steps of 50 → 3 steps per detent, 22 crossings end to end.
		const elo = createDetentScheduler({ min: LIMITS.eloMin, max: LIMITS.eloMax, step: 50 });
		expect(elo.detents).toBeLessThanOrEqual(SLIDER_SOUND.maxDetents);
		expect(elo.detents).toBe(Math.floor(68 / 3));
		// 0–100 by 1: 100 steps → 5 per detent → 20 crossings.
		expect(createDetentScheduler({ min: 0, max: 100, step: 1 }).detents).toBe(20);
		for (const step of [1, 0.5, 0.05, 25, 50, 10]) {
			for (const span of [1, 2, 3, 100, 400, 800, 3_400]) {
				expect(
					createDetentScheduler({ min: 0, max: span, step }).detents,
					`span ${span} step ${step}`
				).toBeLessThanOrEqual(SLIDER_SOUND.maxDetents);
			}
		}
	});

	it("a slow drag ticks on every detent, at full volume, with pitch following position", () => {
		const { s, drag } = scheduler({ min: 0, max: 2, step: 0.1 });
		s.press(1);
		// One step every 300 ms (3⅓ detents/s, under `slowDetentsPerSec`): every crossing is a
		// tick at full volume.
		const gapMs = Math.ceil(1_000 / SLIDER_SOUND.volumeAtSpeed.slowDetentsPerSec) + 50;
		const ticks = drag([1.1, 1.2, 1.3, 1.4, 1.5], gapMs);
		expect(ticks).toHaveLength(5);
		expect(ticks.every((t) => t.gain === 1 && t.kind === "detent")).toBe(true);
		expect(ticks.map((t) => t.position)).toEqual([0.55, 0.6, 0.65, 0.7, 0.75]);
		// Back the other way ticks too.
		expect(drag([1.4, 1.3], gapMs)).toHaveLength(2);
	});

	it("never ticks without a detent crossing", () => {
		const { s, drag } = scheduler({ min: 0, max: 100, step: 1 });
		s.press(50);
		// Five steps per detent: moving within a detent group is silent …
		expect(drag([51, 52, 53, 54], 100)).toHaveLength(0);
		// … and the crossing ticks once.
		expect(drag([55], 100)).toHaveLength(1);
		// The same value again (a pointer jitter that snapped to the same step) is silent.
		expect(drag([55, 55, 55], 100)).toHaveLength(0);
		// A fine slider: every step is a detent, but a repeated value never ticks.
		const fine = scheduler({ min: 0, max: 2, step: 0.1 });
		fine.s.press(1);
		expect(fine.drag([1, 1, 1], 100)).toHaveLength(0);
	});

	it("a fast drag never exceeds maxTicksPerSecond and is quieter than a deliberate step", () => {
		const { s, drag, clock } = scheduler({ min: 0, max: 2, step: 0.1 });
		s.press(0);
		// A sweep across all 20 detents in 200 ms (100 detents/s), one step per 10 ms.
		const start = clock.now;
		const values = Array.from({ length: 20 }, (_, i) => Number(((i + 1) * 0.1).toFixed(1)));
		const ticks = drag(values, 10);
		const elapsedS = (clock.now - start) / 1_000;
		expect(ticks.length).toBeGreaterThan(0);
		expect(ticks.length).toBeLessThanOrEqual(
			Math.ceil(SLIDER_SOUND.maxTicksPerSecond * elapsedS) + 1
		);
		// The first crossing after the press is the deliberate one; every tick after it is quieter.
		expect(ticks[0]?.gain).toBe(1);
		for (const t of ticks.slice(1)) expect(t.gain).toBeLessThan(1);
		expect(ticks.at(-1)?.gain).toBe(SLIDER_SOUND.volumeAtSpeed.minFraction);
	});

	it("keeps the cap over a long fast drag by thinning to every k-th detent", () => {
		const { s, drag, clock } = scheduler({ min: 0, max: 100, step: 1 });
		s.press(0);
		// Back and forth across the whole range for two seconds at 200 detents/s.
		const start = clock.now;
		const values: number[] = [];
		for (let round = 0; round < 20; round++)
			for (let i = 1; i <= 20; i++) values.push(round % 2 === 0 ? i * 5 : 100 - i * 5);
		const ticks = drag(values, 5);
		const elapsedS = (clock.now - start) / 1_000;
		expect(elapsedS).toBe(2);
		expect(ticks.length).toBeLessThanOrEqual(SLIDER_SOUND.maxTicksPerSecond * elapsedS + 1);
		// It still ticks steadily — a ripple, not silence.
		expect(ticks.length).toBeGreaterThanOrEqual(SLIDER_SOUND.maxTicksPerSecond * elapsedS * 0.5);
		// No two ticks closer than the cap allows (the same drag on a fresh scheduler, timestamped).
		const timed = scheduler({ min: 0, max: 100, step: 1 });
		timed.s.press(0);
		const stamps: number[] = [];
		for (const v of values) {
			timed.clock.now += 5;
			if (timed.s.move(v)) stamps.push(timed.clock.now);
		}
		expect(stamps).toHaveLength(ticks.length);
		let last = Number.NEGATIVE_INFINITY;
		for (const at of stamps) {
			expect(at - last).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
			last = at;
		}
	});

	it("the volume follows the crossing speed: full when slow, the floor when fast, linear between", () => {
		const { slowDetentsPerSec, fastDetentsPerSec, minFraction } = SLIDER_SOUND.volumeAtSpeed;
		expect(gainForSpeed(0)).toBe(1);
		expect(gainForSpeed(slowDetentsPerSec)).toBe(1);
		expect(gainForSpeed(fastDetentsPerSec)).toBe(minFraction);
		expect(gainForSpeed(fastDetentsPerSec * 10)).toBe(minFraction);
		const mid = (slowDetentsPerSec + fastDetentsPerSec) / 2;
		expect(gainForSpeed(mid)).toBeCloseTo((1 + minFraction) / 2);
		expect(gainForSpeed(mid)).toBeLessThan(gainForSpeed(slowDetentsPerSec + 1));
	});

	it("release plays one soft settle tick only when the value changed since the press", () => {
		const { s, drag, clock } = scheduler({ min: 0, max: 2, step: 0.1 });
		// Press and release on the same value: silent.
		s.press(1);
		clock.now += 100;
		expect(s.release(1)).toBeNull();
		// Press, drag away and back to where it started: silent (the value did not change).
		s.press(1);
		drag([1.1, 1.2, 1.1, 1], 100);
		clock.now += 100;
		expect(s.release(1)).toBeNull();
		// Press, drag, release elsewhere: one settle tick, quieter, at the release position.
		s.press(1);
		drag([1.1, 1.2], 100);
		clock.now += 100;
		const settle = s.release(1.2);
		expect(settle).toEqual({ position: 0.6, gain: SLIDER_SOUND.settleFraction, kind: "settle" });
		// A second release without a press is silent.
		expect(s.release(1.2)).toBeNull();
	});

	it("keyboard steps always tick, even inside a detent group, and key repeat still respects the cap", () => {
		const { s, clock } = scheduler({ min: LIMITS.eloMin, max: LIMITS.eloMax, step: 50 });
		// Three steps per detent on the rating slider; each arrow press is still a tick.
		clock.now += 500;
		expect(s.key(1_250)).toEqual({ position: 0.25, gain: 1, kind: "detent" });
		clock.now += 500;
		expect(s.key(1_300)?.gain).toBe(1);
		// The same value again (Home at the minimum, say) is not a change.
		clock.now += 500;
		expect(s.key(1_300)).toBeNull();
		// Key auto-repeat faster than the cap is thinned.
		let ticks = 0;
		let value = 1_300;
		for (let i = 0; i < 40; i++) {
			clock.now += 20;
			value += 50;
			if (s.key(value)) ticks++;
		}
		expect(ticks).toBeLessThanOrEqual(Math.ceil((40 * 20) / MIN_INTERVAL_MS) + 1);
		expect(ticks).toBeGreaterThan(1);
	});

	it("a range change regroups the detents", () => {
		const s = createDetentScheduler({ min: 0, max: 20, step: 1 });
		expect(s.detents).toBe(20);
		s.setRange({ min: 0, max: 100, step: 1 });
		expect(s.detents).toBe(20);
		s.setRange({ min: 0, max: 5, step: 1 });
		expect(s.detents).toBe(5);
	});
});
