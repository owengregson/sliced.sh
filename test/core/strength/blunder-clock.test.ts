// test/core/strength/blunder-clock.test.ts — fix C step 4: accuracy falls on the same continuum as
// the pace, and on the same relative-to-base basis.
//
// The owner's live 3+0 report asked for two things on one continuum: "as the time gets towards the
// end, play should get worse (less good moves) but also faster". The pace half is
// `test/core/timing/clock-response.test.ts`; this is the accuracy half.
//
// Measured before the change (E = 1650, cpStd 50, scale 1, no damper): `b` was 0.0260 at every clock
// from 180 s down to 20 s, then 0.0455 at 10 s and 0.0553 at 5 s — flat for the whole game and only
// moving in the last seconds, because `blunder.clockPressureMs` is an absolute 20 000 ms. In a 10+0
// game that is 3 % of the base clock; in a 1+0 game it is a third of it.
//
// The relative term is therefore a `max` with the absolute one, never a replacement: the late-game
// rate the existing tests and the §13.2 runs measure cannot go *down*, `b0`'s Elo anchoring is
// untouched, and the total bound on `f_clock` is still `1 + clockGain`.
import { describe, expect, it } from "bun:test";
import { blunderTerms } from "@core/strength/blunder-model";
import { SELECTION_CONSTANTS } from "@core/strength/constants";
import { b0For } from "@core/strength/elo-map";
import { createSelectionState } from "@core/strength/move-selector";

const B = SELECTION_CONSTANTS.blunder;
const E = 1650;

/** The three speeds the owner's report spans, as `[name, baseMs]`. */
const SPEEDS: ReadonlyArray<readonly [string, number]> = [
	["1+0", 60_000],
	["3+0", 180_000],
	["10+0", 600_000],
];

/** Fractions of the game's own base clock, full clock first. */
const FRACTIONS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 1 / 3, 0.25, 1 / 6, 1 / 12, 0] as const;

function terms(myClockMs: number, baseMs?: number) {
	return blunderTerms(E, {
		myClockMs,
		cpStd: 50,
		blunderScale: 1,
		state: createSelectionState(),
		...(baseMs === undefined ? {} : { baseMs }),
	});
}

describe("f_clock across the whole clock (fix C step 4)", () => {
	it("is 1 on a full clock and leaves b0's Elo anchoring alone", () => {
		for (const [name, baseMs] of SPEEDS) {
			const t = terms(baseMs, baseMs);
			expect(t.fClock, name).toBe(1);
			expect(t.b0, name).toBeCloseTo(b0For(E), 12);
			expect(t.b, name).toBeCloseTo(b0For(E), 12);
		}
	});

	it("rises as the clock falls, at every speed, with no flat stretch above the knee's floor", () => {
		for (const [name, baseMs] of SPEEDS) {
			let previous = 0;
			let rises = 0;
			for (const fraction of FRACTIONS) {
				const t = terms(baseMs * fraction, baseMs);
				expect(t.fClock, `${name} at ${fraction}`).toBeGreaterThanOrEqual(previous);
				if (t.fClock > previous) rises++;
				previous = t.fClock;
			}
			// not one step at the very end: the response is spread across the clock
			expect(rises, name).toBeGreaterThanOrEqual(FRACTIONS.length - 3);
		}
	});

	it("means the same thing in 1+0, 3+0 and 10+0 at the same fraction of the base clock", () => {
		// The actual defect in `clockPressureMs = 20_000`: 20 s is a third of a 1+0 game and 3 % of a
		// 10+0. Compared at fractions where the absolute term is not the binding one.
		for (const fraction of FRACTIONS) {
			if (fraction < 0.25) continue; // below this the absolute 20 s term starts to bind in 1+0
			const fs = SPEEDS.map(([, baseMs]) => terms(baseMs * fraction, baseMs).fClock);
			const first = fs[0] ?? 0;
			for (const f of fs) expect(f).toBeCloseTo(first, 12);
		}
	});

	it("stays bounded by 1 + clockGain — it scales the existing injection, it is not a new mode", () => {
		for (const [name, baseMs] of SPEEDS)
			for (const fraction of FRACTIONS) {
				const t = terms(baseMs * fraction, baseMs);
				expect(t.fClock, `${name} at ${fraction}`).toBeLessThanOrEqual(1 + B.clockGain);
				expect(t.fClock, `${name} at ${fraction}`).toBeGreaterThanOrEqual(1);
				// and the whole channel is still b0 · f_clock · f_complexity · scale · damper
				expect(t.b, `${name} at ${fraction}`).toBeCloseTo(t.b0 * t.fClock * t.fComplexity, 12);
			}
	});

	it("never makes the late game more accurate than it is today", () => {
		// The absolute term is kept as a floor, so every clock reading is at least as error-prone as
		// before this change. That is what lets the existing §7.2 assertions and the §13.2 runs stand.
		for (const [name, baseMs] of SPEEDS)
			for (const fraction of FRACTIONS) {
				const clockMs = baseMs * fraction;
				expect(terms(clockMs, baseMs).fClock, `${name} at ${fraction}`).toBeGreaterThanOrEqual(
					terms(clockMs).fClock
				);
			}
	});

	it("with no base clock known it is exactly today's absolute curve", () => {
		// An untimed game, or a position whose time control the page has not answered yet: there is no
		// "fraction of the base clock" to speak of, so the relative term must not invent one.
		for (const clockMs of [600_000, 60_000, 20_000, 10_000, 0]) {
			const expected =
				1 + B.clockGain * Math.min(1, Math.max(0, (B.clockPressureMs - clockMs) / B.clockPressureMs));
			expect(terms(clockMs).fClock, `${clockMs} ms`).toBeCloseTo(expected, 12);
			expect(terms(clockMs, 0).fClock, `${clockMs} ms, base 0`).toBeCloseTo(expected, 12);
		}
	});

	it("the owner's own game: at 1:00 of a 3+0 the injected-error rate is visibly higher than at 3:00", () => {
		const full = terms(180_000, 180_000).b;
		const minute = terms(60_000, 180_000).b;
		expect(minute).toBeGreaterThan(full * 1.4);
		// …and still bounded well inside the channel's own ceiling
		expect(minute).toBeLessThanOrEqual(full * (1 + B.clockGain));
	});
});
