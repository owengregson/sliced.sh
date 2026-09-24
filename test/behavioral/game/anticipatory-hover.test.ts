// test/behavioral/game/anticipatory-hover.test.ts — anticipatory hover (2026-09-24,
// `docs/qa/anticipatory-hover-2026-09-24.md`). While the opponent thinks, the idle hand may rest
// on the piece that answers the reply the ponder expects, above all a recapture. When that reply
// lands, the timing model plans a short anticipated reply and the hand runs a prepared touch from
// where it already is. The hover is free movement only: no button, no selection, and a continuous
// pointer. When the prediction misses, the move is an ordinary one.
//
// The timing side of the interface is emulated by `anticipation-wiring.ts` (see there).
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { ANTICIPATION } from "@core/motor/constants";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import type { CdpCommandRecord } from "@test/sim/types";
import type { Square } from "@typedefs/game";
import { emulateAnticipatedPlanning } from "./anticipation-wiring";
import { createGameHarness, type GameHarness } from "./harness";
import { positionKey } from "./scripted-engine";

const MAX_STEP_PX = TELEMETRY_BANDS.pointer.maxStepPx;

/** White: Ke1, Nc3, b2. Black: Ke8, Bb4. We shuffle the king; they take on c3; we recapture. */
const FEN = "4k3/8/8/8/1b6/2N5/1P6/4K3 w - - 0 1";
const OPPONENT_TURN = "4k3/8/8/8/1b6/2N5/1P6/5K2 b - - 1 1";
const AFTER_CAPTURE = "4k3/8/8/8/8/2b5/1P6/5K2 w - - 0 2";
const BLITZ = { baseMs: 180_000, incMs: 0 };

let h: GameHarness | null = null;
let restore: (() => void) | null = null;
afterEach(async () => {
	await h?.dispose();
	h = null;
	restore?.();
	restore = null;
});

interface Turn {
	h: GameHarness;
	hover: Square | null;
	arrivedAt: number;
	/** When their turn began (our first move was on the board). */
	turnAt: number;
	/** Every mouse event dispatched so far. */
	events: () => CdpCommandRecord[];
}

/** Play our first move, let the opponent think `thinkMs`, and stop just before their reply. */
async function opponentThinks(seed: string, thinkMs = 3000, premoves = false): Promise<Turn> {
	let hoverAtArrival: Square | null = null;
	restore = emulateAnticipatedPlanning(() => hoverAtArrival, seed);
	const g = await createGameHarness({
		myColor: "w",
		fen: FEN,
		seed,
		gameId: seed,
		timeControl: BLITZ,
		premoves,
		settings: {
			automation: { autoMove: true },
			strength: { matchOpponentRating: false, targetElo: 2700 },
			timing: { premoveTendency: premoves ? 1 : 0 },
			display: { virtualCursor: true },
		},
		script: {
			pvDepth: 2,
			...(premoves ? { bestCp: 900, stepCp: 900 } : { bestCp: 40, stepCp: 15 }),
			prefer: new Map([
				[positionKey(FEN), ["e1f1"]],
				[positionKey(OPPONENT_TURN), ["b4c3"]],
				[positionKey(AFTER_CAPTURE), ["b2c3"]],
			]),
		},
	});
	h = g;
	const clocks = { w: BLITZ.baseMs, b: BLITZ.baseMs };
	await g.arrive(null, clocks);
	expect(await g.until(() => g.session().currentState() === "live:opponent-turn", 60_000)).toBe(
		true
	);
	await g.arrive(null, clocks);
	const turnAt = g.sim.now();
	await g.advance(thinkMs);
	hoverAtArrival = g.executor()?.hoverSquare() ?? null;
	return {
		h: g,
		hover: hoverAtArrival,
		arrivedAt: g.sim.now(),
		turnAt,
		events: () => g.sim.debugger.commandsFor(CDP.inputDispatchMouseEvent),
	};
}

/** Their reply lands; resolves once our answer is on the board. */
async function reply(turn: Turn, uci: string): Promise<void> {
	const before = turn.h.site.board.fen();
	await turn.h.arrive(uci, { w: BLITZ.baseMs, b: BLITZ.baseMs });
	const after = turn.h.site.board.fen();
	expect(await turn.h.until(() => turn.h.site.board.fen() !== after, 20_000, 5)).toBe(true);
	expect(turn.h.site.board.fen()).not.toBe(before);
}

function expectContinuous(events: Array<{ params?: Record<string, unknown> | undefined }>): void {
	let prev: { x: number; y: number } | null = null;
	for (const command of events) {
		const p = { x: Number(command.params?.x), y: Number(command.params?.y) };
		if (prev) expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThanOrEqual(MAX_STEP_PX);
		prev = p;
	}
}

function quantile(values: number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

describe("anticipatory hover", () => {
	it("pre-positions the idle hand over the recapturing piece: free movement only, continuous", async () => {
		let engaged = 0;
		const seeds = 10;
		for (let i = 0; i < seeds; i++) {
			const turn = await opponentThinks(`hover-engage-${i}`);
			const events = turn.events().filter((c) => c.at >= turn.turnAt);
			// Nothing but free movement on their turn: no button, no press, never a jump.
			expect(events.some((c) => c.params?.type !== "mouseMoved")).toBe(false);
			expect(events.every((c) => c.params?.buttons === 0)).toBe(true);
			expectContinuous(events);
			if (turn.hover !== null) {
				engaged += 1;
				expect(turn.hover).toBe("b2");
				const last = events.at(-1)?.params;
				const rect = turn.h.site.board.squareRect("b2");
				const pad = rect.width * ANTICIPATION.hoverToleranceFrac;
				expect(Number(last?.x)).toBeGreaterThanOrEqual(rect.left - pad);
				expect(Number(last?.x)).toBeLessThanOrEqual(rect.left + rect.width + pad);
			}
			await h?.dispose();
			h = null;
			restore?.();
			restore = null;
		}
		// Blitz recapture odds are 0.75 a turn: most turns hover, and never all by construction.
		expect(engaged).toBeGreaterThanOrEqual(Math.floor(seeds * 0.4));
	});

	it("answers the anticipated recapture fast but humanly, from the hover point, on its planned time", async () => {
		const latencies: number[] = [];
		for (let i = 0; latencies.length < 8 && i < 20; i++) {
			const turn = await opponentThinks(`hover-latency-${i}`);
			if (turn.hover === "b2") {
				const beforeReply = turn.events().length;
				const handAt = turn.events().at(-1)?.params;
				await reply(turn, "b4c3");
				const plan = turn.h.session().recommendation()?.plan;
				expect(plan?.features.anticipated).toBe(1);
				const ours = turn.events().slice(beforeReply);
				const release = ours.filter((c) => c.params?.type === "mouseReleased").at(-1);
				const press = ours.find((c) => c.params?.type === "mousePressed");
				expect(press && release).toBeTruthy();
				// Never before their move is on the board, and the hand sets off from where it hovered.
				expect(press?.at ?? 0).toBeGreaterThan(turn.arrivedAt);
				expectContinuous([{ params: handAt ?? {} }, ...ours]);
				const pressRect = turn.h.site.board.squareRect("b2");
				expect(Number(press?.params?.x)).toBeGreaterThanOrEqual(pressRect.left);
				expect(Number(press?.params?.x)).toBeLessThanOrEqual(pressRect.left + pressRect.width);
				const latency = (release?.at ?? 0) - turn.arrivedAt;
				// The prepared touch fits the anticipated plan: no overrun past its deadline.
				expect(latency).toBeLessThanOrEqual((plan?.thinkMs ?? 0) + 20);
				latencies.push(latency);
			}
			await h?.dispose();
			h = null;
			restore?.();
			restore = null;
		}
		expect(latencies.length).toBeGreaterThanOrEqual(6);
		expect(Math.min(...latencies)).toBeGreaterThanOrEqual(ANTICIPATION.floorMs);
		const p50 = quantile(latencies, 0.5);
		expect(p50).toBeGreaterThanOrEqual(450);
		expect(p50).toBeLessThanOrEqual(800);
		// Jittered: never one repeated value.
		expect(new Set(latencies.map((l) => Math.round(l))).size).toBeGreaterThan(latencies.length / 2);
	}, 60_000);

	it("leaves no tell when the prediction misses: an ordinary plan and an ordinary move", async () => {
		let checked = 0;
		for (let i = 0; checked < 2 && i < 10; i++) {
			const turn = await opponentThinks(`hover-miss-${i}`);
			if (turn.hover === "b2") {
				const beforeReply = turn.events().length;
				const handAt = turn.events().at(-1)?.params;
				// The bishop retreats instead of taking: nothing to recapture, the ponder missed.
				await reply(turn, "b4a5");
				const plan = turn.h.session().recommendation()?.plan;
				expect(plan?.features.anticipated).toBeUndefined();
				expect(plan?.mode).not.toBe("premove");
				expect(plan?.window.orientationMs ?? 0).toBeGreaterThanOrEqual(
					TIMING_CONSTANTS.orientation.minMs
				);
				const ours = turn.events().slice(beforeReply);
				const press = ours.find((c) => c.params?.type === "mousePressed");
				expect(press?.at ?? 0).toBeGreaterThan(turn.arrivedAt);
				expectContinuous([{ params: handAt ?? {} }, ...ours]);
				checked += 1;
			}
			await h?.dispose();
			h = null;
			restore?.();
			restore = null;
		}
		expect(checked).toBe(2);
	}, 60_000);

	it("does not hover while a premove is armed: that hand already has its piece", async () => {
		const turn = await opponentThinks("hover-premove-0", 3000, true);
		expect(turn.h.site.board.premoveQueued()).not.toBeNull();
		expect(turn.hover).toBeNull();
	});
});
