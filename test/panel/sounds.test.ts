// test/panel/sounds.test.ts — Appendix F §6.6 mapping, gated by display.uiSounds, played from
// chrome.runtime.getURL("assets/sounds/…").
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SOUNDS } from "@core/constants";
import {
	createSoundPlayer,
	playUiSound,
	SOUNDS_DIR,
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
			sliderRelease: "slide",
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
		expect(playUiSound("movePlayed" satisfies UiSoundEvent)).toBe(true);
		expect(played.at(-1)).toContain(SOUNDS.makeMove);
		setUiSoundPlayer(prev);
	});
});
