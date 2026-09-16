import { describe, expect, it } from "bun:test";
import { MOTOR_DEFAULTS, PREVIEW } from "@core/motor/constants";
import { actionEnd, ExplorationPlanner, planDurationMs } from "@core/motor/exploration";
import type { OpponentAttentionContext } from "@core/motor/opponent-candidates";
import { planOpponentExploration } from "@core/motor/opponent-exploration";
import { planPreview, previewProbability } from "@core/motor/preview-select";
import {
	chooseRepertoire,
	type MotorRepertoireContext,
	type RepertoireIntent,
	type RepertoireState,
	repertoireRoute,
} from "@core/motor/repertoire";
import type { MoveCandidate } from "@core/motor/types";
import { createRng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { dist, geometry, inside, squareRect, totalMs } from "./fixtures";

const context: MotorRepertoireContext = {
	targetElo: 1600,
	phase: "middlegame",
	persona: "balanced",
};
const room = { budgetMs: 9000, myClockMs: 60000, candidates: 3 };
const candidates: MoveCandidate[] = [
	{ from: "e2", to: "e4", uci: "e2e4", probability: 0.6 },
	{ from: "g1", to: "f3", uci: "g1f3", probability: 0.3 },
	{ from: "d2", to: "d4", uci: "d2d4", probability: 0.1 },
];
const cursor = { x: 420, y: 680 };
const dests = (sq: Square) => candidates.filter((c) => c.from === sq).map((c) => c.to);
const attention = (over: Partial<OpponentAttentionContext> = {}): OpponentAttentionContext => ({
	tcClass: "rapid",
	myClockMs: 60000,
	opponentClockMs: 60000,
	opponentThinkMs: 0,
	phase: "middlegame",
	sharp: false,
	armed: false,
	repertoire: context,
	...over,
});
const options = {
	geometry: geometry(),
	profile: MOTOR_DEFAULTS,
	cursor,
	ownCandidates: candidates,
	opponentCandidates: [{ from: "e7" as Square, to: "e5" as Square, uci: "e7e5", probability: 1 }],
	attention: attention(),
};
const ownOptions = {
	thinkMs: 9000,
	mode: "normal" as const,
	nReasonable: 3,
	myClockMs: 60000,
	persona: "balanced" as const,
	previewScale: 1,
	committed: { from: "e2" as Square, to: "e4" as Square },
	legalDestinations: dests,
	cursor,
	repertoire: context,
};

describe("purposeful repertoire policy", () => {
	it("retains a purpose across bouts but interrupts it for urgency and changed context", () => {
		const first = chooseRepertoire(context, undefined, room, createRng(2));
		expect(first.boutsLeft).toBeGreaterThan(0);
		const next = chooseRepertoire(context, first, room, createRng(100));
		expect(next.intent).toBe(first.intent);
		expect(next.boutsLeft).toBe(first.boutsLeft - 1);
		const urgent = chooseRepertoire({ ...context, premovePending: true }, next, room, createRng(3));
		expect(urgent.intent).toBe("still");
		expect(urgent.boutsLeft).toBe(0);
		expect(chooseRepertoire({ ...context, forced: true }, first, room, createRng(4)).intent).toBe(
			"prepare"
		);
		const changed = chooseRepertoire({ ...context, inCheck: true }, first, room, createRng(5));
		expect(changed.contextKey).not.toBe(first.contextKey);
	});

	it("uses Elo as a modest preference, and sharpness/persona as independent context", () => {
		const counts = (ctx: MotorRepertoireContext) => {
			const out: Record<RepertoireIntent, number> = {
				still: 0,
				prepare: 0,
				inspect: 0,
				compare: 0,
				verify: 0,
				relate: 0,
			};
			for (let seed = 0; seed < 4000; seed++)
				out[chooseRepertoire(ctx, undefined, room, createRng(seed)).intent]++;
			return out;
		};
		const novice = counts({ ...context, targetElo: 800 });
		const expert = counts({ ...context, targetElo: 2800 });
		expect(expert.relate).toBeGreaterThan(novice.relate * 1.5);
		expect(novice.inspect + novice.compare).toBeGreaterThan(expert.inspect + expert.compare);
		for (const value of Object.values(expert)) expect(value).toBeGreaterThan(100);
		const sharp = counts({ ...context, sharp: true });
		const quiet = counts(context);
		expect(sharp.verify).toBeGreaterThan(quiet.verify * 1.5);
		expect(counts({ ...context, persona: "cautious" }).verify).toBeGreaterThan(quiet.verify);
		expect(counts({ ...context, phase: "opening" }).prepare).toBeGreaterThan(quiet.prepare);
	});

	it("never invents comparison candidates; handles invalid probabilities and absent candidates", () => {
		for (const intent of ["prepare", "inspect", "compare", "verify", "relate"] as const) {
			expect(repertoireRoute(intent, [], createRng(1))).toEqual([]);
			const route = repertoireRoute(
				intent,
				candidates.map((c) => ({ ...c, probability: Number.NaN })),
				createRng(1)
			);
			expect(route.length).toBeGreaterThan(0);
		}
		const route = repertoireRoute("compare", candidates, createRng(3));
		expect(route).toHaveLength(5);
		expect(route.at(-1)).toEqual(route[0]);
		expect(route[0]).not.toEqual(route[2]);
	});
});

describe("repertoire planner integration", () => {
	it("admits deliberate previews at their own rate with zero hover appetite and reserves the entire gesture", () => {
		const profile = {
			...MOTOR_DEFAULTS,
			exploration: { ...MOTOR_DEFAULTS.exploration, hoverProb: 0 },
		};
		const opts = { ...ownOptions, thinkMs: 4000 };
		const planner = new ExplorationPlanner();
		let previews = 0;
		const runs = 1600;
		for (let seed = 0; seed < runs; seed++) {
			const plan = planner.plan(
				9000,
				candidates,
				geometry(),
				profile,
				createRng(`preview-intent:${seed}`),
				opts
			);
			const selected = plan.filter((a) => a.kind === "preview");
			expect(selected.length).toBeLessThanOrEqual(1);
			if (selected.length > 0) {
				previews++;
				expect(plan.map((a) => a.kind)).toEqual(["rest", "preview", "rest"]);
				expect(plan[1]?.preview?.approach).toEqual(plan[1]?.path);
			}
			expect(planDurationMs(plan)).toBeLessThanOrEqual(9000 - MOTOR_DEFAULTS.reactionMs[0] + 1e-7);
		}
		const probability = previewProbability({ ...opts, previewBase: profile.exploration.previewBase });
		expect(Math.abs(previews / runs - probability)).toBeLessThan(0.025);
	});

	it("independent preview admission cannot bypass forced moves, preview-off, or the preview clock floor", () => {
		for (const overrides of [
			{ repertoire: { ...context, forced: true } },
			{ previewScale: 0 },
			{ myClockMs: PREVIEW.clockFloorMs - 1 },
		]) {
			for (let seed = 0; seed < 200; seed++) {
				const actions = new ExplorationPlanner().plan(
					9000,
					candidates,
					geometry(),
					MOTOR_DEFAULTS,
					createRng(seed),
					{ ...ownOptions, previewScale: 100, ...overrides }
				);
				expect(actions.some((a) => a.kind === "preview")).toBe(false);
			}
		}
	});

	it("rests with optional hovering disabled and the independent preview control off", () => {
		const profile = {
			...MOTOR_DEFAULTS,
			exploration: { ...MOTOR_DEFAULTS.exploration, hoverProb: 0 },
		};
		for (let seed = 0; seed < 50; seed++) {
			const plan = new ExplorationPlanner().plan(
				9000,
				candidates,
				geometry(),
				profile,
				createRng(seed),
				{ ...ownOptions, previewScale: 0 }
			);
			expect(plan.every((a) => a.kind === "rest" && !a.path)).toBe(true);
		}
	});
	it("keeps opponent bouts within tiny, ordinary and malformed budgets for every spell", () => {
		for (const maxMs of [0, 1, 50, 300, 999, 1000, 2000, 9000, -10, Number.NaN]) {
			for (const previousSpell of [undefined, "active", "still", "glance"] as const) {
				for (let seed = 0; seed < 30; seed++) {
					const plan = planOpponentExploration(
						{ ...options, maxMs, ...(previousSpell ? { previousSpell } : {}) },
						createRng(seed)
					);
					const total = plan.actions.reduce((sum, a) => sum + totalMs(a.path ?? []) + a.dwellMs, 0);
					expect(total).toBeCloseTo(plan.durationMs, 7);
					expect(total).toBeLessThanOrEqual((Number.isFinite(maxMs) ? Math.max(0, maxMs) : 0) + 1e-7);
					for (const action of plan.actions) expect(action.dwellMs).toBeGreaterThanOrEqual(0);
				}
			}
		}
	});

	it("leaves the pointer completely alone for queued/held moves, low clocks and short windows", () => {
		for (let seed = 0; seed < 50; seed++) {
			for (const ctx of [
				attention({ armed: true }),
				attention({ repertoire: { ...context, premovePending: true } }),
				attention({ myClockMs: 7999 }),
			]) {
				for (const previousSpell of ["active", "still", "glance"] as const) {
					const plan = planOpponentExploration(
						{ ...options, attention: ctx, previousSpell },
						createRng(seed)
					);
					expect(plan.actions.every((a) => a.kind === "rest" && !a.path)).toBe(true);
				}
			}
			for (const overrides of [
				{ repertoire: { ...context, premovePending: true } },
				{ myClockMs: 7999 },
				{ mode: "premove" as const },
				{ mode: "instant" as const },
			]) {
				const plan = new ExplorationPlanner().plan(
					9000,
					candidates,
					geometry(),
					MOTOR_DEFAULTS,
					createRng(seed),
					{ ...ownOptions, ...overrides }
				);
				expect(plan.every((a) => a.kind === "rest" && !a.path)).toBe(true);
			}
		}
	});

	it("uses distinct routes, carries opponent purpose through stills, and resets own-game state", () => {
		const observed = new Set<RepertoireIntent>();
		let state: RepertoireState | undefined;
		for (let seed = 0; seed < 100; seed++) {
			const plan = planOpponentExploration(
				{ ...options, ...(state ? { repertoireState: state } : {}) },
				createRng(seed)
			);
			state = plan.repertoireState;
			if (state) observed.add(state.intent);
			const still = planOpponentExploration(
				{ ...options, previousSpell: "active", ...(state ? { repertoireState: state } : {}) },
				createRng(seed)
			);
			expect(still.repertoireState).toEqual(state);
		}
		expect(observed.size).toBe(6);
		const planner = new ExplorationPlanner();
		const initial = planner.plan(
			9000,
			candidates,
			geometry(),
			MOTOR_DEFAULTS,
			createRng(8),
			ownOptions
		);
		planner.plan(9000, candidates, geometry(), MOTOR_DEFAULTS, createRng(9), ownOptions);
		planner.reset();
		expect(
			planner.plan(9000, candidates, geometry(), MOTOR_DEFAULTS, createRng(8), ownOptions)
		).toEqual(initial);
	});

	it("preserves continuous own-turn paths and never extends the allotted window", () => {
		let motion = 0;
		for (const flipped of [false, true]) {
			for (let seed = 0; seed < 200; seed++) {
				const wait = [0, 300, 900, 2000, 9000][seed % 5]!;
				const actions = new ExplorationPlanner().plan(
					wait,
					candidates,
					geometry(flipped),
					MOTOR_DEFAULTS,
					createRng(seed),
					ownOptions
				);
				expect(planDurationMs(actions)).toBeLessThanOrEqual(
					Math.max(0, wait - MOTOR_DEFAULTS.reactionMs[0]) + 1e-7
				);
				let from = cursor;
				for (const action of actions) {
					for (const p of action.path ?? []) {
						expect(dist(from, p)).toBeLessThanOrEqual(
							(MOTOR_DEFAULTS.peakSpeedCapPxPerS * p.dtMs) / 1000 + 1
						);
						expect(p.dtMs).toBeGreaterThan(0);
						from = p;
						motion++;
					}
					from = actionEnd(action, from);
				}
			}
		}
		expect(motion).toBeGreaterThan(1000);
	});

	it("slows preview takebacks within the existing budget and returns on the origin", () => {
		let drags = 0;
		for (let seed = 0; seed < 80; seed++) {
			const input = {
				cursor,
				candidates,
				committed: ownOptions.committed,
				geometry: geometry(),
				legalDestinations: dests,
				profile: { ...MOTOR_DEFAULTS, hesitationProb: 0 },
				maxMs: 9000,
			};
			const preview = planPreview(input, createRng(seed));
			if (preview?.style !== "drag") continue;
			drags++;
			expect(inside(preview.release, squareRect(preview.piece))).toBe(true);
			for (const point of preview.dragPath ?? []) {
				// The controller can abort and release at ANY dispatched held point.
				expect(inside(point, squareRect(preview.piece), PREVIEW.dragBoundaryPadPx)).toBe(true);
			}
			expect(preview.dragPath?.some((p) => p.dtMs >= PREVIEW.dragReconsiderMs[0])).toBe(true);
			const duration = totalMs(preview.approach) + preview.totalAfterApproachMs;
			expect(duration).toBeLessThanOrEqual(input.maxMs);
			const tooShort = duration - preview.dwellMs + PREVIEW.dwellMs[0] - 1;
			expect(planPreview({ ...input, maxMs: tooShort }, createRng(seed))).toBeNull();
		}
		expect(drags).toBeGreaterThan(10);
	});
});
