// test/behavioral/telemetry/single-piece-select.test.ts — Task 33 Step 2 (a) band + (d).
//
// `DidSelectMultiplePieces` is a **population** rate (§13.2 / §9.3a): the 4–12 % band is only
// meaningful over a large sample, so it is asserted over the pooled non-trivial moves of twelve
// seeded games (N ≥ 200) and a single game is held to the weak invariant alone — never 0 %, never
// 100 %, never above the 25 % hard cap. Every preview, in every game, must be a resolved selection
// (select → deselect or select → switch, V2.1 §9.3a), and before the committed press the page sees
// only pointermoves except for those modelled previews. Everything is read from the `ac` shadow
// (the page's view), never from executor internals.
import { afterEach, describe, expect, it } from "bun:test";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { runSimulatedGame, type SimulatedGame } from "@test/sim/telemetry/harness";
import type { AcBlob } from "@typedefs/telemetry";
import {
	type AcMoveMeta,
	assertHumanShapedAc,
	isNonTrivial,
	moveMetaOf,
	summarizeAc,
} from "../../../tools/telemetry-conformance/ac-model";

const POOL = SIM_TELEMETRY.previewPool;
/** Real-time budget for the pooled run (virtual time is free; the DOM dispatches are not). */
const POOL_TIMEOUT_MS = 60_000;

let game: SimulatedGame | null = null;
afterEach(async () => {
	await game?.dispose();
	game = null;
});

describe("telemetry: preview selections at a human rate (Step 2a band, 2d)", () => {
	it("the per-game DidSelectMultiplePieces rate is neither 0 % nor 100 % and every preview is a resolved selection", async () => {
		game = await runSimulatedGame({
			seed: "reference-game",
			moves: SIM_TELEMETRY.referenceGameMoves,
		});
		expect(game.moves.every((m) => m.result.ok)).toBe(true);
		const meta = game.moves.map(moveMetaOf);
		const summary = assertHumanShapedAc(game.acs, { moves: meta });
		const eligible = meta.filter(isNonTrivial).length;
		expect(eligible).toBeGreaterThan(0);
		expect(summary.multiSelect.eligible).toBe(eligible);
		const rate = summary.multiSelect.rate ?? 0;
		// the single-game invariant: some previews, not all moves, under the hard cap
		expect(summary.multiSelect.count).toBeGreaterThan(0);
		expect(summary.multiSelect.count).toBeLessThan(eligible);
		expect(rate).toBeLessThanOrEqual(TELEMETRY_BANDS.multiSelect.hardMax);
		// previews only happen on non-trivial moves (never premove/instant, never in time trouble)
		game.acs.forEach((ac, i) => {
			if (ac.DidSelectMultiplePieces) expect(isNonTrivial(meta[i]!)).toBe(true);
		});

		for (const m of game.moves) {
			const d = m.observation?.diag;
			expect(d).toBeDefined();
			if (!d) continue;
			// (d): before the committed press only pointermoves, except modelled previews
			const before = d.presses.slice(0, -1);
			const commit = d.presses[d.presses.length - 1];
			expect(commit?.action).toBe("move");
			// the committed move is the recommended one, made by our own piece, trusted
			expect(`${d.from}${d.to}`).toBe(m.uci.slice(0, 4));
			expect(commit?.trusted).toBe(true);
			// every earlier press is part of a resolved preview: it selected a piece, deselected, or
			// (click-click) was the committed piece's own first click; never a stray press
			for (const p of before) expect(["select", "switch", "deselect"]).toContain(p.action);
			// a preview never leaves a selection whose legal destinations include the committed press
			expect(d.pendingSelectionAtCommit === null || d.pendingSelectionAtCommit !== d.from).toBe(true);
			// a multi-select move is exactly a preview (another piece selected) followed by the move
			if (m.observation?.ac.DidSelectMultiplePieces) {
				expect(d.selections.length).toBeGreaterThan(1);
				expect(d.selections[d.selections.length - 1]).toBe(d.from);
				// resolved: either a deselect press happened, or the committed press switched selection
				const resolvedByDeselect = before.some((p) => p.action === "deselect");
				const resolvedBySwitch =
					d.pendingSelectionAtCommit !== null || before.some((p) => p.action === "switch");
				expect(resolvedByDeselect || resolvedBySwitch).toBe(true);
			} else {
				// no preview: the only piece ever selected is the committed one
				expect(d.selections).toEqual([d.from]);
			}
			// the site never saw a stuck selection after the move
		}
		expect(game.site.shadow.pendingSelection()).toBeNull();
		// the adapter verified every move exactly once (no retries, no double presses)
		expect(game.site.observeRequests()).toHaveLength(SIM_TELEMETRY.referenceGameMoves);
	});

	it(
		`the pooled DidSelectMultiplePieces rate over N ≥ ${TELEMETRY_BANDS.multiSelect.minMovesForBand} non-trivial moves (${POOL.games} seeded ${POOL.movesPerGame}-move games) sits inside the 4–12 % band`,
		async () => {
			const acs: AcBlob[] = [];
			const meta: AcMoveMeta[] = [];
			for (let g = 0; g < POOL.games; g++) {
				const g_ = await runSimulatedGame({ seed: `preview-pool-${g}`, moves: POOL.movesPerGame });
				try {
					expect(g_.moves.every((m) => m.result.ok)).toBe(true);
					for (const m of g_.moves) {
						const obs = m.observation;
						expect(obs).toBeDefined();
						if (!obs) continue;
						acs.push(obs.ac);
						meta.push(moveMetaOf(m));
					}
				} finally {
					await g_.dispose();
				}
			}
			const summary = summarizeAc(acs, meta);
			// the population is large enough for the band to mean anything …
			expect(summary.multiSelect.eligible).toBeGreaterThanOrEqual(
				TELEMETRY_BANDS.multiSelect.minMovesForBand
			);
			// … and the shared assertion applies it at this sample size
			expect(assertHumanShapedAc(acs, { moves: meta })).toEqual(summary);
			const [lo, hi] = TELEMETRY_BANDS.multiSelect.rate;
			const rate = summary.multiSelect.rate ?? 0;
			expect(rate).toBeGreaterThanOrEqual(lo);
			expect(rate).toBeLessThanOrEqual(hi);
			// and no preview ever fell on a trivial move
			acs.forEach((ac, i) => {
				if (ac.DidSelectMultiplePieces) expect(isNonTrivial(meta[i]!)).toBe(true);
			});
		},
		POOL_TIMEOUT_MS
	);

	it("with previews off (scale 0) the game has no multi-select and the assertion reports the 0 % band miss", async () => {
		game = await runSimulatedGame({
			seed: "reference-game",
			moves: SIM_TELEMETRY.referenceGameMoves,
			previewScale: 0,
		});
		expect(game.acs.every((ac) => !ac.DidSelectMultiplePieces)).toBe(true);
		expect(() => assertHumanShapedAc(game!.acs, { moves: game!.moves.map(moveMetaOf) })).toThrow(
			/multi-select rate 0 %/
		);
	});
});
