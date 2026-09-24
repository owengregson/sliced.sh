// test/service/auto-queue/entry.test.ts — one tab's pending queue click: the first wait after a
// game (one RNG draw only on the ordinary path), the entry a persisted record resumes, and the
// records the queue persists.
import { describe, expect, it } from "bun:test";
import { TIMINGS } from "@core/constants/timings";
import type { Rng } from "@core/rng";
import { entryFromRecord, firstWait, recordsOf } from "@service/auto-queue/entry";
import type { PlayingSession } from "@typedefs/storage";

function countingRng(value: number): Rng & { draws: number } {
	const rng = {
		draws: 0,
		next() {
			rng.draws += 1;
			return value;
		},
	};
	return rng as unknown as Rng & { draws: number };
}

const session = (breakUntil: number | null): PlayingSession => ({
	gameId: "g1",
	startedAt: 0,
	endsAt: 1_000,
	completedGames: 1,
	lastFinishedGameId: "g1",
	breakUntil,
});

describe("firstWait", () => {
	const [lo, hi] = TIMINGS.autoQueueDelayRangeMs;

	it("draws the ordinary delay once when no break is due", () => {
		const rng = countingRng(0.5);
		expect(firstWait(session(null), null, 100, rng)).toEqual({
			delay: lo + 0.5 * (hi - lo),
			status: "waiting",
		});
		expect(rng.draws).toBe(1);
	});

	it("waits out a due break without a draw", () => {
		const rng = countingRng(0.5);
		expect(firstWait(session(5_000), null, 1_000, rng)).toEqual({ delay: 4_000, status: "break" });
		expect(rng.draws).toBe(0);
	});

	it("puts a rematch step before a due break", () => {
		const rng = countingRng(0);
		expect(firstWait(session(5_000), "gm", 1_000, rng)).toEqual({ delay: lo, status: "waiting" });
		expect(rng.draws).toBe(1);
	});
});

describe("entryFromRecord / recordsOf", () => {
	it("resumes a future break deadline as a break and keeps a pending rematch", () => {
		const entry = entryFromRecord(
			{ gameId: "g1", dueAt: 5_000, session: session(5_000), rematch: "gm" },
			5_000,
			() => 1_000
		);
		expect(entry).toEqual({
			gameId: "g1",
			dueAt: 5_000,
			attempts: 0,
			status: "break",
			rematch: { opponent: "gm", phase: "pending" },
		});
	});

	it("persists a running rematch without its opponent and a session-only tab without a deadline", () => {
		const entries = new Map([
			[
				1,
				{
					gameId: "a",
					dueAt: 10,
					attempts: 1,
					status: "rematch" as const,
					rematch: { opponent: "gm", phase: "running" as const },
				},
			],
		]);
		const sessions = new Map([[2, session(null)]]);
		expect(recordsOf([1, 2], entries, sessions)).toEqual({
			"1": { gameId: "a", dueAt: 10 },
			"2": { gameId: "g1", dueAt: null, session: session(null) },
		});
	});
});
