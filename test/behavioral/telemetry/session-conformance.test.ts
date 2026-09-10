// test/behavioral/telemetry/session-conformance.test.ts — Task 30, checklist item 6: the Task 33
// conformance harness re-run **end to end through the `GameSession` orchestrator**. The page half,
// the `ac` shadow and `assertHumanShapedAc` are unchanged (Task 33 ruling 6); only the driver
// differs — every move goes position → session → recommendation → executor → verified drop, and
// the session writes the §8.6 row and its §13.2 `MoveTelemetryRecord` for each one.
import { afterEach, describe, expect, it } from "bun:test";
import { checkBand } from "@core/strength/bands";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import {
	runSimulatedGame,
	type SimulatedGame,
	telemetryRecordOf,
} from "@test/sim/telemetry/harness";
import { createSessionDriver, type SessionDriver } from "@test/sim/telemetry/session-driver";
import type { AcBlob } from "@typedefs/telemetry";
import {
	type AcMoveMeta,
	assertHumanShapedAc,
	moveMetaOf,
	summarizeAc,
} from "../../../tools/telemetry-conformance/ac-model";

const RUN_TIMEOUT_MS = 60_000;
const POOL_TIMEOUT_MS = 120_000;
/** Enough orchestrated games that the §7.2 agreement rate is not a coin flip. */
const POOL_GAMES = 5;

let game: SimulatedGame | undefined;
let driver: SessionDriver | undefined;
afterEach(async () => {
	driver?.dispose();
	driver = undefined;
	await game?.dispose();
	game = undefined;
});

describe("telemetry: the orchestrator end to end (Task 30 / Task 33 ruling 6)", () => {
	it(
		"a full game driven through the GameSession is `ac`-conformant and every move carries its telemetry record",
		async () => {
			driver = createSessionDriver({ gameId: "orchestrated" });
			game = await runSimulatedGame({
				seed: "orchestrated",
				moves: SIM_TELEMETRY.referenceGameMoves,
				driver,
			});
			expect(game.moves).toHaveLength(SIM_TELEMETRY.referenceGameMoves);
			expect(game.moves.every((m) => m.result.ok && m.result.outcome === "executed")).toBe(true);

			// §13.4 / §13.5: exactly the same shape assertion the direct-executor run passes.
			const summary = assertHumanShapedAc(game.acs, { moves: game.moves.map(moveMetaOf) });
			expect(summary.n).toBe(game.moves.length);
			expect(summary.blurCount).toBe(0);
			expect(summary.toggles).toBe(0);
			expect(summary.untrusted).toBe(0);
			expect(summary.focusFieldsSet).toBe(0);
			expect(game.blurBits.every((b) => b === 0)).toBe(true);
			expect(game.focusApiCalls).toEqual({
				tabsUpdate: 0,
				windowsUpdate: 0,
				bringToFront: 0,
			});

			// The session wrote one §8.6 row per move, each with its §13.2 record filled.
			const entries = driver.entries();
			expect(entries).toHaveLength(game.moves.length);
			for (const entry of entries) {
				expect(entry.actualMs).not.toBeNull();
				expect(entry.telemetry).toBeDefined();
				const t = entry.telemetry;
				if (!t) continue;
				expect(t.ac.EventTrusted).toBe(true);
				expect(t.ac.BlurCount).toBe(0);
				expect(t.ac.DidToggle).toBe(false);
				expect(t.ac.DidBlurOnOwnTurn).toBe(false);
				expect(t.ac.DidBlurOnOpponentTurn).toBe(false);
				expect(t.ac.MoveHoldTime).toBeGreaterThan(0);
				expect(t.ac.PointerOffset).toBeGreaterThan(0);
				expect(t.ac.TotalBlurTime).toBe(0);
				expect(t.lichessBlur).toBe(0);
				expect(t.nReasonable).toBeGreaterThanOrEqual(1);
				expect(typeof t.top1).toBe("boolean");
				expect(t.cpLoss).toBeGreaterThanOrEqual(0);
				expect(t.ac.LastFocusToMoveTime).toBeUndefined();
				expect(t.ac.MoveToFirstBlurTime).toBeUndefined();
			}

			// The session's own record agrees with the page's `ac` blob on the fields both compute.
			game.moves.forEach((move, i) => {
				const page = telemetryRecordOf(move);
				const own = entries[i]?.telemetry;
				if (!page || !own) return;
				expect(own.orientationMs).toBeCloseTo(page.orientationMs, 6);
				expect(own.multiSelectEligible).toBe(page.multiSelectEligible);
				expect(own.ac.DidSelectMultiplePieces).toBe(page.ac.DidSelectMultiplePieces);
				expect(own.ac.EventTrusted).toBe(page.ac.EventTrusted);
				expect(own.lichessBlur).toBe(page.lichessBlur);
			});

			// The orchestrator drove the whole game: it ends on the opponent's clock.
			expect(driver.session()?.currentState()).toBe("live:opponent-turn");
		},
		RUN_TIMEOUT_MS
	);

	it(
		"a bullet game driven through the GameSession is `ac`-conformant with a bullet hand",
		async () => {
			// The orchestrator at the speed production could never reach before the time control was
			// wired through (§4.3). The harness derives the hand's motor class from the clock, and the
			// session is told the same clock the page reports, so the class cannot disagree with it.
			const clock = SIM_TELEMETRY.speeds.bullet;
			driver = createSessionDriver({
				gameId: "orchestrated-bullet",
				timeControl: { baseMs: clock.baseSec * 1000, incMs: clock.incSec * 1000 },
			});
			game = await runSimulatedGame({
				seed: "orchestrated-bullet",
				moves: SIM_TELEMETRY.referenceGameMoves,
				clock: { baseSec: clock.baseSec, incSec: clock.incSec },
				driver,
			});
			expect(game.moves.every((m) => m.result.ok && m.result.outcome === "executed")).toBe(true);
			const summary = assertHumanShapedAc(game.acs, { moves: game.moves.map(moveMetaOf) });
			expect(summary.blurCount).toBe(0);
			expect(summary.toggles).toBe(0);
			expect(summary.untrusted).toBe(0);
			expect(game.blurBits.every((b) => b === 0)).toBe(true);
			// the hand really is a bullet hand, and the session wrote a row per move
			expect(driver.session()?.executor()?.timeControlClass()).toBe("bullet");
			expect(driver.entries()).toHaveLength(game.moves.length);
			for (const entry of driver.entries()) expect(entry.telemetry).toBeDefined();
		},
		RUN_TIMEOUT_MS
	);

	it(
		"pooled over 5 orchestrated games (N = 150 moves) the §7.2 top-1 agreement is inside the band for the target",
		async () => {
			const acs: AcBlob[] = [];
			const meta: AcMoveMeta[] = [];
			let top1 = 0;
			let counted = 0;
			for (let g = 0; g < POOL_GAMES; g++) {
				const d = createSessionDriver({ gameId: `orchestrated-${g}` });
				const run = await runSimulatedGame({
					seed: `orchestrated-${g}`,
					moves: SIM_TELEMETRY.referenceGameMoves,
					driver: d,
				});
				try {
					acs.push(...run.acs);
					meta.push(...run.moves.map(moveMetaOf));
					for (const entry of d.entries()) {
						const t = entry.telemetry;
						if (!t) continue;
						counted += 1;
						if (t.top1) top1 += 1;
					}
				} finally {
					d.dispose();
					await run.dispose();
				}
			}
			expect(counted).toBe(POOL_GAMES * SIM_TELEMETRY.referenceGameMoves);
			const summary = summarizeAc(acs, meta);
			expect(summary.blurCount).toBe(0);
			expect(summary.untrusted).toBe(0);

			// §13.6 / Appendix E §1.6: the selection layer really runs in this path, so the
			// agreement column is a claim about the strength model rather than harness plumbing.
			const top1Pct = (100 * top1) / counted;
			const verdict = checkBand(SIM_TELEMETRY.game.targetElo, { top1Pct });
			expect(verdict.top1InBand).toBe(true);
			// ACPL is deliberately *not* asserted here: the harness's MultiPV lines carry a
			// synthetic centipawn scale (`SIM_TELEMETRY.lines`), so a loss measured against them
			// says nothing about the §7.2 band. Only the agreement rate is scale-free.
		},
		POOL_TIMEOUT_MS
	);
});
