// test/panel/components/slider.test.ts — Appendix F §5.3: keyboard steps, Shift ×10, Home/End,
// bubble text from the human-label function, danger zone hint; the detent-scheduled scrub sounds
// and the numeric readout under the thumb (settings layout, 2026-09-13).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LIMITS } from "@core/constants";
import { MAIA } from "@core/constants/maia";
import { SLIDER_SOUND, SOUNDS } from "@core/constants/sounds";
import { STRENGTH_UI, UI_TIMINGS } from "@core/constants/ui";
import { TOKENS } from "@design/tokens.generated";
import { createSlider, type SliderHandle } from "@panel/components/slider";
import { COPY } from "@panel/copy";
import {
	createSoundPlayer,
	type SoundPlayer,
	type SoundSource,
	setUiSoundPlayer,
} from "@panel/sounds";
import { bootPanelDom, key, mount, type PanelDom, pointer } from "../dom";

let dom: PanelDom;
let handle: SliderHandle | null = null;
let previousSoundPlayer: SoundPlayer | null = null;

beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	handle?.dispose();
	handle = null;
	if (previousSoundPlayer) setUiSoundPlayer(previousSoundPlayer);
	previousSoundPlayer = null;
	await dom.teardown();
});

const band = (v: number): string =>
	v < 800 ? "Casual" : v < 1400 ? "Club" : v < 2000 ? "Expert" : v < 2600 ? "Master" : "Elite";
const label = (v: number): string => `${band(v)} ${v}`;

describe("createSlider", () => {
	it("exposes a slider role with value text from the label function and steps with the keyboard", () => {
		const seen: Array<[number, boolean]> = [];
		const el = mount(document.createElement("div"));
		handle = createSlider(el, {
			min: LIMITS.eloMin,
			max: LIMITS.eloMax,
			step: 50,
			value: 1200,
			label,
			onChange: (v, commit) => seen.push([v, commit]),
		});
		const thumb = handle.el.querySelector<HTMLElement>(".sl-slider__thumb");
		if (!thumb) throw new Error("no thumb");
		expect(thumb.getAttribute("role")).toBe("slider");
		expect(thumb.getAttribute("tabindex")).toBe("0");
		expect(thumb.getAttribute("aria-valuemin")).toBe(String(LIMITS.eloMin));
		expect(thumb.getAttribute("aria-valuemax")).toBe(String(LIMITS.eloMax));
		expect(thumb.getAttribute("aria-valuenow")).toBe("1200");
		expect(thumb.getAttribute("aria-valuetext")).toBe("Club 1200");
		expect(handle.el.querySelector(".sl-slider__bubble")?.textContent).toBe("Club 1200");
		expect(handle.el.querySelector(".sl-slider__value")?.textContent).toBe("1200");
		expect(handle.el.querySelector<HTMLElement>(".sl-slider__fill")?.style.width).toBe(
			`${(((1200 - LIMITS.eloMin) / (LIMITS.eloMax - LIMITS.eloMin)) * 100).toFixed(3)}%`
		);

		key(thumb, "keydown", { key: "ArrowRight" });
		expect(handle.value).toBe(1250);
		key(thumb, "keydown", { key: "ArrowUp" });
		expect(handle.value).toBe(1300);
		key(thumb, "keydown", { key: "ArrowLeft", shiftKey: true });
		expect(handle.value).toBe(800);
		key(thumb, "keydown", { key: "ArrowRight", shiftKey: true });
		expect(handle.value).toBe(1300);
		key(thumb, "keydown", { key: "PageUp" });
		expect(handle.value).toBe(1800);
		key(thumb, "keydown", { key: "PageDown" });
		expect(handle.value).toBe(1300);
		key(thumb, "keydown", { key: "Home" });
		expect(handle.value).toBe(LIMITS.eloMin);
		key(thumb, "keydown", { key: "End" });
		expect(handle.value).toBe(LIMITS.eloMax);
		expect(thumb.getAttribute("aria-valuetext")).toBe(`Elite ${LIMITS.eloMax}`);
		expect(handle.el.querySelector(".sl-slider__bubble")?.textContent).toBe(`Elite ${LIMITS.eloMax}`);
		// Every keyboard step commits (there is no separate release).
		expect(seen.every(([, commit]) => commit)).toBe(true);
		expect(seen.map(([v]) => v)).toEqual([
			1250,
			1300,
			800,
			1300,
			1800,
			1300,
			LIMITS.eloMin,
			LIMITS.eloMax,
		]);
	});

	it("clamps and snaps programmatic values, shows the danger hint past the threshold, and honours disabled", () => {
		const el = mount(document.createElement("div"));
		handle = createSlider(el, {
			min: LIMITS.eloMin,
			max: LIMITS.eloMax,
			step: 50,
			value: 1200,
			label,
			danger: (v) => v >= 2600,
			dangerHint: COPY.strength.warning,
			onChange: () => {},
		});
		expect(handle.el.classList.contains("sl-slider--danger")).toBe(false);
		expect(handle.el.querySelector(".sl-slider__hint")?.hasAttribute("hidden")).toBe(true);
		handle.update({ value: 2612 });
		expect(handle.value).toBe(2600);
		expect(handle.el.classList.contains("sl-slider--danger")).toBe(true);
		expect(handle.el.querySelector(".sl-slider__hint")?.textContent).toBe(COPY.strength.warning);
		handle.update({ value: 99_999 });
		expect(handle.value).toBe(LIMITS.eloMax);
		handle.update({ disabled: true, value: 1000 });
		const thumb = handle.el.querySelector<HTMLElement>(".sl-slider__thumb");
		expect(thumb?.getAttribute("aria-disabled")).toBe("true");
		expect(thumb?.getAttribute("tabindex")).toBe("-1");
		if (thumb) key(thumb, "keydown", { key: "ArrowRight" });
		expect(handle.value).toBe(1000);
	});

	it("pointer drag tracks and commits the value with a final pitch-matched release tick", async () => {
		const seen: Array<[number, boolean]> = [];
		const samples: Array<SoundSource & { url: string }> = [];
		const soundPlayer = createSoundPlayer((url) => {
			const source = { url, play() {}, pause() {} };
			samples.push(source);
			return source;
		});
		soundPlayer.setEnabled(true);
		previousSoundPlayer = setUiSoundPlayer(soundPlayer);
		const el = mount(document.createElement("div"));
		handle = createSlider(el, {
			min: 0,
			max: 100,
			step: 1,
			value: 50,
			label: String,
			onChange: (v, c) => seen.push([v, c]),
		});
		const track = handle.el.querySelector<HTMLElement>(".sl-slider__track");
		if (!track) throw new Error("no track");
		Object.defineProperty(track, "getBoundingClientRect", {
			value: () => ({ left: 100, width: 200, top: 0, height: 4, right: 300, bottom: 4, x: 100, y: 0 }),
		});
		pointer(track, "pointerdown", { pointerId: 2, clientX: 150, isPrimary: true });
		expect(handle.value).toBe(25);
		expect(handle.el.classList.contains("sl-slider--active")).toBe(true);
		await dom.tick(300);
		pointer(track, "pointermove", { pointerId: 2, clientX: 250 });
		expect(handle.value).toBe(75);
		pointer(track, "pointerup", { pointerId: 2, clientX: 250 });
		expect(handle.el.classList.contains("sl-slider--active")).toBe(false);
		expect(seen).toEqual([
			[25, false],
			[75, false],
			[75, true],
		]);
		// The press jump (a detent crossing), the move (another) and the settle tick on release.
		expect(samples).toHaveLength(3);
		expect(samples.every((sample) => sample.url.endsWith(SOUNDS.smallSlide))).toBe(true);
		expect(samples[1]?.playbackRate).toBeGreaterThan(samples[0]?.playbackRate ?? 0);
		expect(samples[2]?.playbackRate).toBe(samples[1]?.playbackRate);
		expect(samples[2]?.volume).toBeCloseTo(SLIDER_SOUND.volume * SLIDER_SOUND.settleFraction);
		// A press-and-release that never moved plays nothing at all.
		pointer(track, "pointerdown", { pointerId: 3, clientX: 250, isPrimary: true });
		pointer(track, "pointerup", { pointerId: 3, clientX: 250 });
		expect(samples).toHaveLength(3);
		// A keyboard step always ticks, at full volume.
		await dom.tick(300);
		const thumb = handle.el.querySelector<HTMLElement>(".sl-slider__thumb");
		if (thumb) key(thumb, "keydown", { key: "ArrowRight" });
		expect(samples).toHaveLength(4);
		expect(samples[3]?.volume).toBeCloseTo(SLIDER_SOUND.volume);
	});

	it("a fast pointer sweep is thinned to the tick cap and gets quieter", async () => {
		const samples: Array<SoundSource & { url: string }> = [];
		const soundPlayer = createSoundPlayer((url) => {
			const source = { url, play() {}, pause() {} };
			samples.push(source);
			return source;
		});
		soundPlayer.setEnabled(true);
		previousSoundPlayer = setUiSoundPlayer(soundPlayer);
		handle = createSlider(mount(document.createElement("div")), {
			min: 0,
			max: 100,
			step: 1,
			value: 0,
			label: String,
			onChange: () => {},
		});
		const track = handle.el.querySelector<HTMLElement>(".sl-slider__track");
		if (!track) throw new Error("no track");
		Object.defineProperty(track, "getBoundingClientRect", { value: () => ({ left: 0, width: 100 }) });
		pointer(track, "pointerdown", { pointerId: 1, clientX: 0, isPrimary: true });
		// 100 steps in 250 ms: 20 detents at 80 detents/s.
		for (let x = 1; x <= 100; x++) {
			await dom.tick(2.5);
			pointer(track, "pointermove", { pointerId: 1, clientX: x });
		}
		expect(handle.value).toBe(100);
		expect(samples.length).toBeGreaterThan(1);
		expect(samples.length).toBeLessThanOrEqual(Math.ceil(SLIDER_SOUND.maxTicksPerSecond * 0.25) + 1);
		expect(samples.at(-1)?.volume).toBeLessThan(SLIDER_SOUND.volume);
	});

	it("shows a muted numeric readout under the thumb while changing and fades it 1.5 s after the last change", async () => {
		handle = createSlider(mount(document.createElement("div")), {
			min: 0,
			max: 2,
			step: 0.1,
			value: 1,
			label: (v) => (v < 0.67 ? "Low" : v < 1.34 ? "Medium" : "High"),
			format: (v) => (v < 0.67 ? "Low" : v < 1.34 ? "Medium" : "High"),
			readout: (v) => `${v.toFixed(2)}×`,
			onChange: () => {},
		});
		const readout = handle.el.querySelector<HTMLElement>(".sl-slider__readout");
		if (!readout) throw new Error("no readout");
		expect(handle.el.classList.contains("sl-slider--has-readout")).toBe(true);
		expect(readout.hidden).toBe(false);
		expect(readout.getAttribute("aria-hidden")).toBe("true");
		expect(readout.closest(".sl-slider__thumb")).not.toBeNull();
		// At rest the readout is not shown (the class drives its opacity).
		expect(handle.el.classList.contains("sl-slider--readout")).toBe(false);
		const thumb = handle.el.querySelector<HTMLElement>(".sl-slider__thumb");
		if (!thumb) throw new Error("no thumb");
		key(thumb, "keydown", { key: "ArrowRight" });
		expect(readout.textContent).toBe("1.10×");
		expect(handle.el.classList.contains("sl-slider--readout")).toBe(true);
		// Every change restarts the fade timer.
		await dom.tick(UI_TIMINGS.sliderReadoutFadeMs - 100);
		expect(handle.el.classList.contains("sl-slider--readout")).toBe(true);
		key(thumb, "keydown", { key: "ArrowRight" });
		expect(readout.textContent).toBe("1.20×");
		await dom.tick(UI_TIMINGS.sliderReadoutFadeMs - 100);
		expect(handle.el.classList.contains("sl-slider--readout")).toBe(true);
		await dom.tick(100);
		expect(handle.el.classList.contains("sl-slider--readout")).toBe(false);
		expect(UI_TIMINGS.sliderReadoutFadeMs).toBe(1_500);
		// A pointer drag shows it too; the bubble still carries the label.
		const track = handle.el.querySelector<HTMLElement>(".sl-slider__track");
		if (!track) throw new Error("no track");
		Object.defineProperty(track, "getBoundingClientRect", { value: () => ({ left: 0, width: 200 }) });
		pointer(track, "pointerdown", { pointerId: 1, clientX: 180, isPrimary: true });
		expect(handle.value).toBe(1.8);
		expect(readout.textContent).toBe("1.80×");
		expect(handle.el.querySelector(".sl-slider__bubble")?.textContent).toBe("High");
		expect(handle.el.classList.contains("sl-slider--readout")).toBe(true);
		pointer(track, "pointerup", { pointerId: 1, clientX: 180 });
		// An external (store) update is not a user change and does not show it.
		await dom.tick(UI_TIMINGS.sliderReadoutFadeMs);
		expect(handle.el.classList.contains("sl-slider--readout")).toBe(false);
		handle.update({ value: 0.5 });
		expect(handle.el.classList.contains("sl-slider--readout")).toBe(false);
		// Disposal clears the pending timer.
		key(thumb, "keydown", { key: "ArrowRight" });
		handle.dispose();
		handle = null;
		await dom.tick(UI_TIMINGS.sliderReadoutFadeMs);
	});

	it("without a readout the element stays hidden and no line is reserved", () => {
		handle = createSlider(document.body, {
			min: 0,
			max: 100,
			step: 1,
			value: 40,
			label: String,
			onChange: () => {},
		});
		expect(handle.el.classList.contains("sl-slider--has-readout")).toBe(false);
		expect(handle.el.querySelector<HTMLElement>(".sl-slider__readout")?.hidden).toBe(true);
		const thumb = handle.el.querySelector<HTMLElement>(".sl-slider__thumb");
		if (thumb) key(thumb, "keydown", { key: "ArrowRight" });
		expect(handle.el.classList.contains("sl-slider--readout")).toBe(false);
	});

	it("keeps the thumb under the pointer: stale external values are ignored mid-drag and just after the commit", () => {
		handle = createSlider(document.body, {
			min: 0,
			max: 100,
			step: 1,
			value: 50,
			label: String,
			onChange: () => {},
		});
		const track = handle.el.querySelector<HTMLElement>(".sl-slider__track")!;
		Object.defineProperty(track, "getBoundingClientRect", { value: () => ({ left: 0, width: 100 }) });
		pointer(track, "pointerdown", { pointerId: 1, clientX: 60, isPrimary: true });
		// The store echoes the *stored* value on every snapshot while the hand is moving.
		handle.update({ value: 50 });
		expect(handle.value).toBe(60);
		pointer(track, "pointermove", { pointerId: 1, clientX: 80 });
		handle.update({ value: 50 });
		expect(handle.value).toBe(80);
		pointer(track, "pointerup", { pointerId: 1, clientX: 80 });
		// One snapshot from before the write landed: still ignored; the echo of the commit applies.
		handle.update({ value: 50 });
		expect(handle.value).toBe(80);
		handle.update({ value: 80 });
		expect(handle.value).toBe(80);
		expect(handle.el.classList.contains("sl-slider--active")).toBe(false);
	});

	it("cancels an active drag when a live settings update disables the control", () => {
		const seen: Array<[number, boolean]> = [];
		handle = createSlider(document.body, {
			min: 0,
			max: 100,
			step: 1,
			value: 50,
			label: String,
			onChange: (v, commit) => seen.push([v, commit]),
		});
		const track = handle.el.querySelector<HTMLElement>(".sl-slider__track")!;
		Object.defineProperty(track, "getBoundingClientRect", { value: () => ({ left: 0, width: 100 }) });
		pointer(track, "pointerdown", { pointerId: 1, clientX: 60, isPrimary: true });
		handle.update({ value: 50, disabled: true });
		pointer(track, "pointermove", { pointerId: 1, clientX: 100 });
		pointer(track, "pointerup", { pointerId: 1, clientX: 100 });
		expect(handle.value).toBe(50);
		expect(seen).toEqual([[60, false]]);
		expect(handle.el.classList.contains("sl-slider--active")).toBe(false);
	});
});

it("renders an accessible network boundary at its exact value as the range changes", () => {
	handle = createSlider(mount(document.createElement("div")), {
		min: 0,
		max: 100,
		step: 1,
		value: 40,
		label: String,
		threshold: {
			value: 60,
			label: "60",
			lowerLabel: "Small NNUE",
			upperLabel: "Large NNUE",
			description: "Large NNUE starts at 60",
		},
		onChange: () => {},
	});
	const divider = handle.el.querySelector<HTMLElement>(".sl-slider__divider");
	expect(divider?.hidden).toBe(false);
	expect(divider?.style.left).toBe("60.000%");
	expect(divider?.dataset.value).toBe("60");
	expect(handle.el.querySelector<HTMLElement>(".sl-slider__boundary")?.hidden).toBe(true);
	expect(handle.el.querySelector("[role=slider]")?.getAttribute("aria-description")).toBe(
		"Large NNUE starts at 60"
	);
	handle.update({ max: 120 });
	expect(divider?.style.left).toBe("50.000%");
});

it("renders unlabelled markers at their values, under the primary divider, and keeps them on a range change", () => {
	handle = createSlider(mount(document.createElement("div")), {
		min: 0,
		max: 100,
		step: 1,
		value: 40,
		label: String,
		threshold: {
			value: 80,
			label: "80",
			lowerLabel: "Small",
			upperLabel: "Large",
			description: "Large starts at 80",
		},
		markers: [60],
		onChange: () => {},
	});
	const markers = [...handle.el.querySelectorAll<HTMLElement>(".sl-slider__marker")];
	expect(markers).toHaveLength(1);
	const marker = markers[0]!;
	expect(marker.style.left).toBe("60.000%");
	expect(marker.dataset.value).toBe("60");
	expect(marker.getAttribute("title")).toBeNull();
	expect(marker.textContent).toBe("");
	expect(marker.closest("[aria-hidden=true]")).not.toBeNull();
	// The marker is not the labelled boundary: the divider and its description are untouched.
	expect(handle.el.querySelector<HTMLElement>(".sl-slider__divider")?.style.left).toBe("80.000%");
	expect(handle.el.querySelector("[role=slider]")?.getAttribute("aria-description")).toBe(
		"Large starts at 80"
	);
	handle.update({ max: 120 });
	expect(marker.style.left).toBe("50.000%");
	expect(handle.el.querySelector<HTMLElement>(".sl-slider__divider")?.style.left).toBe(
		`${((80 / 120) * 100).toFixed(3)}%`
	);
	// A marker outside the range clamps to the track's edge rather than escaping it.
	handle.update({ max: 50 });
	expect(marker.style.left).toBe("100.000%");
});

it("without markers the track carries none", () => {
	handle = createSlider(document.body, {
		min: 0,
		max: 100,
		step: 1,
		value: 40,
		label: String,
		onChange: () => {},
	});
	expect(handle.el.querySelectorAll(".sl-slider__marker")).toHaveLength(0);
});

// Owner, 2026-09-15: the glow starts at the product's one strength division, the Maia cutoff (it
// started at 3200 with the old network switch), and the sweep cadence is no longer a CSS custom
// property written by the slider (`--sl-slider-flow-gap` asserted here before) — see the sweep tests.
it("strength heat increases continuously and only the range from the Maia cutoff adds the glow", () => {
	const cutoff = STRENGTH_UI.glowElo;
	expect(cutoff).toBe(MAIA.eloMax);
	handle = createSlider(document.body, {
		min: LIMITS.eloMin,
		max: LIMITS.eloMax,
		step: 50,
		value: LIMITS.eloMin,
		label,
		strength: true,
		threshold: {
			value: cutoff,
			label: String(cutoff),
			lowerLabel: "Small NNUE",
			upperLabel: "Large NNUE",
			description: `Large NNUE above ${cutoff}`,
		},
		onChange: () => {},
	});
	let previous = -1;
	for (const value of [400, 1200, 2000, 2600, 3000, 3400, 3800]) {
		handle.update({ value });
		const heat = Number(handle.el.style.getPropertyValue("--sl-slider-heat"));
		expect(heat).toBeGreaterThan(previous);
		previous = heat;
		expect(handle.el.classList.contains("sl-slider--hot")).toBe(value >= cutoff);
		expect(Number(handle.el.style.getPropertyValue("--sl-slider-energy"))).toBe(
			Math.max(0, (value - cutoff) / (LIMITS.eloMax - cutoff))
		);
	}
	expect(previous).toBe(1);
	expect(handle.el.style.getPropertyValue("--sl-slider-flow-gap")).toBe("");
	handle.update({ value: 1500 });
	expect(handle.el.classList.contains("sl-slider--hot")).toBe(false);
	// Energy stays mounted so opacity can fade out after leaving the high-strength range.
	expect(handle.el.querySelector(".sl-slider__energy")).not.toBeNull();
	expect(handle.el.querySelectorAll(".sl-slider__energy > span")).toHaveLength(2);
	// The fire particles are gone: the glow is a single gradient layer with no children.
	expect(handle.el.querySelectorAll(".sl-slider__glow > *")).toHaveLength(0);
	expect(handle.el.style.getPropertyValue("--sl-slider-energy")).toBe("0");
	const ticks = [...handle.el.querySelectorAll<HTMLElement>(".sl-slider__tick")];
	expect(ticks.length).toBeGreaterThan(10);
	expect(ticks[0]?.dataset.value).toBe("400");
	expect(ticks[0]?.style.left).toBe("0.000%");
	expect(ticks.at(-1)?.dataset.value).toBe("3800");
	expect(ticks.at(-1)?.style.left).toBe("100.000%");
	const thresholdTick = ticks.find((tick) => tick.dataset.value === String(cutoff));
	expect(thresholdTick).toBeDefined();
	expect(thresholdTick?.style.left).toBe(
		handle.el.querySelector<HTMLElement>(".sl-slider__divider")?.style.left
	);
});

// Owner, 2026-09-15: "when sliding the elo slider when its above 3200 the animation timeskips when I
// let go of the slider knob". The sweep cadence was the running CSS animation's duration, written
// on release; a running animation re-maps its elapsed time onto a new duration, so the sweeps
// jumped. The slider now launches each fixed-length crossing itself and only the wait before the
// next launch follows the energy.
describe("strength sweeps", () => {
	const sweepMs = TOKENS.motion.durationMs["strength-sweep"];
	/** The wait between launches at `energy` with `sweeps` sweeps taking turns. */
	const waitAt = (energy: number, sweeps: number): number =>
		(sweepMs *
			(STRENGTH_UI.sweepTravelWidths +
				STRENGTH_UI.flowGapMax -
				(STRENGTH_UI.flowGapMax - STRENGTH_UI.flowGapMin) * energy)) /
		(STRENGTH_UI.sweepTravelWidths * sweeps);
	const strengthSlider = (value: number): SliderHandle =>
		createSlider(document.body, {
			min: LIMITS.eloMin,
			max: LIMITS.eloMax,
			step: 50,
			value,
			label,
			strength: true,
			onChange: () => {},
		});
	const sweepsOf = (slider: SliderHandle): HTMLElement[] => [
		...slider.el.querySelectorAll<HTMLElement>(".sl-slider__energy > span"),
	];
	const names = (sweeps: readonly HTMLElement[]): string[] =>
		sweeps.map((sweep) => sweep.dataset.sweep ?? "");

	it("letting go of the knob re-times no sweep in flight; the new cadence starts at the next launch", async () => {
		handle = strengthSlider(LIMITS.eloMax);
		const sweeps = sweepsOf(handle);
		expect(sweeps).toHaveLength(2);
		const fast = waitAt(1, sweeps.length);
		const slow = waitAt(0, sweeps.length);
		// Hot at the maximum: the first sweep starts at once, the second one wait later.
		expect(names(sweeps)).toEqual(["a", ""]);
		await dom.tick(fast - 1);
		expect(names(sweeps)).toEqual(["a", ""]);
		await dom.tick(1);
		expect(names(sweeps)).toEqual(["a", "a"]);
		// Half-way through the next wait, drag the knob from the maximum down to the cutoff and let go.
		const track = handle.el.querySelector<HTMLElement>(".sl-slider__track")!;
		Object.defineProperty(track, "getBoundingClientRect", {
			value: () => ({ left: 0, width: LIMITS.eloMax - LIMITS.eloMin }),
		});
		await dom.tick(fast / 2);
		const xOf = (elo: number): number => elo - LIMITS.eloMin;
		pointer(track, "pointerdown", { pointerId: 1, clientX: xOf(LIMITS.eloMax), isPrimary: true });
		pointer(track, "pointermove", { pointerId: 1, clientX: xOf(STRENGTH_UI.glowElo) });
		pointer(track, "pointerup", { pointerId: 1, clientX: xOf(STRENGTH_UI.glowElo) });
		expect(handle.value).toBe(STRENGTH_UI.glowElo);
		expect(handle.el.classList.contains("sl-slider--hot")).toBe(true);
		// The release restarts nothing and writes nothing an animation's timing is read from.
		expect(names(sweeps)).toEqual(["a", "a"]);
		expect(handle.el.style.getPropertyValue("--sl-slider-flow-gap")).toBe("");
		for (const sweep of sweeps) expect(sweep.getAttribute("style")).toBeNull();
		// The wait already running keeps the cadence it was launched with …
		await dom.tick(fast / 2);
		expect(names(sweeps)).toEqual(["b", "a"]);
		// … and the slower cadence at the cutoff applies from that launch on.
		await dom.tick(slow - 1);
		expect(names(sweeps)).toEqual(["b", "a"]);
		await dom.tick(1);
		expect(names(sweeps)).toEqual(["b", "b"]);
	});

	it("never relaunches a sweep before its crossing ends, and stops launching when cold, disabled or disposed", async () => {
		// A sweep's next turn comes `sweeps × wait` after its last, longer than one crossing at any
		// energy — the margin `flowGapMin > 0` keeps.
		expect(STRENGTH_UI.flowGapMin).toBeGreaterThan(0);
		for (const energy of [0, 0.25, 0.5, 0.75, 1])
			expect(2 * waitAt(energy, 2)).toBeGreaterThan(sweepMs);
		handle = strengthSlider(LIMITS.eloMax);
		const sweeps = sweepsOf(handle);
		const long = waitAt(0, sweeps.length) * 4;
		expect(names(sweeps)).toEqual(["a", ""]);
		handle.update({ value: 2000 });
		await dom.tick(long);
		expect(names(sweeps)).toEqual(["a", ""]);
		// Back in the hot range the next sweep launches at once.
		handle.update({ value: LIMITS.eloMax });
		expect(names(sweeps)).toEqual(["a", "a"]);
		handle.update({ disabled: true });
		await dom.tick(long);
		expect(names(sweeps)).toEqual(["a", "a"]);
		handle.update({ disabled: false });
		expect(names(sweeps)).toEqual(["b", "a"]);
		handle.dispose();
		handle = null;
		await dom.tick(long);
		expect(names(sweeps)).toEqual(["b", "a"]);
		// A slider that is not a strength slider never launches one.
		handle = createSlider(document.body, {
			min: 0,
			max: 100,
			step: 1,
			value: 100,
			label: String,
			onChange: () => {},
		});
		await dom.tick(long);
		expect(names(sweepsOf(handle))).toEqual(["", ""]);
	});

	it("its CSS runs one fixed-duration crossing per launch, with nothing the slider writes in its timing", () => {
		const css = readFileSync(
			path.resolve(import.meta.dir, "../../../css/views/live-progress.css"),
			"utf8"
		);
		expect(css).not.toContain("--sl-slider-flow-gap");
		const base = /\.sl-slider__energy > span \{([^}]*)\}/.exec(css)?.[1] ?? "";
		expect(base).toContain("animation-duration: var(--sl-motion-duration-strength-sweep);");
		expect(base).not.toContain("infinite");
		expect(base).not.toContain("animation-delay");
		for (const [name, keyframes] of [
			["a", "sl-strength-flow"],
			["b", "sl-strength-flow-again"],
		] as const) {
			expect(css).toContain(
				`.sl-slider__energy > span[data-sweep="${name}"] {\n\tanimation-name: ${keyframes};\n}`
			);
			const body = new RegExp(`@keyframes ${keyframes} \\{([^@]*?)\\n\\}`).exec(css)?.[1] ?? "";
			expect(body).toContain("from { transform: translateX(-100%); }");
			expect(body).toContain("to { transform: translateX(100%); }");
		}
		// Reduced motion still silences a launched sweep (the attribute rule must not out-rank it).
		expect(css).toContain(
			'[data-reduced-motion="true"] .sl-slider__energy > span[data-sweep] { animation: none; opacity: 0; }'
		);
	});
});

it("captions the current value's category in one aria-hidden line that follows the value", () => {
	handle = createSlider(document.body, {
		min: LIMITS.eloMin,
		max: LIMITS.eloMax,
		step: 50,
		value: 1200,
		label,
		caption: band,
		onChange: () => {},
	});
	const caption = handle.el.querySelector<HTMLElement>(".sl-slider__caption")!;
	expect(caption.hidden).toBe(false);
	expect(caption.getAttribute("aria-hidden")).toBe("true");
	expect(caption.textContent).toBe("Club");
	const thumb = handle.el.querySelector<HTMLElement>(".sl-slider__thumb")!;
	key(thumb, "keydown", { key: "PageUp" });
	expect(caption.textContent).toBe("Expert");
	handle.update({ value: 2650 });
	expect(caption.textContent).toBe("Elite");
	handle.dispose();
	handle = createSlider(document.body, {
		min: 0,
		max: 100,
		step: 1,
		value: 40,
		label: String,
		onChange: () => {},
	});
	expect(handle.el.querySelector<HTMLElement>(".sl-slider__caption")?.hidden).toBe(true);
});

it("shows an exact reading unsnapped and clamped, keeps it across value-less updates, and snaps on the next step", () => {
	handle = createSlider(document.body, {
		min: LIMITS.eloMin,
		max: LIMITS.eloMax,
		step: 50,
		value: 1537,
		exact: true,
		label,
		onChange: () => {},
	});
	const thumb = handle.el.querySelector<HTMLElement>(".sl-slider__thumb")!;
	expect(handle.value).toBe(1537);
	expect(thumb.getAttribute("aria-valuenow")).toBe("1537");
	handle.update({ disabled: true });
	expect(handle.value).toBe(1537);
	handle.update({ value: 1612, exact: true });
	expect(handle.value).toBe(1612);
	handle.update({ value: 99_999, exact: true });
	expect(handle.value).toBe(LIMITS.eloMax);
	// Without `exact` an external value snaps as before.
	handle.update({ value: 1612 });
	expect(handle.value).toBe(1600);
	handle.update({ value: 1537, exact: true, disabled: false });
	key(thumb, "keydown", { key: "ArrowRight" });
	expect(handle.value).toBe(1600);
});
