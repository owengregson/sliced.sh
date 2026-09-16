import { describe, expect, it } from "bun:test";
import {
	type BoardEffectsPayload,
	createBoardEffects,
	forcedMateSemitones,
} from "@content/board-effects";
import { MOVE_QUALITY, type MoveQuality } from "@core/constants/move-quality";
import { FakeBridge } from "./adapters/helpers";

function setup() {
	const bridge = new FakeBridge();
	const sounds: Array<MoveQuality | null> = [];
	/** Every request with its pitch, for the forced-mate cases. */
	const calls: Array<[MoveQuality | null, number | undefined]> = [];
	const effects = createBoardEffects(bridge, {
		flipped: () => false,
		initiallyEnabled: true,
		// The rays and the chip have had independent gates since 2026-09-15; the cases below that are
		// about sounds want both on, as one `initiallyEnabled` used to mean.
		initiallyRatingsEnabled: true,
		sound: (quality, mateSemitones) => {
			sounds.push(quality);
			calls.push([quality, mateSemitones]);
		},
	});
	bridge.responses.set("effects", () => true);
	bridge.responses.set("effectsClear", () => undefined);
	const draw = (mine = true) =>
		effects.apply({
			kind: "effects",
			mine,
			effects: [],
			quality: { square: "e4", quality: "great" },
		});
	const drawMate = (mateSemitones?: number, square: "e4" | "f7" = "f7") =>
		effects.apply({
			kind: "effects",
			mine: true,
			effects: [],
			quality: {
				square,
				quality: "mate",
				...(mateSemitones === undefined ? {} : { mateSemitones }),
			},
		});
	return { bridge, sounds, calls, effects, draw, drawMate };
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
		expect(h.sounds).toEqual(["great", "great"]);
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

	it.each(["sound-off", "board-off", "ratings-off", "clear", "dispose"] as const)(
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
			if (action === "ratings-off") {
				h.effects.setRatingsEnabled(false);
				h.effects.setRatingsEnabled(true);
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

// ── the two gates, independent (owner, 2026-09-15) ────────────────────────────────────────────
describe("rays and ratings gate their own half of a batch", () => {
	const RAY = { kind: "check", from: "f8", to: "e8" } as const;
	const payloadOf = (h: ReturnType<typeof setup>): BoardEffectsPayload =>
		h.bridge.callsOf("effects").at(-1)?.payload as BoardEffectsPayload;

	it("board effects off: the chip is drawn with no rays, and still sounds", async () => {
		const h = setup();
		h.effects.setEnabled(false);
		h.effects.setSoundsEnabled(true);
		h.effects.apply({
			kind: "effects",
			mine: true,
			effects: [{ ...RAY }],
			quality: { square: "f8", quality: "great" },
		});
		await settle();
		expect(payloadOf(h).effects).toEqual([]);
		expect(payloadOf(h).quality).toEqual({ square: "f8", quality: "great" });
		expect(h.sounds).toEqual(["great"]);
	});

	it("move ratings off: the rays are drawn without the chip, and nothing sounds", async () => {
		const h = setup();
		h.effects.setRatingsEnabled(false);
		h.effects.setSoundsEnabled(true);
		h.effects.apply({
			kind: "effects",
			mine: true,
			effects: [{ ...RAY }],
			quality: { square: "f8", quality: "great" },
		});
		await settle();
		expect(payloadOf(h).effects).toEqual([{ ...RAY }]);
		expect("quality" in payloadOf(h)).toBe(false);
		expect(h.sounds).toEqual([]);
	});

	it("both off: nothing is sent to the page at all", async () => {
		const h = setup();
		h.effects.setEnabled(false);
		h.effects.setRatingsEnabled(false);
		h.draw();
		h.effects.apply({ kind: "effects", mine: false, effects: [{ ...RAY }] });
		await settle();
		expect(h.bridge.callsOf("effects")).toEqual([]);
	});

	it("a chip-less batch with the rays off is not sent either", async () => {
		const h = setup();
		h.effects.setEnabled(false);
		h.effects.apply({ kind: "effects", mine: false, effects: [{ ...RAY }] });
		await settle();
		expect(h.bridge.callsOf("effects")).toEqual([]);
	});

	it("turning either gate off erases the whole layer; the other kind resumes with the next batch", async () => {
		// The page overlay has one clear, so a gate going off takes the layer with it — the kind that
		// is still on comes back with the next move.
		const h = setup();
		h.draw();
		await settle();
		h.effects.setRatingsEnabled(false);
		await settle();
		expect(h.bridge.callsOf("effectsClear")).toHaveLength(1);
		h.effects.apply({ kind: "effects", mine: true, effects: [{ ...RAY }] });
		await settle();
		expect(payloadOf(h).effects).toEqual([{ ...RAY }]);
		h.effects.setEnabled(false);
		await settle();
		expect(h.bridge.callsOf("effectsClear")).toHaveLength(2);
	});
});

// ── forced mate (owner, 2026-09-14; one pitched clip since 2026-09-15), under its own switch ──
describe("forced-mate sound choice", () => {
	it("plays the chip's pitch instead of any rating clip only while both switches are on", async () => {
		const h = setup();
		h.effects.setForcedMateSoundsEnabled(true);
		h.drawMate(-2);
		await settle();
		// Rating sounds off: the forced-mate switch alone plays nothing.
		expect(h.calls).toEqual([]);
		h.effects.setSoundsEnabled(true);
		h.drawMate(-2);
		await settle();
		h.draw();
		await settle();
		expect(h.calls).toEqual([
			["mate", -2],
			["great", undefined],
		]);
	});

	it("plays nothing for a forced-mate chip while its switch is off, and ratings are unaffected", async () => {
		const h = setup();
		h.effects.setSoundsEnabled(true);
		h.drawMate(MOVE_QUALITY.mateTopSemitones);
		await settle();
		h.draw();
		await settle();
		expect(h.calls).toEqual([["great", undefined]]);
	});

	it("clamps the pitch to mateMinSemitones … mateTopSemitones, keeps a tangential fraction, and plays nothing for a chip without one", async () => {
		const h = setup();
		h.effects.setSoundsEnabled(true);
		h.effects.setForcedMateSoundsEnabled(true);
		for (const semitones of [-20, 9, 1.5, -3, 0, undefined, Number.NaN]) {
			h.drawMate(semitones);
			await settle();
		}
		expect(h.calls).toEqual([
			["mate", MOVE_QUALITY.mateMinSemitones],
			["mate", MOVE_QUALITY.mateTopSemitones],
			["mate", 1.5],
			["mate", -3],
			["mate", 0],
		]);
		expect(forcedMateSemitones(MOVE_QUALITY.mateTopSemitones + 1)).toBe(
			MOVE_QUALITY.mateTopSemitones
		);
		expect(forcedMateSemitones(Number.POSITIVE_INFINITY)).toBeNull();
	});

	it("sounds a checkmate's top-step chip like any other move of the sequence", async () => {
		const h = setup();
		h.effects.setSoundsEnabled(true);
		h.effects.setForcedMateSoundsEnabled(true);
		h.drawMate(MOVE_QUALITY.mateTopSemitones, "f7");
		await settle();
		expect(h.calls).toEqual([["mate", MOVE_QUALITY.mateTopSemitones]]);
	});

	it("turning forced-mate sounds off stops playback and invalidates only the pending forced-mate acknowledgement", async () => {
		const h = setup();
		h.effects.setSoundsEnabled(true);
		h.effects.setForcedMateSoundsEnabled(true);
		const acknowledgements: Array<(value: boolean) => void> = [];
		h.bridge.responses.set(
			"effects",
			() =>
				new Promise<boolean>((resolve) => {
					acknowledgements.push(resolve);
				})
		);
		h.drawMate(2);
		h.draw();
		h.effects.setForcedMateSoundsEnabled(false);
		h.effects.setForcedMateSoundsEnabled(true);
		for (const acknowledge of acknowledgements) acknowledge(true);
		await settle();
		expect(h.calls).toEqual([
			[null, undefined],
			["great", undefined],
		]);
	});

	it("the forced-mate switch sends no stop while rating sounds are already off", () => {
		const h = setup();
		h.effects.setForcedMateSoundsEnabled(true);
		h.effects.setForcedMateSoundsEnabled(false);
		expect(h.calls).toEqual([]);
	});
});
