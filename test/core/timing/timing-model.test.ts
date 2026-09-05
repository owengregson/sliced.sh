// test/core/timing/timing-model.test.ts — Step 4 + §8.4b V2.1 TimingModel properties.
import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { computeFeatures } from "@core/timing/features";
import { windowTotalMs } from "@core/timing/move-window";
import { freshState, isBotPace, needsResample, TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingLogEntry } from "@core/timing/types";
import { mirrorTerm, V1ParametricHead } from "@core/timing/v1-head";
import { AFTER_EXD5, ctx, line, pearson } from "./helpers";

const meta: GameMeta = {
	targetElo: 1650,
	profile: "balanced",
	baseSec: 180,
	incSec: 0,
	site: "lichess",
	gameId: "game-A",
};

function model(over: Partial<typeof DEFAULT_SETTINGS.timing> = {}, seed: string | number = "rng") {
	const entries: TimingLogEntry[] = [];
	const m = new TimingModel(
		new V1ParametricHead(),
		{ ...DEFAULT_SETTINGS.timing, ...over },
		createRng(seed),
		{ onEntry: (e) => entries.push(e) }
	);
	return { m, entries };
}

describe("TimingModel.planMove", () => {
	it("thinkMs ≥ dragDurationMs, deadline = now + thinkMs, window sums to thinkMs, orientation present", () => {
		const { m, entries } = model();
		m.startGame(meta);
		for (let i = 0; i < 300; i++) {
			const c = ctx({ nowMs: 5_000 + i });
			const plan = m.planMove(c);
			expect(plan.thinkMs).toBeGreaterThanOrEqual(plan.dragDurationMs);
			expect(plan.deadlineMs).toBeCloseTo(c.nowMs + plan.thinkMs, 6);
			expect(windowTotalMs(plan.window)).toBeCloseTo(plan.thinkMs, 6);
			expect(plan.preMoveHoverMs).toBeGreaterThanOrEqual(0);
			if (plan.mode !== "premove") {
				expect(plan.orientationMs).toBeGreaterThanOrEqual(150);
				expect(plan.window.orientationMs).toBe(plan.orientationMs);
			}
			if (plan.mode === "normal" || plan.mode === "long") {
				expect(plan.thinkMs).toBeGreaterThanOrEqual(250);
				const rest = plan.thinkMs - plan.window.orientationMs - plan.window.approachMs;
				if (rest > 0) {
					expect(plan.window.decisionMs / rest).toBeGreaterThanOrEqual(0.15 - 1e-9);
					expect(plan.window.decisionMs / rest).toBeLessThanOrEqual(0.4 + 1e-9);
				}
			}
			expect(plan.features.alloc).toBeGreaterThan(0);
			expect(typeof plan.features.comp).toBe("number");
		}
		expect(entries.length).toBe(300);
		expect(entries[0]?.persona).toBe("balanced");
		expect(entries[0]?.gameId).toBe("game-A");
	});
	it("speedScale multiplies the sampled think time", () => {
		const a = model({ speedScale: 1 }, 7);
		const b = model({ speedScale: 2 }, 7);
		a.m.startGame(meta);
		b.m.startGame(meta);
		let compared = 0;
		for (let i = 0; i < 50; i++) {
			const pa = a.m.planMove(ctx({ myClockMs: 170_000, oppClockMs: 170_000 }));
			const pb = b.m.planMove(ctx({ myClockMs: 170_000, oppClockMs: 170_000 }));
			if (pa.mode === "normal" && pb.mode === "normal" && pa.thinkMs > 2000) {
				expect(pb.thinkMs).toBeCloseTo(2 * pa.thinkMs, 3);
				compared++;
			}
		}
		expect(compared).toBeGreaterThan(5);
	});
	it("respectBudget=false uses the clock-free schedule", () => {
		const { m } = model({ respectBudget: false });
		m.startGame(meta);
		const plan = m.planMove(ctx({ myClockMs: 20_000 }));
		expect(plan.features.alloc).toBeCloseTo(180 / 40, 10);
	});
	it("untimed games skip pressure and caps and condition as classical", () => {
		const { m } = model();
		m.startGame({ ...meta, baseSec: 0, incSec: 0, site: "chesscom" });
		const plan = m.planMove(ctx({ baseSec: 0, incSec: 0, myClockMs: 0, oppClockMs: 0 }));
		expect(plan.features.tc_untimed).toBe(1);
		expect(plan.features.comp).toBe(1);
		expect(plan.features.alloc).toBeCloseTo(300 / 40, 10);
	});
	it("untimed v1 tempo vs a bot is realistic on its own: q50 4–8 s, q90 ≤ 30 s (N = 3 000)", () => {
		const { m } = model({}, "untimed-band");
		const ts: number[] = [];
		for (let i = 0; i < 3000; i++) {
			if (i % 40 === 0)
				m.startGame({ ...meta, gameId: `bot-${i}`, baseSec: 0, incSec: 0, site: "chesscom" });
			const p = m.planMove(
				ctx({
					baseSec: 0,
					incSec: 0,
					myClockMs: 0,
					oppClockMs: 0,
					site: "chesscom",
					oppThinkMsHistory: [400, 450, 420, 380],
				})
			);
			ts.push(p.thinkMs / 1000);
		}
		const sorted = [...ts].sort((a, b) => a - b);
		const q = (p: number) => sorted[Math.floor(p * sorted.length)] ?? 0;
		expect(q(0.5)).toBeGreaterThanOrEqual(4);
		expect(q(0.5)).toBeLessThanOrEqual(8);
		expect(q(0.9)).toBeLessThanOrEqual(30);
		{
			let best = 0;
			let lo = 0;
			for (let hi = 0; hi < sorted.length; hi++) {
				while ((sorted[hi] ?? 0) - (sorted[lo] ?? 0) > 0.002) lo++;
				best = Math.max(best, hi - lo + 1);
			}
			expect(best / ts.length).toBeLessThan(0.1);
		}
	});
	it("probe: 3+0 with 8 s left — no mass point, q90 ≤ 0.15·C (N = 6 000)", () => {
		const { m } = model({}, "probe-8s");
		const ts: number[] = [];
		for (let i = 0; i < 6000; i++) {
			if (i % 40 === 0) m.startGame({ ...meta, gameId: `p8-${i}` });
			const p = m.planMove(ctx({ myClockMs: 8_000, oppClockMs: 30_000, ply: 60 }));
			expect(p.mode).not.toBe("premove");
			expect(p.orientationMs).toBeGreaterThanOrEqual(150);
			ts.push(p.thinkMs);
		}
		const sorted = [...ts].sort((a, b) => a - b);
		const q90 = sorted[Math.floor(0.9 * sorted.length)] ?? 0;
		expect(q90).toBeLessThanOrEqual(0.15 * 8_000 + 1e-6);
		// Largest cluster of plans within ±1 ms of a single value.
		let best = 0;
		let lo = 0;
		for (let hi = 0; hi < sorted.length; hi++) {
			while ((sorted[hi] ?? 0) - (sorted[lo] ?? 0) > 2) lo++;
			best = Math.max(best, hi - lo + 1);
		}
		expect(best / ts.length).toBeLessThan(0.1);
		expect(sorted[0] ?? 0).toBeGreaterThanOrEqual(250);
	});
	it("probe: 3+0 with 120 s left — one seeded persona reproduces the head bands (N = 6 000)", () => {
		const { m } = model({}, "probe-120s");
		m.startGame(meta);
		const ts: number[] = [];
		let instant = 0;
		for (let i = 0; i < 6000; i++) {
			const p = m.planMove(ctx());
			if (p.mode === "instant") instant++;
			ts.push(p.thinkMs / 1000);
		}
		const sorted = [...ts].sort((a, b) => a - b);
		const q50 = sorted[Math.floor(0.5 * sorted.length)] ?? 0;
		expect(q50).toBeGreaterThan(2);
		expect(q50).toBeLessThan(4);
		const tail = ts.filter((t) => t > 15).length / ts.length;
		expect(tail).toBeGreaterThan(0.01);
		expect(tail).toBeLessThan(0.06);
		expect(instant / ts.length).toBeGreaterThan(0.05);
		expect(instant / ts.length).toBeLessThan(0.2);
		{
			let best = 0;
			let lo = 0;
			for (let hi = 0; hi < sorted.length; hi++) {
				while ((sorted[hi] ?? 0) - (sorted[lo] ?? 0) > 0.002) lo++;
				best = Math.max(best, hi - lo + 1);
			}
			expect(best / ts.length).toBeLessThan(0.1);
		}
	});
	it("premove on chess.com carries the site's fixed 0.1 s", () => {
		const { m } = model({ premoveTendency: 1 });
		m.startGame({ ...meta, site: "chesscom" });
		const c = ctx({
			site: "chesscom",
			fen: AFTER_EXD5,
			myColor: "b",
			ply: 3,
			moves: ["e2e4", "d7d5", "e4d5"],
			expectedOppReply: "e4d5",
			chosenMove: "d8d5",
			lines: [line(1, -10, "d8d5"), line(2, -60, "g8f6")],
		});
		let seen = 0;
		for (let i = 0; i < 100; i++) {
			const p = m.planMove(c);
			if (p.mode === "premove") {
				seen++;
				expect(p.thinkMs).toBeGreaterThanOrEqual(100);
				expect(p.thinkMs).toBeLessThanOrEqual(220);
				expect(p.preMoveHoverMs).toBe(0);
				expect(p.window.approachMs).toBe(p.thinkMs);
			}
		}
		expect(seen).toBeGreaterThan(50);
	});
	it("bot-pace floor: the mirror term keeps the median ≥ 0.6× the model median, without a mass point", () => {
		expect(isBotPace([400, 450, 420, 380])).toBe(true);
		expect(isBotPace([3000, 400, 9000])).toBe(false);
		expect(isBotPace([400])).toBe(false);
		const head = new V1ParametricHead();
		const bot = ctx({ oppThinkMsHistory: [400, 450, 420, 380] });
		const fb = computeFeatures(bot);
		expect(fb.opp_is_bot).toBe(1);
		expect(fb.opp_pace).toBeLessThan(-1);
		const persona = { s_game: 0, iota: 0.5, pi_p: 0, tau: 0.65, rho_mirror: 0.3, motor_k: 1 };
		// ρ·opp_pace = −0.6 would undercut ln 0.6 = −0.51: the coefficient is floored there.
		expect(mirrorTerm({ opp_pace: -2, opp_is_bot: 1 }, persona)).toBeCloseTo(Math.log(0.6), 10);
		expect(mirrorTerm({ opp_pace: -2, opp_is_bot: 0 }, persona)).toBeCloseTo(-0.6, 10);
		expect(mirrorTerm({ opp_pace: -1, opp_is_bot: 1 }, persona)).toBeCloseTo(-0.3, 10);
		const { m } = model({}, "bot-floor");
		m.startGame(meta);
		const ts: number[] = [];
		for (let i = 0; i < 1000; i++) {
			const plan = m.planMove(bot);
			if (plan.mode === "normal") ts.push(plan.thinkMs / 1000);
		}
		const sorted = [...ts].sort((a, b) => a - b);
		const q50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
		const alloc = m.state.lastPlan?.features.alloc ?? 0;
		const modelMedian = head.median({ ...fb, opp_is_bot: 0, opp_pace: 0 }, m.persona, m.state, alloc);
		expect(q50).toBeGreaterThanOrEqual(0.6 * modelMedian);
		let best = 0;
		let lo = 0;
		for (let hi = 0; hi < sorted.length; hi++) {
			while ((sorted[hi] ?? 0) - (sorted[lo] ?? 0) > 0.002) lo++;
			best = Math.max(best, hi - lo + 1);
		}
		expect(best / sorted.length).toBeLessThan(0.1);
	});
	it("CV guard: re-sample when the per-game CV would stay below 0.5 after 12 moves", () => {
		const flat = new Array<number>(12).fill(3000);
		expect(needsResample(flat, 3000)).toBe(true);
		expect(needsResample(flat.slice(0, 5), 3000)).toBe(false);
		expect(
			needsResample([200, 6000, 300, 9000, 250, 4000, 500, 12_000, 300, 700, 8000, 350], 2000)
		).toBe(false);
	});
});

describe("TimingModel.replan / observe", () => {
	it("manual-now zeroes the hover wait and keeps the drag", () => {
		const { m } = model();
		m.startGame(meta);
		const c = ctx();
		const plan = m.planMove(c);
		const now = c.nowMs + 700;
		const r = m.replan(plan, { ...c, nowMs: now }, "manual-now");
		expect(r.preMoveHoverMs).toBe(0);
		expect(r.dragDurationMs).toBe(plan.dragDurationMs);
		expect(r.thinkMs).toBeCloseTo(700 + r.window.approachMs, 6);
		expect(r.deadlineMs).toBeCloseTo(now + r.window.approachMs, 6);
		expect(r.window.approachMs).toBeGreaterThanOrEqual(plan.dragDurationMs);
		expect(r.rationale.some((s) => s.includes("manual"))).toBe(true);
	});
	it("clock-jump truncates the remaining wait to the caps", () => {
		const { m } = model();
		m.startGame(meta);
		const c = ctx();
		let plan = m.planMove(c);
		for (let i = 0; i < 50 && plan.thinkMs < 3000; i++) plan = m.planMove(c);
		expect(plan.thinkMs).toBeGreaterThanOrEqual(3000);
		const jumped = { ...c, myClockMs: 8_000, nowMs: c.nowMs + 200 };
		const r = m.replan(plan, jumped, "clock-jump");
		expect(r.thinkMs).toBeLessThanOrEqual(Math.max(200 + r.window.approachMs, 0.15 * 8_000) + 1e-6);
		expect(r.deadlineMs).toBeCloseTo(jumped.nowMs + r.thinkMs - 200, 6);
	});
	it("emergency (< 1.5 s) removes every wait and uses the minimal motor", () => {
		const { m } = model();
		m.startGame(meta);
		const c = ctx();
		const plan = m.planMove(c);
		const r = m.replan(plan, { ...c, myClockMs: 1_000, nowMs: c.nowMs + 100 }, "emergency");
		expect(r.preMoveHoverMs).toBe(0);
		expect(r.dragDurationMs).toBe(60);
		expect(r.promotionDelayMs ?? 0).toBe(0);
		expect(r.fakeout).toBeUndefined();
		expect(r.thinkMs).toBe(160);
	});
	it("blur cancels the move and observes the elapsed time", () => {
		const { m, entries } = model();
		m.startGame(meta);
		const c = ctx();
		const plan = m.planMove(c);
		const r = m.replan(plan, { ...c, nowMs: c.nowMs + 900 }, "blur");
		expect(r.thinkMs).toBe(900);
		expect(r.deadlineMs).toBe(c.nowMs + 900);
		expect(r.dragDurationMs).toBe(0);
		expect(r.rationale.some((s) => s.includes("blur"))).toBe(true);
		expect(m.state.myThinkMs).toEqual([900]);
		expect(entries[0]?.actualMs).toBe(900);
	});
	it("engine-not-ready extends by the motor time; engine-changed re-samples with the same ε", () => {
		const { m } = model();
		m.startGame(meta);
		const c = ctx();
		const plan = m.planMove(c);
		const eps = m.state.eps;
		const late = m.replan(plan, { ...c, nowMs: plan.deadlineMs + 50 }, "engine-not-ready");
		expect(late.thinkMs).toBeGreaterThanOrEqual(plan.thinkMs + 50);
		const changed = m.replan(
			plan,
			{ ...c, chosenMove: "a2a4", nowMs: c.nowMs + 300 },
			"engine-changed"
		);
		expect(m.state.eps).toBe(eps);
		expect(changed.thinkMs).toBeGreaterThanOrEqual(300 + changed.dragDurationMs);
		expect(changed.rationale.some((s) => s.includes("chosen move changed"))).toBe(true);
	});
	it("opponent-moved: a matching reply fires the premove, otherwise a fresh plan without ponder_hit", () => {
		const { m } = model({ premoveTendency: 1 });
		m.startGame(meta);
		const c = ctx({
			fen: AFTER_EXD5,
			myColor: "b",
			ply: 3,
			moves: ["e2e4", "d7d5", "e4d5"],
			expectedOppReply: "e4d5",
			chosenMove: "d8d5",
			lines: [line(1, -10, "d8d5"), line(2, -60, "g8f6")],
		});
		let plan = m.planMove(c);
		for (let i = 0; i < 100 && plan.mode !== "premove"; i++) plan = m.planMove(c);
		expect(plan.mode).toBe("premove");
		const fired = m.replan(plan, { ...c, nowMs: c.nowMs + 40 }, "opponent-moved");
		expect(fired.mode).toBe("premove");
		expect(fired.thinkMs).toBeLessThanOrEqual(40 + 120);
		const other = m.replan(
			plan,
			{ ...c, moves: ["e2e4", "d7d5", "b1c3"], nowMs: c.nowMs + 40 },
			"opponent-moved"
		);
		expect(other.features.ponder_hit).toBe(0);
		expect(other.mode).not.toBe("premove");
	});
	it("observe shifts ε toward the realised value and fills the log", () => {
		const { m, entries } = model();
		m.startGame(meta);
		const c = ctx();
		let plan = m.planMove(c);
		for (let i = 0; i < 50 && plan.mode !== "normal"; i++) plan = m.planMove(c);
		const before = m.state.eps;
		m.observe(plan.thinkMs * 2, plan);
		expect(m.state.eps).toBeCloseTo(before + Math.log(2), 6);
		expect(entries[entries.length - 1]?.actualMs).toBe(plan.thinkMs * 2);
		expect(m.state.myThinkMs[m.state.myThinkMs.length - 1]).toBe(plan.thinkMs * 2);
		expect(m.state.paceResiduals.length).toBe(1);
		m.observe(plan.thinkMs, plan);
		expect(m.state.eps).toBeCloseTo(before + Math.log(2), 6);
	});
});

describe("game independence (§8.4b item 4)", () => {
	it("persona is a pure function of the per-game seed", () => {
		const a = model({}, 1);
		const b = model({}, 2);
		a.m.startGame(meta);
		b.m.startGame(meta);
		expect(a.m.persona).toEqual(b.m.persona);
		a.m.startGame({ ...meta, gameId: "other" });
		expect(a.m.persona).not.toEqual(b.m.persona);
	});
	it("startGame discards all state: a model that played 40 moves equals a fresh one", () => {
		const played = model({}, 3);
		played.m.startGame(meta);
		for (let i = 0; i < 40; i++) {
			const p = played.m.planMove(ctx({ ply: 20 + i, oppThinkMsHistory: [1000, 2000, 500] }));
			played.m.observe(p.thinkMs * 1.3, p);
		}
		played.m.startGame({ ...meta, gameId: "game-B" });
		const fresh = model({}, 4);
		fresh.m.startGame({ ...meta, gameId: "game-B" });
		expect(played.m.state).toEqual(fresh.m.state);
		expect(played.m.state).toEqual(freshState("game-B"));
		expect(played.m.persona).toEqual(fresh.m.persona);
	});
	it("residual sequences of games with different seeds are uncorrelated (|r| < 0.05 over 1 000 pairs)", () => {
		const head = new V1ParametricHead();
		const f = computeFeatures(ctx());
		const persona = { s_game: 0, iota: 0.5, pi_p: 0, tau: 0.65, rho_mirror: 0.15, motor_k: 1 };
		const xs: number[] = [];
		const ys: number[] = [];
		for (let pair = 0; pair < 1000; pair++) {
			const sa = freshState("a");
			const sb = freshState("b");
			const ra = createRng(`pair-${pair}-a`);
			const rb = createRng(`pair-${pair}-b`);
			for (let k = 0; k < 12; k++) {
				head.sample(f, persona, sa, ra, 3);
				head.sample(f, persona, sb, rb, 3);
				xs.push(sa.eps);
				ys.push(sb.eps);
			}
		}
		expect(Math.abs(pearson(xs, ys))).toBeLessThan(0.05);
	});
});
