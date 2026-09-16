// test/service/game-session/ponder.test.ts — Task 30: one `go infinite` at a time (§6.4,
// Appendix E §4.2), the expected reply it yields and the cap.
import { describe, expect, it } from "bun:test";
import { applyMoves } from "@core/chess/san";
import { SEARCH_BUDGET } from "@core/constants/search";
import { TIMINGS } from "@core/constants/timings";
import { automaticDepthForElo } from "@core/engine/depth-policy";
import type {
	AnalysisHandle,
	AnalysisRequest,
	AnalysisResult,
	AnalysisUpdate,
} from "@core/engine/types";
import { PonderController } from "@service/game-session/ponder";

const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

interface Timer {
	fn: () => void;
	ms: number;
	cleared: boolean;
}

function fakeScheduler(): {
	scheduler: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
	timers: Timer[];
} {
	const timers: Timer[] = [];
	return {
		timers,
		scheduler: {
			setTimeout(fn, ms) {
				const t: Timer = { fn, ms, cleared: false };
				timers.push(t);
				return t;
			},
			clearTimeout(handle) {
				(handle as Timer).cleared = true;
			},
		},
	};
}

/** An engine whose infinite searches only settle when `stop()` is called. */
function fakeEngine(
	best: (fen: string) => string,
	frames?: (request: AnalysisRequest) => AsyncIterable<AnalysisUpdate>
) {
	const requests: AnalysisRequest[] = [];
	const completions: Array<() => void> = [];
	let stops = 0;
	return {
		requests,
		stops: () => stops,
		complete: (index = completions.length - 1) => completions[index]?.(),
		engineElo: () => 1800,
		analyse(req: AnalysisRequest): AnalysisHandle {
			requests.push(req);
			let settle: (r: AnalysisResult) => void = () => {};
			const result = new Promise<AnalysisResult>((resolve) => {
				settle = resolve;
			});
			async function* none(): AsyncGenerator<never, void, unknown> {}
			const complete = () => {
				const uci = best(req.fen);
				settle({
					id: req.id,
					bestmove: uci,
					final: {
						id: req.id,
						depth: req.limit.depth ?? 20,
						lines: [
							{ multipv: 1, score: { cp: 12 }, depth: req.limit.depth ?? 20, pvUci: [uci], pvSan: [uci] },
						],
						nodes: 1,
						nps: 1,
						timeMs: 1,
						complete: true,
					},
					status: "complete",
					request: req,
				});
			};
			completions.push(complete);
			return {
				id: req.id,
				updates: frames?.(req) ?? none(),
				result,
				stop: () => {
					stops += 1;
					complete();
					return Promise.resolve();
				},
			};
		},
	};
}

describe("PonderController", () => {
	it("propagates an unrestricted active target and invalidates reuse even at an unchanged depth", async () => {
		const engine = fakeEngine(() => "e7e5");
		const { scheduler } = fakeScheduler();
		let targetElo = 3201;
		const p = new PonderController({ engine, scheduler, getTargetElo: () => targetElo });
		await p.start("opponent", FEN);
		expect(engine.requests[0]?.targetElo).toBe(3201);
		expect(engine.requests[0]?.elo).toBeUndefined();
		targetElo = 3202;
		await p.start("opponent", FEN);
		expect(engine.requests[1]?.targetElo).toBe(3202);
		expect(engine.requests[1]?.elo).toBeUndefined();
		expect(engine.requests[1]?.limit.depth).toBe(engine.requests[0]?.limit.depth);
		expect(engine.stops()).toBe(1);
		p.dispose();
	});
	it("publishes complete reached-position frames before the search settles", async () => {
		for (const targetElo of [1800, 3800]) {
			const seen: Array<{ fen: string; update: AnalysisUpdate; fullStrength: boolean }> = [];
			const frame = (id: string, complete: boolean): AnalysisUpdate => ({
				id,
				depth: 10,
				complete,
				nodes: 100,
				nps: 1000,
				timeMs: 100,
				lines: [{ multipv: 1, score: { cp: 20 }, depth: 10, pvUci: ["e7e5"], pvSan: ["e5"] }],
			});
			const engine = fakeEngine(
				() => "e7e5",
				async function* (request) {
					yield frame(request.id, false);
					yield frame("different-search", true);
					yield frame(request.id, true);
				}
			);
			const { scheduler } = fakeScheduler();
			const p = new PonderController({
				engine,
				scheduler,
				getTargetElo: () => targetElo,
				onAnalysis: (fen, update, fullStrength) => seen.push({ fen, update, fullStrength }),
			});
			await p.start("opponent", FEN, ["e2e4"]);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const reached = applyMoves(FEN, ["e2e4"])!;
			expect(p.isRunning()).toBe(true);
			expect(seen).toHaveLength(1);
			expect(seen[0]).toEqual({
				fen: reached,
				update: frame(engine.requests[0]!.id, true),
				fullStrength: targetElo === 3800,
			});
			await p.stop();
			expect(seen).toHaveLength(2);
			expect(seen[1]?.fen).toBe(reached);
			p.dispose();
		}
	});

	it("does not publish a final rating frame after disposal", async () => {
		const seen: AnalysisUpdate[] = [];
		const engine = fakeEngine(() => "e2e4");
		const { scheduler } = fakeScheduler();
		const p = new PonderController({
			engine,
			scheduler,
			onAnalysis: (_, update) => seen.push(update),
		});
		await p.start("panel", FEN);
		p.dispose();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(engine.stops()).toBe(1);
		expect(seen).toEqual([]);
	});

	it("uses the active persona rating and restarts a cached position when that rating changes", async () => {
		const engine = fakeEngine(() => "e7e5");
		const { scheduler } = fakeScheduler();
		let targetElo = 1650;
		const p = new PonderController({ engine, scheduler, getTargetElo: () => targetElo });
		await p.start("opponent", FEN, ["e2e4"]);
		expect(engine.requests[0]?.elo).toBe(1650);
		// depth 17 at 1650 since the automatic depth curve ends at the Maia cutoff (2026-09-15; it was 16).
		expect(engine.requests[0]?.limit).toEqual({ depth: 17, movetimeMs: TIMINGS.ponderMaxMs });
		targetElo = 1673;
		await p.start("opponent", FEN, ["e2e4"]);
		expect(engine.requests[1]?.elo).toBe(1673);
		expect(engine.stops()).toBe(1);
		targetElo = 3800;
		await p.start("opponent", FEN, ["e2e4"]);
		expect(engine.requests[2]?.elo).toBeUndefined();
		expect(engine.requests[2]?.limit.depth).toBe(30);
		expect(engine.stops()).toBe(2);
		p.dispose();
	});

	it("starts Elo-capped MultiPV 3 at ponder priority with the existing time budget", async () => {
		const engine = fakeEngine(() => "e7e5");
		const { scheduler } = fakeScheduler();
		const p = new PonderController({ engine, scheduler });
		await p.start("opponent", FEN, ["e2e4"]);
		expect(engine.requests.length).toBe(1);
		expect(engine.requests[0]?.limit).toEqual({
			depth: automaticDepthForElo(1800),
			movetimeMs: TIMINGS.ponderMaxMs,
		});
		expect(engine.requests[0]?.multiPv).toBe(SEARCH_BUDGET.ponderMultiPv);
		expect(engine.requests[0]?.priority).toBe("ponder");
		expect(engine.requests[0]?.moves).toEqual(["e2e4"]);
		expect(engine.requests[0]?.elo).toBe(1800);
		expect(p.isRunning()).toBe(true);
		p.dispose();
	});
	it("looks up the expected reply under the reached position, normalising the bridge's en-passant spelling", async () => {
		const engine = fakeEngine(() => "e7e5");
		const { scheduler } = fakeScheduler();
		const p = new PonderController({ engine, scheduler });
		await p.start("opponent", FEN, ["e2e4"]);
		await p.stop();
		expect(p.expectedReply("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1")).toBe(
			"e7e5"
		);
		expect(p.expectedReply(FEN)).toBeNull();
		p.dispose();
	});

	it("panel-only mode ponders our own position at panel priority (§7.5)", async () => {
		const engine = fakeEngine(() => "d2d4");
		const { scheduler } = fakeScheduler();
		const p = new PonderController({ engine, scheduler });
		await p.start("panel", FEN);
		expect(engine.requests[0]?.priority).toBe("panel");
		expect(engine.requests[0]?.multiPv).toBe(SEARCH_BUDGET.panelMultiPv);
		expect(engine.requests[0]?.limit).toEqual({
			depth: automaticDepthForElo(1800),
			movetimeMs: TIMINGS.ponderMaxMs,
		});
		p.dispose();
	});

	it("finishes at its depth cap, clears its timer and reuses the completed result until strength changes", async () => {
		const engine = fakeEngine(() => "e7e5");
		const { scheduler, timers } = fakeScheduler();
		let targetElo = 1800;
		const p = new PonderController({ engine, scheduler, getTargetElo: () => targetElo });
		await p.start("opponent", FEN);
		engine.complete();
		await Promise.resolve();
		await Promise.resolve();
		expect(p.isRunning()).toBe(false);
		expect(timers[0]?.cleared).toBe(true);
		expect(p.expectedReply(FEN)).toBe("e7e5");
		await p.start("opponent", FEN);
		expect(engine.requests).toHaveLength(1);
		targetElo = 800;
		await p.start("opponent", FEN);
		expect(engine.stops()).toBe(0);
		expect(engine.requests[1]?.limit.depth).toBe(9);
		expect(engine.requests[1]?.elo).toBe(1320);
		p.dispose();
	});

	it("a second start on the same position and kind is a no-op; a different one stops the first", async () => {
		const engine = fakeEngine(() => "e7e5");
		const { scheduler } = fakeScheduler();
		const p = new PonderController({ engine, scheduler });
		await p.start("opponent", FEN);
		await p.start("opponent", FEN);
		expect(engine.requests.length).toBe(1);
		expect(engine.stops()).toBe(0);
		await p.start("opponent", "8/8/8/8/8/8/8/K6k w - - 0 1");
		expect(engine.requests.length).toBe(2);
		expect(engine.stops()).toBe(1);
		p.dispose();
	});

	it("stop() awaits the bestmove and records the expected reply for that position", async () => {
		const engine = fakeEngine(() => "e7e5");
		const { scheduler } = fakeScheduler();
		const p = new PonderController({ engine, scheduler });
		await p.start("opponent", FEN);
		expect(p.expectedReply(FEN)).toBeNull();
		await p.stop();
		expect(p.isRunning()).toBe(false);
		expect(p.expectedReply(FEN)).toBe("e7e5");
		expect(p.expectedReply("other")).toBeNull();
		expect(p.result()?.bestmove).toBe("e7e5");
		await p.stop(); // idempotent
		expect(engine.stops()).toBe(1);
	});

	it("caps one ponder at TIMINGS.ponderMaxMs", async () => {
		const engine = fakeEngine(() => "e7e5");
		const { scheduler, timers } = fakeScheduler();
		const p = new PonderController({ engine, scheduler });
		await p.start("opponent", FEN);
		expect(timers[0]?.ms).toBe(TIMINGS.ponderMaxMs);
		timers[0]?.fn();
		await Promise.resolve();
		expect(engine.stops()).toBe(1);
		p.dispose();
	});

	it("reports the expected reply through the callback", async () => {
		const seen: Array<string | null> = [];
		const engine = fakeEngine(() => "g8f6");
		const { scheduler } = fakeScheduler();
		const p = new PonderController({ engine, scheduler, onExpectedReply: (u) => seen.push(u) });
		await p.start("opponent", FEN);
		await p.stop();
		expect(seen).toEqual(["g8f6"]);
	});
});
