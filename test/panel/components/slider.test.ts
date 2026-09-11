// test/panel/components/slider.test.ts — Appendix F §5.3: keyboard steps, Shift ×10, Home/End,
// bubble text from the human-label function, danger zone hint.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants";
import { SLIDER_SOUND, SOUNDS } from "@core/constants/sounds";
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
		await dom.tick(SLIDER_SOUND.intervalMs);
		pointer(track, "pointermove", { pointerId: 2, clientX: 250 });
		expect(handle.value).toBe(75);
		pointer(track, "pointerup", { pointerId: 2, clientX: 250 });
		expect(handle.el.classList.contains("sl-slider--active")).toBe(false);
		expect(seen).toEqual([
			[25, false],
			[75, false],
			[75, true],
		]);
		expect(samples).toHaveLength(3);
		expect(samples.every((sample) => sample.url.endsWith(SOUNDS.smallSlide))).toBe(true);
		expect(samples[1]?.playbackRate).toBeGreaterThan(samples[0]?.playbackRate ?? 0);
		expect(samples[2]?.playbackRate).toBe(samples[1]?.playbackRate);
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

it("strength heat increases continuously and only high Elo adds the glow", () => {
	handle = createSlider(document.body, {
		min: LIMITS.eloMin,
		max: LIMITS.eloMax,
		step: 50,
		value: LIMITS.eloMin,
		label,
		strength: true,
		threshold: {
			value: 3200,
			label: "3200",
			lowerLabel: "Small NNUE",
			upperLabel: "Large NNUE",
			description: "Large NNUE starts at 3200",
		},
		onChange: () => {},
	});
	let previous = -1;
	for (const value of [400, 1200, 2000, 2600, 3200, 3800]) {
		handle.update({ value });
		const heat = Number(handle.el.style.getPropertyValue("--sl-slider-heat"));
		expect(heat).toBeGreaterThan(previous);
		previous = heat;
		expect(handle.el.classList.contains("sl-slider--hot")).toBe(value >= 3200);
		expect(Number(handle.el.style.getPropertyValue("--sl-slider-energy"))).toBe(
			Math.max(0, (value - 3200) / (LIMITS.eloMax - 3200))
		);
	}
	expect(previous).toBe(1);
	handle.update({ value: 1500 });
	expect(handle.el.classList.contains("sl-slider--hot")).toBe(false);
	// Energy stays mounted so opacity can fade out after leaving the high-strength range.
	expect(handle.el.querySelector(".sl-slider__energy")).not.toBeNull();
	expect(handle.el.style.getPropertyValue("--sl-slider-energy")).toBe("0");
	const ticks = [...handle.el.querySelectorAll<HTMLElement>(".sl-slider__tick")];
	expect(ticks.length).toBeGreaterThan(10);
	expect(ticks[0]?.dataset.value).toBe("400");
	expect(ticks[0]?.style.left).toBe("0.000%");
	expect(ticks.at(-1)?.dataset.value).toBe("3800");
	expect(ticks.at(-1)?.style.left).toBe("100.000%");
	const thresholdTick = ticks.find((tick) => tick.dataset.value === "3200");
	expect(thresholdTick).toBeDefined();
	expect(thresholdTick?.style.left).toBe(
		handle.el.querySelector<HTMLElement>(".sl-slider__divider")?.style.left
	);
});
