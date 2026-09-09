// test/behavioral/telemetry/pointer-continuity.test.ts — Task 33 Step 2 (e), §13.5 / §9.6a: the
// pointer the page sees is one continuous hand. `PointerOffset` of every blob equals the hand's own
// path length over that period (the sum of its CDP dispatch steps), no step exceeds the profile's
// maximum, clicks release within 2 px of their press, and the hand never teleports between moves.
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { runSimulatedGame, type SimulatedGame } from "@test/sim/telemetry/harness";
import { assertHumanShapedAc, moveMetaOf } from "../../../tools/telemetry-conformance/ac-model";

const FORBIDDEN_METHODS = ["Page.bringToFront", "Emulation.setFocusEmulationEnabled"];

let game: SimulatedGame | null = null;
afterEach(async () => {
	await game?.dispose();
	game = null;
});

describe("telemetry: pointer continuity (Step 2e)", () => {
	it("PointerOffset equals the hand's path length per move window, with no jump above the profile's max step", async () => {
		game = await runSimulatedGame({
			seed: "reference-game",
			moves: SIM_TELEMETRY.referenceGameMoves,
		});
		expect(game.moves.every((m) => m.result.ok)).toBe(true);
		assertHumanShapedAc(game.acs, { moves: game.moves.map(moveMetaOf) });

		// every command the whole game issued, in order; the periods of the blobs partition them
		const all = game.sim.debugger.commands;
		for (const c of all) {
			expect(c.method).toBe(CDP.inputDispatchMouseEvent);
			expect(FORBIDDEN_METHODS).not.toContain(c.method);
		}
		// the page's view starts at the first event it sees: the step from the arm-time rest point
		// to the first dispatch is invisible to it (and is bounded below, from the CDP side)
		let prev: { x: number; y: number } | null = null;
		let periodStart = Number.NEGATIVE_INFINITY;
		let periodEnd = Number.NEGATIVE_INFINITY;
		let cursor = 0;
		for (const obs of game.observations) {
			periodStart = periodEnd;
			periodEnd = obs.diag.submittedAt;
			// the hand's own path length over the period: sum of steps between consecutive dispatches
			let length = 0;
			while (cursor < all.length && (all[cursor]?.at ?? Number.POSITIVE_INFINITY) <= periodEnd) {
				const p = all[cursor]?.params as { x: number; y: number };
				if (prev) {
					const step = Math.hypot(p.x - prev.x, p.y - prev.y);
					length += step;
					expect(step).toBeLessThanOrEqual(TELEMETRY_BANDS.pointer.maxStepPx);
				}
				prev = { x: p.x, y: p.y };
				cursor += 1;
			}
			expect(obs.ac.PointerOffset).toBeCloseTo(length, 6);
			expect(obs.diag.pointerMaxStepPx).toBeLessThanOrEqual(TELEMETRY_BANDS.pointer.maxStepPx);
			// no teleport into the period: the first step continues from where the last one ended
			if (obs.diag.pointerFirstStepPx !== null)
				expect(obs.diag.pointerFirstStepPx).toBeLessThanOrEqual(TELEMETRY_BANDS.pointer.maxStepPx);
			expect(periodStart).toBeLessThan(periodEnd);
		}
		// every press/release pair of a click (same square) is within 2 px; drags release in the target
		for (const obs of game.observations) {
			for (const press of obs.diag.presses) {
				// §13.5's 2 px is the drift of a *click* — a press and release with no pointer
				// motion between them. A preview drag that snaps back releases on its own square
				// too, and its release is a whole path away from the press by design.
				if (press.square !== null && press.releaseSquare === press.square) {
					if (press.movesDuring === 0)
						expect(press.driftPx).toBeLessThanOrEqual(TELEMETRY_BANDS.pointer.clickDriftMaxPx);
					else expect(press.driftPx).toBeLessThanOrEqual(SIM_TELEMETRY.squareDiagonalPx);
				}
			}
			const commit = obs.diag.presses[obs.diag.presses.length - 1];
			expect(commit?.releaseSquare === obs.diag.to || commit?.square === obs.diag.to).toBe(true);
		}
		// the hand's start of each move is where the previous one rested (ownership is authoritative)
		for (let i = 1; i < game.moves.length; i++) {
			const first = game.moves[i]?.commands[0];
			const last = game.moves[i - 1]?.commands.at(-1);
			if (!first || !last) continue;
			expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThanOrEqual(
				TELEMETRY_BANDS.pointer.maxStepPx
			);
		}
		// the first move started from the real cursor the content script reported before arming
		expect(game.moves[0]?.commands[0]).toBeDefined();
		const start = game.moves[0]?.commands[0];
		expect(
			Math.hypot(
				(start?.x ?? 0) - SIM_TELEMETRY.restPoint.x,
				(start?.y ?? 0) - SIM_TELEMETRY.restPoint.y
			)
		).toBeLessThanOrEqual(TELEMETRY_BANDS.pointer.maxStepPx);
	});

	it("the pointer never moves while the page is unfocused: after a panel click no mouseMoved reaches the page until focus returns", async () => {
		game = await runSimulatedGame({
			seed: "panel-click",
			moves: 2,
			duringMove: async ({ index, site, sim }) => {
				if (index !== 1) return;
				await sim.time.advance(250);
				site.panelClick();
			},
		});
		const skipped = game.moves.find((m) => m.index === 1 && !m.result.ok);
		expect(skipped).toBeDefined();
		// both timestamps must exist: a `NaN` bound would make every comparison below false and
		// leave `between` trivially empty, i.e. the assertion would pass by not running.
		expect(skipped?.blurAt).toBeDefined();
		expect(skipped?.blurSeenAt).toBeDefined();
		const blurAt = skipped?.blurAt ?? Number.NaN;
		const blurSeenAt = skipped?.blurSeenAt ?? Number.NaN;
		expect(Number.isFinite(blurAt)).toBe(true);
		expect(Number.isFinite(blurSeenAt)).toBe(true);
		// the page saw no pointer event between the gate's veto and the click back into the board
		const focusBackAt = blurAt + SIM_TELEMETRY.refocusPauseMs;
		expect(focusBackAt).toBeGreaterThan(blurSeenAt);
		const between = game.sim.input.events.filter((e) => e.at > blurSeenAt && e.at < focusBackAt);
		expect(between).toEqual([]);
	});
});
