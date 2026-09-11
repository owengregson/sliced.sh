// tools/telemetry-conformance/ac-model.test.ts — the per-move half of the §13.2 model, on synthetic
// blobs. Two things live here that a simulated game cannot pin deterministically:
//
//   1. **well-formedness** — the rules that say a blob describes a real window at all. The exact
//      shape Fix F shipped and review caught (`MoveHoldTime 458` against `TotalFocusTime 0`, a
//      premove row carrying the *next* position's window) is the first case below, so the model
//      itself now refuses it whatever the session does;
//   2. **whose focus edge it is** — a premove's window is opened over the opponent's turn, a period
//      the owner owns, so a blur there is his behaviour and not our misconduct; a blur on our own
//      turn is a conduct violation whatever the mode. On a virtual clock a blur and the drop can
//      land in the same instant, so the "blurred stretch has a duration" half of that is only
//      reachable here.
import { describe, expect, it } from "bun:test";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import type { AcBlob } from "@typedefs/telemetry";
import type { TimingMode } from "@typedefs/timing";
import { type AcMoveMeta, assertWellFormedAc } from "./ac-model";

/** A clean blob: attentive, trusted, one continuous pointer, no focus edge at all. */
function blob(over: Partial<AcBlob> = {}): AcBlob {
	return {
		BlurCount: 0,
		DidBlurOnOpponentTurn: false,
		DidBlurOnOwnTurn: false,
		DidFocusOnOpponentTurn: false,
		DidFocusOnOwnTurn: false,
		DidSelectMultiplePieces: false,
		DidToggle: false,
		EventTrusted: true,
		MoveHoldTime: 600,
		PointerOffset: 420,
		TotalBlurTime: 0,
		TotalFocusTime: 1800,
		...over,
	};
}

function meta(mode: TimingMode): AcMoveMeta {
	return { mode, thinkMs: 600, clockMs: 120_000, nReasonable: 2 };
}

/** The violations `assertWellFormedAc` reports for one blob, or `[]` when it accepts it. */
function violations(ac: AcBlob, mode: TimingMode): string[] {
	try {
		assertWellFormedAc([ac], { moves: [meta(mode)] });
		return [];
	} catch (error) {
		const list = (error as { violations?: string[] }).violations;
		if (!list) throw error;
		return list;
	}
}

describe("ac well-formedness: a row has to describe a real window", () => {
	it("accepts a clean premove row", () => {
		expect(violations(blob(), "premove")).toEqual([]);
	});

	it("refuses the exact shape review caught: a window that cannot contain its own hold", () => {
		// A premove report closing the *next* position's window produced this: the hold is the drag's
		// several hundred ms, and the window it claims to have happened in has no duration at all.
		const bad = violations(blob({ MoveHoldTime: 458, TotalFocusTime: 0 }), "premove");
		expect(bad.join(" ")).toContain("shorter than MoveHoldTime");
	});

	it("measures the window as focus + blur, so a blurred stretch does not shorten it", () => {
		// 1200 ms focused plus 900 ms blurred is a 2100 ms window around a 1500 ms hold: well formed.
		const ac = blob({
			MoveHoldTime: 1500,
			TotalFocusTime: 1200,
			TotalBlurTime: 900,
			BlurCount: 1,
			DidBlurOnOpponentTurn: true,
			MoveToFirstBlurTime: 300,
		});
		expect(violations(ac, "premove")).toEqual([]);
		// …and 200 + 100 ms is not a window that can contain a 1500 ms hold, blur or no blur.
		const tooShort = violations({ ...ac, TotalFocusTime: 200, TotalBlurTime: 100 }, "premove");
		expect(tooShort.join(" ")).toContain("shorter than MoveHoldTime");
	});

	it("refuses blur evidence on a row that claims no blur", () => {
		expect(violations(blob({ TotalBlurTime: 5 }), "normal").join(" ")).toContain(
			"TotalBlurTime 5 with BlurCount 0"
		);
		expect(violations(blob({ DidToggle: true }), "normal").join(" ")).toContain(
			"DidToggle with BlurCount 0"
		);
		expect(violations(blob({ MoveToFirstBlurTime: 10 }), "normal").join(" ")).toContain(
			"MoveToFirstBlurTime set with BlurCount 0"
		);
	});

	it("refuses a negative or non-finite field", () => {
		expect(violations(blob({ PointerOffset: -1 }), "normal").join(" ")).toContain("PointerOffset -1");
		expect(violations(blob({ MoveHoldTime: Number.NaN }), "normal").join(" ")).toContain(
			"MoveHoldTime"
		);
	});
});

describe("ac conduct: whose focus edge is it", () => {
	/** The owner's own blur, during the opponent's turn — the window a premove is dragged in. */
	const ownersBlur = blob({
		BlurCount: 1,
		DidBlurOnOpponentTurn: true,
		TotalBlurTime: 700,
		TotalFocusTime: 1100,
		MoveToFirstBlurTime: 400,
	});

	it("accepts the owner's blur on a premove row: his behaviour, not our misconduct", () => {
		// §13.4 is a rule about the assistant never moving focus, and it still never does. A premove's
		// window is opened over the opponent's turn, when the owner is free to click whatever he likes.
		expect(violations(ownersBlur, "premove")).toEqual([]);
	});

	it("still refuses it on every other mode, where the window is one we own", () => {
		for (const mode of ["normal", "long", "instant"] as const)
			expect(violations(ownersBlur, mode).join(" ")).toContain("BlurCount 1");
	});

	it("still refuses a focus edge on our own turn, premove or not", () => {
		const ourTurn = blob({ BlurCount: 1, DidBlurOnOwnTurn: true, TotalBlurTime: 700 });
		expect(violations(ourTurn, "premove").join(" ")).toContain("on our turn");
		expect(violations(ourTurn, "normal").join(" ")).toContain("on our turn");
	});

	it("still refuses a toggle and an unexplained focus timing on a non-premove row", () => {
		const toggled = blob({
			BlurCount: 1,
			DidBlurOnOpponentTurn: true,
			DidFocusOnOpponentTurn: true,
			DidToggle: true,
			TotalBlurTime: 300,
			LastFocusToMoveTime: 200,
		});
		expect(violations(toggled, "normal").join(" ")).toContain("DidToggle");
		expect(violations(toggled, "premove")).toEqual([]); // the owner clicked away and came back
	});

	it("never excuses untrusted input, whatever the mode", () => {
		for (const mode of ["premove", "normal"] as const)
			expect(violations(blob({ EventTrusted: false }), mode).join(" ")).toContain(
				"EventTrusted false"
			);
	});

	it("holds the hold-time floor for a searched move and exempts premove/instant", () => {
		const fast = blob({ MoveHoldTime: TELEMETRY_BANDS.holdTime.minMs - 1 });
		expect(violations(fast, "normal").join(" ")).toContain("MoveHoldTime");
		expect(violations(fast, "premove")).toEqual([]);
		expect(violations(fast, "instant")).toEqual([]);
	});
});
