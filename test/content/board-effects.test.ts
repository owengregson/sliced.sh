import { describe, expect, it } from "bun:test";
import { createBoardEffects } from "@content/board-effects";
import type { MoveQuality } from "@core/constants/move-quality";
import { FakeBridge } from "./adapters/helpers";

function setup() {
	const bridge = new FakeBridge();
	const sounds: Array<MoveQuality | null> = [];
	const effects = createBoardEffects(bridge, {
		flipped: () => false,
		initiallyEnabled: true,
		sound: (quality) => sounds.push(quality),
	});
	bridge.responses.set("effects", () => true);
	bridge.responses.set("effectsClear", () => undefined);
	const draw = (mine = true) =>
		effects.apply({
			kind: "effects",
			mine,
			effects: [],
			quality: { square: "e4", quality: "best" },
		});
	return { bridge, sounds, effects, draw };
}

const settle = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("board rating sound synchronization", () => {
	it("defaults silent and plays for both sides only after the badge acknowledgement", async () => {
		const h = setup();
		h.draw();
		await settle();
		expect(h.sounds).toEqual([]);
		h.effects.setSoundsEnabled(true);
		h.draw();
		expect(h.sounds).toEqual([]);
		await settle();
		h.draw(false);
		await settle();
		expect(h.sounds).toEqual(["best", "best"]);
	});

	it("does not sound for rays, rejected draws or repeated badges", async () => {
		const h = setup();
		h.effects.setSoundsEnabled(true);
		h.effects.apply({ kind: "effects", mine: true, effects: [] });
		await settle();
		for (const result of [false, null, undefined]) {
			h.bridge.responses.set("effects", () => result);
			h.draw();
			await settle();
		}
		h.bridge.responses.set("effects", () => Promise.reject(new Error("bridge unavailable")));
		h.draw();
		await settle();
		expect(h.sounds).toEqual([]);
	});

	it.each(["sound-off", "board-off", "clear", "dispose"] as const)(
		"%s stops playback and invalidates late acknowledgements",
		async (action) => {
			const h = setup();
			h.effects.setSoundsEnabled(true);
			let acknowledge: (value: boolean) => void = () => {};
			h.bridge.responses.set(
				"effects",
				() =>
					new Promise<boolean>((resolve) => {
						acknowledge = resolve;
					})
			);
			h.draw();
			if (action === "sound-off") {
				h.effects.setSoundsEnabled(false);
				h.effects.setSoundsEnabled(true);
			}
			if (action === "board-off") {
				h.effects.setEnabled(false);
				h.effects.setEnabled(true);
			}
			if (action === "clear") await h.effects.clear();
			if (action === "dispose") h.effects.dispose();
			acknowledge(true);
			await settle();
			expect(h.sounds).toEqual([null]);
		}
	);

	it("enabling sounds does not replay a badge that was already being drawn", async () => {
		const h = setup();
		let acknowledge: (value: boolean) => void = () => {};
		h.bridge.responses.set(
			"effects",
			() =>
				new Promise<boolean>((resolve) => {
					acknowledge = resolve;
				})
		);
		h.draw();
		h.effects.setSoundsEnabled(true);
		acknowledge(true);
		await settle();
		expect(h.sounds).toEqual([]);
	});
});
