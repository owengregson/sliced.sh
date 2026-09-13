import { describe, expect, it } from "bun:test";
import { loadPosition } from "@core/chess/fen";
import { applyMoves, legalMoves } from "@core/chess/san";
import { CHESS_START_FEN } from "@core/constants/chess";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { MOTOR_DEFAULTS, OPPONENT_EXPLORATION as O } from "@core/motor/constants";
import {
	type OpponentAttentionContext,
	opponentExplorationCandidates,
} from "@core/motor/opponent-candidates";
import {
	decideOpponentTurn,
	type ExplorationSpell,
	type OpponentExplorationOptions,
	type OpponentExplorationPlan,
	planOpponentExploration,
} from "@core/motor/opponent-exploration";
import type { TimeControlClass } from "@core/motor/types";
import { createRng } from "@core/rng";
import { BOARD, dist, geometry, inside, squareRect, totalMs } from "./fixtures";

const FEN = applyMoves(CHESS_START_FEN, ["e2e4"])!;
const CANDIDATES = opponentExplorationCandidates(FEN, "w");
const options = {
	geometry: geometry(),
	profile: MOTOR_DEFAULTS,
	cursor: { x: 700, y: 690 },
	...CANDIDATES,
};

/** 1.e4 e5 2.Nf3: black to move, we are white, their last move was e7e5. */
const FEN2 = applyMoves(CHESS_START_FEN, ["e2e4", "e7e5", "g1f3"])!;
const line = (pvUci: string[], multipv: number) => ({
	multipv,
	score: { cp: 10 },
	depth: 12,
	pvUci,
	pvSan: [],
});
const LINES = [
	line(["b8c6", "f1b5", "a7a6"], 1),
	line(["g8f6", "f3e5", "d7d6"], 2),
	line(["d7d6", "d2d4", "e5d4"], 3),
];
const RICH = opponentExplorationCandidates(FEN2, "w", LINES, { from: "e7", to: "e5" });
const attention = (over: Partial<OpponentAttentionContext> = {}): OpponentAttentionContext => ({
	tcClass: "rapid",
	opponentThinkMs: 0,
	myClockMs: 600_000,
	opponentClockMs: 600_000,
	phase: "middlegame",
	sharp: false,
	armed: false,
	...over,
});
const rich = (over: Partial<OpponentExplorationOptions> = {}): OpponentExplorationOptions => ({
	geometry: geometry(),
	profile: MOTOR_DEFAULTS,
	cursor: { x: 700, y: 690 },
	...RICH,
	attention: attention(),
	...over,
});

/** Run a whole turn: spells chained through `previousSpell`, the think advancing with them. */
function turn(
	seed: string,
	over: Partial<OpponentExplorationOptions>,
	ctx: Partial<OpponentAttentionContext>,
	spells: number
): OpponentExplorationPlan[] {
	const rng = createRng(seed);
	const plans: OpponentExplorationPlan[] = [];
	let previousSpell: ExplorationSpell | undefined;
	let previousTarget: string | undefined;
	let think = ctx.opponentThinkMs ?? 0;
	let cursor = over.cursor ?? { x: 700, y: 690 };
	for (let i = 0; i < spells; i++) {
		const plan = planOpponentExploration(
			rich({
				...over,
				cursor,
				attention: attention({ ...ctx, opponentThinkMs: think }),
				...(previousSpell ? { previousSpell } : {}),
				...(previousTarget ? { previousTarget: previousTarget as never } : {}),
			}),
			rng
		);
		plans.push(plan);
		previousSpell = plan.spell;
		previousTarget = plan.lastTarget ?? undefined;
		think += plan.durationMs;
		const last = plan.actions.flatMap((a) => a.path ?? []).at(-1);
		if (last) cursor = { x: last.x, y: last.y };
	}
	return plans;
}

const movementMs = (plan: OpponentExplorationPlan) =>
	plan.actions.reduce((sum, a) => sum + totalMs(a.path ?? []), 0);
const squares = (plan: OpponentExplorationPlan) =>
	plan.actions.filter((a) => a.square).map((a) => a.square!);

describe("opponent exploration candidates", () => {
	it("considers legal opponent moves and own replies to actual legal branches", () => {
		const position = loadPosition(FEN)!;
		const opponentLegal = legalMoves(FEN);
		expect(CANDIDATES.ownCandidates.length).toBeGreaterThan(3);
		expect(CANDIDATES.opponentCandidates.length).toBeGreaterThan(3);
		for (const candidate of CANDIDATES.opponentCandidates) {
			expect(opponentLegal).toContain(candidate.uci);
			expect(position.get(candidate.from)?.color).toBe("b");
		}
		for (const candidate of CANDIDATES.ownCandidates) {
			expect(position.get(candidate.from)?.color).toBe("w");
			expect(
				CANDIDATES.opponentCandidates.some((reply) =>
					legalMoves(applyMoves(FEN, [reply.uci])!).includes(candidate.uci)
				)
			).toBe(true);
		}
	});

	it("prefers a valid live PV and rejects illegal or stale continuations", () => {
		const makeLine = (pvUci: string[]) => ({
			multipv: 1,
			score: { cp: 10 },
			depth: 12,
			pvUci,
			pvSan: [],
		});
		const candidates = opponentExplorationCandidates(FEN, "w", [
			makeLine(["c7c5", "g1f3"]),
			makeLine(["h7h4", "e1e5"]),
		]);
		expect(candidates.opponentCandidates.find((move) => move.uci === "c7c5")?.probability).toBe(4);
		expect(candidates.ownCandidates.find((move) => move.uci === "g1f3")?.probability).toBe(4);
		expect(candidates.opponentCandidates.some((move) => move.uci === "h7h4")).toBe(false);
		expect(candidates.ownCandidates.some((move) => move.uci === "e1e5")).toBe(false);
		expect(opponentExplorationCandidates(FEN, "b").ownCandidates).toEqual([]);
		expect(opponentExplorationCandidates("bad fen", "w").opponentCandidates).toEqual([]);
	});

	it("reads the lines in move order and derives threats, kings, pieces and the last move", () => {
		expect(RICH.readings?.map((r) => r.steps.map((s) => `${s.side}:${s.from}${s.to}`))).toEqual([
			["opponent:b8c6", "own:f1b5", "opponent:a7a6"],
			["opponent:g8f6", "own:f3e5", "opponent:d7d6"],
			["opponent:d7d6", "own:d2d4", "opponent:e5d4"],
		]);
		// …Nf6 attacks e4; …d6 opens nothing new; …Nc6 attacks nothing of ours.
		expect(RICH.threats).toEqual(["e4"]);
		expect(RICH.kings).toEqual({ own: "e1", opponent: "e8" });
		expect(RICH.pieces).toHaveLength(32);
		expect(RICH.pieces?.find((p) => p.square === "f3")?.side).toBe("own");
		expect(RICH.lastMove).toEqual({ from: "e7", to: "e5" });
		// a PV whose second ply is not ours stops the reading at the reply
		const odd = opponentExplorationCandidates(FEN2, "w", [line(["b8c6", "b8c6"], 1)]);
		expect(odd.readings?.[0]?.steps).toHaveLength(1);
	});
});

describe("opponent exploration bouts", () => {
	it("keeps tactical bouts on our candidates and reduces activity further under low time", () => {
		let normalMovement = 0;
		let lowMovement = 0;
		for (let seed = 0; seed < 100; seed++) {
			const normal = planOpponentExploration(options, createRng(seed));
			normalMovement += normal.actions.reduce((sum, a) => sum + totalMs(a.path ?? []), 0);
			for (const policy of [{ ownOnly: true }, { lowTime: true }]) {
				const plan = planOpponentExploration({ ...options, policy }, createRng(seed));
				expect(plan.actions.every((a) => a.kind === "rest" || a.side === "own")).toBe(true);
				if ("lowTime" in policy) {
					expect(plan.durationMs).toBeGreaterThanOrEqual(O.lowTimeBoutMs[0]);
					expect(plan.durationMs).toBeLessThanOrEqual(O.lowTimeBoutMs[1]);
					lowMovement += plan.actions.reduce((sum, a) => sum + totalMs(a.path ?? []), 0);
				}
			}
		}
		expect(lowMovement).toBeLessThan(normalMovement / 2);
		const emptyOwn = planOpponentExploration(
			{ ...options, ownCandidates: [], policy: { ownOnly: true } },
			createRng(1)
		);
		expect(emptyOwn.actions.every((a) => a.kind === "rest")).toBe(true);
	});
	it("varies sustained candidate visits on both sides with real stationary pauses", () => {
		let active = 0;
		let movement = 0;
		let duration = 0;
		let own = 0;
		let opponent = 0;
		const lengths = new Set<number>();
		for (let seed = 0; seed < 200; seed++) {
			const plan = planOpponentExploration(options, createRng(seed));
			lengths.add(Math.round(plan.durationMs));
			expect(plan.durationMs).toBeGreaterThanOrEqual(O.boutMs[0]);
			expect(plan.durationMs).toBeLessThanOrEqual(O.boutMs[1]);
			expect(
				plan.actions.reduce((sum, action) => sum + action.dwellMs + totalMs(action.path ?? []), 0)
			).toBeCloseTo(plan.durationMs, 5);
			duration += plan.durationMs;
			let priorSquare: string | undefined;
			for (const action of plan.actions) {
				if (action.kind === "rest") {
					expect(action.path).toBeUndefined();
					continue;
				}
				const path = action.path!;
				expect(action.square).not.toBe(priorSquare);
				priorSquare = action.square;
				expect(inside(path.at(-1)!, squareRect(action.square!))).toBe(true);
				const candidates =
					action.side === "own" ? CANDIDATES.ownCandidates : CANDIDATES.opponentCandidates;
				expect(
					candidates.some(
						(candidate) => (action.kind === "hover" ? candidate.from : candidate.to) === action.square
					)
				).toBe(true);
				if (action.side === "own") own++;
				else opponent++;
				movement += totalMs(path);
				active += totalMs(path) + action.dwellMs;
			}
		}
		expect(lengths.size).toBeGreaterThan(150);
		expect(own).toBeGreaterThan(opponent * 0.6);
		expect(opponent).toBeGreaterThan(own * 0.6);
		expect(active / duration).toBeGreaterThan(0.5);
		expect(movement / duration).toBeGreaterThan(0.25);
		expect(active / duration).toBeLessThan(0.88);
	});

	it("never manufactures movement without candidates or valid geometry", () => {
		for (const overrides of [
			{ ownCandidates: [], opponentCandidates: [] },
			{ geometry: geometry(false, { left: 0, top: 0, width: 0, height: 0 }) },
		]) {
			const plan = planOpponentExploration({ ...options, ...overrides }, createRng(4));
			expect(plan.actions.every((action) => action.kind === "rest" && !action.path)).toBe(true);
			expect(plan.actions.reduce((sum, action) => sum + action.dwellMs, 0)).toBe(plan.durationMs);
		}
	});

	it("is reproducible and avoids restarting on the previous target", () => {
		const a = planOpponentExploration(options, createRng(7));
		expect(planOpponentExploration(options, createRng(7))).toEqual(a);
		const previousTarget = a.lastTarget!;
		const b = planOpponentExploration({ ...options, previousTarget }, createRng(17));
		expect(b.actions.find((action) => action.square)?.square).not.toBe(previousTarget);
	});
});

describe("opponent-turn attention plan (2026-09-12)", () => {
	const CLASSES: TimeControlClass[] = ["bullet", "blitz", "rapid", "classical"];

	it("gives some turns no pondering at all, at the registry's share by class and quick reply", () => {
		const N = 3000;
		for (const tcClass of CLASSES) {
			let quiet = 0;
			for (let seed = 0; seed < N; seed++) {
				if (!decideOpponentTurn(attention({ tcClass }), {}, createRng(seed)).ponder) quiet++;
			}
			expect(quiet / N).toBeCloseTo(O.attention[tcClass].noPonderProb, 1);
		}
		let quick = 0;
		for (let seed = 0; seed < N; seed++) {
			const ctx = attention({ tcClass: "blitz", opponentClockMs: O.quickReplyClockMs - 1 });
			if (!decideOpponentTurn(ctx, {}, createRng(seed)).ponder) quick++;
		}
		expect(quick / N).toBeCloseTo(O.attention.blitz.noPonderProb + O.noPonderShortBoost, 1);
		// readiness and the legacy caller always ponder
		for (let seed = 0; seed < 200; seed++) {
			expect(decideOpponentTurn(attention(), { lowTime: true }, createRng(seed)).ponder).toBe(true);
			expect(decideOpponentTurn(undefined, {}, createRng(seed)).ponder).toBe(true);
		}
	});

	it("opens with a short first look and then alternates stills with activity, scaled by the time control", () => {
		const meanStill: Record<TimeControlClass, number> = {
			bullet: 0,
			blitz: 0,
			rapid: 0,
			classical: 0,
		};
		for (const tcClass of CLASSES) {
			const A = O.attention[tcClass];
			let stills = 0;
			let stillMs = 0;
			let looked = 0;
			for (let seed = 0; seed < 40; seed++) {
				const plans = turn(`alt:${tcClass}:${seed}`, {}, { tcClass }, 8);
				expect(plans[0]?.spell).toBe("first");
				expect(plans[0]!.durationMs).toBeGreaterThanOrEqual(A.firstLookMs[0]);
				expect(plans[0]!.durationMs).toBeLessThanOrEqual(A.firstLookMs[1]);
				if (movementMs(plans[0]!) > 0) looked++;
				expect(plans[1]?.spell).toBe("still");
				for (let i = 1; i < plans.length; i++) {
					const plan = plans[i]!;
					const previous = plans[i - 1]!;
					// every spell's actions account for exactly its duration
					expect(
						plan.actions.reduce((sum, a) => sum + a.dwellMs + totalMs(a.path ?? []), 0)
					).toBeCloseTo(plan.durationMs, 5);
					// activity never follows activity: a still separates spells
					if (previous.spell !== "still") expect(plan.spell).toBe("still");
					if (plan.spell === "still") {
						stills++;
						stillMs += plan.durationMs;
						expect(plan.durationMs).toBeGreaterThanOrEqual(A.stillMs[0]);
						expect(plan.durationMs).toBeLessThanOrEqual(A.stillMs[1] * (1 + O.decay.stillGrowthMax));
						// a still is stillness: the only movement is the walk to a rest spot (never
						// straight after another still) and the idle tremor
						const walks = plan.actions.filter((a) => a.path && a.kind !== "drift");
						expect(walks.length).toBeLessThanOrEqual(previous.spell === "still" ? 0 : 1);
						for (const drift of plan.actions.filter((a) => a.kind === "drift")) {
							expect(drift.path).toHaveLength(1);
						}
					} else if (plan.spell === "active") {
						expect(plan.durationMs).toBeLessThanOrEqual(A.activeMs[1] * O.phaseActiveScale.sharp);
						expect(movementMs(plan)).toBeGreaterThan(0);
					}
				}
			}
			// a first look nearly always moves; a rare one is just a look (the far piece did not fit)
			expect(looked / 40).toBeGreaterThan(0.85);
			meanStill[tcClass] = stillMs / stills;
		}
		expect(meanStill.bullet).toBeLessThan(meanStill.blitz);
		expect(meanStill.blitz).toBeLessThan(meanStill.rapid);
		expect(meanStill.rapid).toBeLessThan(meanStill.classical);
	});

	it("lets attention decay over a long think: longer stills, activity thinning to a glance", () => {
		const count = (thinkMs: number) => {
			let active = 0;
			let glance = 0;
			let still = 0;
			let stillMs = 0;
			for (let seed = 0; seed < 300; seed++) {
				const plan = planOpponentExploration(
					rich({ previousSpell: "still", attention: attention({ opponentThinkMs: thinkMs }) }),
					createRng(`decay:${thinkMs}:${seed}`)
				);
				if (plan.spell === "active") active++;
				else if (plan.spell === "glance") glance++;
				else {
					still++;
					stillMs += plan.durationMs;
				}
			}
			return { active: active / 300, glance: glance / 300, stillMs: stillMs / Math.max(1, still) };
		};
		const fresh = count(0);
		const decayed = count(O.attention.rapid.decayHalfLifeMs * 6);
		expect(fresh.active).toBeGreaterThan(0.95);
		expect(decayed.active).toBeLessThan(O.decay.activeFloor + 0.08);
		expect(decayed.glance).toBeGreaterThan(0.2);
		expect(decayed.stillMs).toBeGreaterThan(fresh.stillMs * 2);
		// the still that follows a glance is a real still (no walk, only tremor)
		const after = planOpponentExploration(
			rich({ previousSpell: "glance", attention: attention({ opponentThinkMs: 60_000 }) }),
			createRng(1)
		);
		expect(after.spell).toBe("still");
	});

	it("keeps mostly still with a premove or hold armed, and rests only on a no-ponder turn", () => {
		let active = 0;
		for (let seed = 0; seed < 300; seed++) {
			const plan = planOpponentExploration(
				rich({ previousSpell: "still", attention: attention({ armed: true }) }),
				createRng(`armed:${seed}`)
			);
			if (plan.spell === "active") active++;
		}
		expect(active / 300).toBeCloseTo(O.armed.activeProb, 1);
		for (let seed = 0; seed < 100; seed++) {
			const plans = turn(`quiet:${seed}`, { quiet: true }, {}, 4);
			for (const [i, plan] of plans.entries()) {
				expect(plan.spell).toBe("still");
				const walks = plan.actions.filter((a) => a.path && a.kind !== "drift");
				expect(walks.length).toBeLessThanOrEqual(i === 0 ? 1 : 0);
				expect(plan.actions.every((a) => a.activity === "rest")).toBe(true);
			}
		}
	});

	it("reads a line in move order — reply, answer, next — sometimes twice, never as a rank scan", () => {
		const expectedOrders = (RICH.readings ?? []).map((reading) => {
			const flat = reading.steps.flatMap((s) => [s.from, s.to]);
			return dedupe([...flat, ...flat]).join(",");
		});
		let readings = 0;
		let full = 0;
		let rereads = 0;
		const firstLines = new Set<string>();
		for (let seed = 0; seed < 300; seed++) {
			const plans = turn(`read:${seed}`, {}, { phase: "middlegame", sharp: true }, 3);
			for (const plan of plans) {
				// consecutive `line` actions form one reading
				const runs: string[][] = [];
				let run: string[] = [];
				for (const a of plan.actions) {
					if (a.activity === "line" && a.square) run.push(a.square);
					else if (a.kind !== "drift" && run.length > 0) {
						runs.push(run);
						run = [];
					}
				}
				if (run.length > 0) runs.push(run);
				for (const r of runs) {
					readings++;
					// a contiguous slice of one reading's order: the first hover is skipped when the
					// previous spell left the pointer on that very piece, the tail when the spell ran out
					const seq = `,${r.join(",")},`;
					expect(expectedOrders.some((order) => `,${order},`.includes(seq))).toBe(true);
					if (r.length >= 4) full++;
					if (r.length > 6) rereads++;
					if (plan.spell === "first") firstLines.add(r[0]!);
				}
			}
		}
		expect(readings).toBeGreaterThan(300);
		// reply and answer at least in a good share; the third move and a re-read when there is room
		expect(full / readings).toBeGreaterThan(0.25);
		expect(rereads).toBeGreaterThan(0);
		// the first look does not always start on the top line
		expect(firstLines.size).toBeGreaterThan(1);
	});

	it("checks threats, glances at kings and off the board at the registry's rates, never the same square twice in a row", () => {
		let spells = 0;
		let king = 0;
		let offBoard = 0;
		let threat = 0;
		let lastMoveFirst = 0;
		for (let seed = 0; seed < 400; seed++) {
			const plans = turn(`where:${seed}`, {}, { phase: "middlegame" }, 6);
			let previous: string | undefined;
			for (const plan of plans) {
				for (const a of plan.actions) {
					if (a.square) {
						expect(a.square).not.toBe(previous);
						previous = a.square;
					}
					if (a.kind === "offBoard") {
						const p = a.path!.at(-1)!;
						expect(inside(p, BOARD)).toBe(false);
						expect(p.x).toBeGreaterThanOrEqual(0);
						expect(p.y).toBeGreaterThanOrEqual(0);
					}
					if (a.activity === "threat" && a.square) {
						expect(a.square === RICH.lastMove?.to || RICH.threats?.includes(a.square)).toBe(true);
					}
				}
				if (plan.spell !== "active" && plan.spell !== "first") continue;
				spells++;
				if (plan.actions.some((a) => a.activity === "king")) king++;
				if (plan.actions.some((a) => a.activity === "offBoard")) offBoard++;
				const threats = plan.actions.filter((a) => a.activity === "threat");
				if (threats.length > 0) threat++;
				if (threats[0]?.square === RICH.lastMove?.to) lastMoveFirst++;
			}
		}
		expect(king / spells).toBeGreaterThan(O.kingGlanceProb);
		expect(king / spells).toBeLessThan(0.5);
		expect(offBoard / spells).toBeGreaterThan(O.offBoardGlanceProb / 2);
		expect(offBoard / spells).toBeLessThan(0.3);
		// at least the registry's own chance that a spell *opens* with a threat check (second-slot
		// checks come on top of it)
		const W = O.activityWeights;
		const opensWithThreat =
			W.threat / (W.line * O.firstLookLineScale + W.threat + W.candidates + W.king + W.offBoard);
		expect(threat / spells).toBeGreaterThan(opensWithThreat);
		expect(lastMoveFirst).toBeGreaterThan(0);
	});

	it("rests on a centre-weighted piece or just off the edge, never on the square we mean to move to", () => {
		let walks = 0;
		let offEdge = 0;
		for (let seed = 0; seed < 400; seed++) {
			const plan = planOpponentExploration(
				rich({ previousSpell: "active", attention: attention({ intendedTo: "e4" }) }),
				createRng(`rest:${seed}`)
			);
			expect(plan.spell).toBe("still");
			const walk = plan.actions.find((a) => a.path && a.kind !== "drift");
			if (!walk) continue;
			walks++;
			expect(walk.activity).toBe("rest");
			if (walk.kind === "offBoard") {
				offEdge++;
				continue;
			}
			expect(walk.square).not.toBe("e4");
			expect(RICH.pieces?.some((p) => p.square === walk.square)).toBe(true);
		}
		expect(walks / 400).toBeCloseTo(O.restMoveProb, 1);
		expect(offEdge / walks).toBeCloseTo(1 - O.restPieceProb, 1);
	});

	it("keeps every dispatched point within the hand's maximum step and its own square, with a slower re-orientation", () => {
		const speeds = { first: [] as number[], reorient: [] as number[] };
		for (let seed = 0; seed < 300; seed++) {
			for (const previousSpell of [undefined, "still"] as const) {
				const plan = planOpponentExploration(
					rich({
						...(previousSpell ? { previousSpell } : {}),
						attention: attention({ opponentThinkMs: 3000 }),
					}),
					createRng(`step:${seed}`)
				);
				// a decayed attention may answer a still with a glance or another still
				if (plan.spell !== "active" && plan.spell !== "first") continue;
				let prev = { x: 700, y: 690 };
				let length = 0;
				let firstLength = 0;
				const first = plan.actions.find((a) => a.path && a.kind !== "drift");
				for (const a of plan.actions) {
					for (const p of a.path ?? []) {
						const step = dist(prev, p);
						expect(step).toBeLessThanOrEqual(TELEMETRY_BANDS.pointer.maxStepPx);
						length += step;
						if (a === first) firstLength += step;
						prev = p;
					}
					if (a.square && a.path) expect(inside(a.path.at(-1)!, squareRect(a.square))).toBe(true);
				}
				expect(length).toBeGreaterThan(0);
				if (!first?.path) continue;
				speeds[previousSpell ? "reorient" : "first"].push(firstLength / totalMs(first.path));
			}
		}
		const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
		// both spells start their first movement from the same rest point with the same profile;
		// the one after a still is re-orienting, `reorientSpeedScale` slower
		expect(speeds.first.length).toBeGreaterThan(200);
		expect(speeds.reorient.length).toBeGreaterThan(200);
		expect(mean(speeds.reorient)).toBeLessThan(mean(speeds.first) * 0.92);
	});
});

function dedupe(items: string[]): string[] {
	return items.filter((item, i) => i === 0 || item !== items[i - 1]);
}
