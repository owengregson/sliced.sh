// test/service/game-session/ponder.test.ts — Task 30: one `go infinite` at a time (§6.4,
// Appendix E §4.2), the expected reply it yields and the cap.
import { describe, expect, it } from "bun:test";
import { SEARCH_BUDGET } from "@core/constants/search";
import { TIMINGS } from "@core/constants/timings";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
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
function fakeEngine(best: (fen: string) => string) {
	const requests: AnalysisRequest[] = [];
	let stops = 0;
	return {
		requests,
		stops: () => stops,
		engineElo: () => 1800,
		analyse(req: AnalysisRequest): AnalysisHandle {
			requests.push(req);
			let settle: (r: AnalysisResult) => void = () => {};
			const result = new Promise<AnalysisResult>((resolve) => {
				settle = resolve;
			});
			async function* none(): AsyncGenerator<never, void, unknown> {}
			return {
				id: req.id,
				updates: none(),
				result,
				stop: () => {
					stops += 1;
					const uci = best(req.fen);
					settle({
						id: req.id,
						bestmove: uci,
						final: {
							id: req.id,
							depth: 20,
							lines: [{ multipv: 1, score: { cp: 12 }, depth: 20, pvUci: [uci], pvSan: [uci] }],
							nodes: 1,
							nps: 1,
							timeMs: 1,
							complete: true,
						},
						status: "complete",
						request: req,
					});
					return Promise.resolve();
				},
			};
		},
	};
}

describe("PonderController", () => {
	it("starts `go infinite` MultiPV 3 at ponder priority on the opponent's position", async () => {
		const engine = fakeEngine(() => "e7e5");
		const { scheduler } = fakeScheduler();
		const p = new PonderController({ engine, scheduler });
		await p.start("opponent", FEN, ["e2e4"]);
		expect(engine.requests.length).toBe(1);
		expect(engine.requests[0]?.limit).toEqual({ infinite: true });
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
