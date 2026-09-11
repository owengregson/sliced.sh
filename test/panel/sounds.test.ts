// test/panel/sounds.test.ts — Appendix F §6.6 mapping, gated by display.uiSounds, played from
// chrome.runtime.getURL("assets/sounds/…").
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SOUNDS, SOUNDS_DIR } from "@core/constants";
import { SLIDER_SOUND } from "@core/constants/sounds";
import {
	createSoundPlayer,
	playUiSound,
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

	it("rate-limits quiet slider samples, maps position to pitch, and stops overlapping samples", async () => {
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
		expect(player.slider(0)).toBe(false);
		player.setEnabled(true);
		expect(player.slider(0)).toBe(true);
		expect(player.slider(1)).toBe(false);
		await dom.tick(SLIDER_SOUND.intervalMs);
		expect(player.slider(0.001)).toBe(false);
		expect(player.slider(1)).toBe(true);
		expect(samples).toHaveLength(2);
		expect(samples[0]?.pauses).toBe(1);
		expect(samples[0]?.preservesPitch).toBe(false);
		expect(samples[1]?.playbackRate).toBeGreaterThan(samples[0]?.playbackRate ?? 0);
		expect(samples[1]?.volume).toBeLessThan(0.3);
		// A release at the same value is always audible, even immediately after a scrub sample.
		expect(player.slider(1, "release")).toBe(true);
		expect(samples).toHaveLength(3);
		expect(samples[1]?.pauses).toBe(1);
		expect(samples[2]?.playbackRate).toBe(samples[1]?.playbackRate);
		player.setEnabled(false);
		expect(samples[2]?.pauses).toBe(1);
		expect(player.slider(0.5)).toBe(false);
		expect(player.slider(1, "release")).toBe(false);
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
