import { describe, expect, it } from "bun:test";
import { EXECUTOR } from "@core/constants/cdp";
import type { BoardGeometryReply } from "@core/constants/messages";
import { BoardChecks } from "@service/move-executor/executor/board-checks";
import type { ExecutorLink } from "@service/move-executor/executor/types";
import type { Recommendation } from "@typedefs/game";

const rec = { chosen: { from: "e2", to: "e4", uci: "e2e4" } } as unknown as Recommendation;
const board = { left: 0, top: 0, width: 800, height: 800 };
const reply = (occupancy?: BoardGeometryReply["occupancy"]): BoardGeometryReply =>
	({ boardRect: board, flipped: false, ...(occupancy ? { occupancy } : {}) }) as BoardGeometryReply;

function link(answer: () => Promise<unknown>): ExecutorLink & { asked: number } {
	const l = {
		asked: 0,
		request: () => {
			l.asked += 1;
			return answer();
		},
	};
	return l as unknown as ExecutorLink & { asked: number };
}

describe("BoardChecks.positionChanged", () => {
	it("answers from the reply's occupancy for free", async () => {
		const l = link(() => Promise.reject(new Error("unused")));
		const checks = new BoardChecks(l, 1);
		expect(await checks.positionChanged(rec, reply({ e2: "own" }), true, true)).toBeNull();
		expect(await checks.positionChanged(rec, reply({ e2: "empty" }), true, true)).toEqual({
			outcome: "skipped",
			reason: EXECUTOR.reasons.positionChanged,
		});
		// A premove's destination is routinely still ours (a recapture): only `from` is asked.
		const recapture = reply({ e2: "own", e4: "own" });
		expect(await checks.positionChanged(rec, recapture, true, true)).not.toBeNull();
		expect(await checks.positionChanged(rec, recapture, true, true, true)).toBeNull();
		expect(l.asked).toBe(0);
	});

	it("asks the adapter only for a replacement (or a required check) with verification on", async () => {
		const l = link(() => Promise.resolve({ occupancy: { e2: "own", e4: "empty" } }));
		const checks = new BoardChecks(l, 1);
		expect(await checks.positionChanged(rec, reply(), false, true)).toBeNull();
		expect(await checks.positionChanged(rec, reply(), true, false)).toBeNull();
		expect(l.asked).toBe(0);
		expect(await checks.positionChanged(rec, reply(), true, true)).toBeNull();
		expect(await checks.positionChanged(rec, reply(), true, false, false, true)).toBeNull();
		expect(l.asked).toBe(2);
	});

	it("never dispatches on a guess", async () => {
		const partial = new BoardChecks(
			link(() => Promise.resolve({ occupancy: { e2: "own" } })),
			1
		);
		expect(await partial.positionChanged(rec, reply(), true, true)).toEqual({
			outcome: "skipped",
			reason: EXECUTOR.reasons.verificationUnavailable,
		});
		const down = new BoardChecks(
			link(() => Promise.reject(new Error("no port"))),
			1
		);
		expect(await down.positionChanged(rec, reply(), true, true)).toEqual({
			outcome: "skipped",
			reason: EXECUTOR.reasons.verificationUnavailable,
		});
	});

	it("reports a check cut short by a cancel as aborted", async () => {
		let checks: BoardChecks;
		const l = link(() => {
			checks.abort();
			return Promise.reject(new Error("aborted"));
		});
		checks = new BoardChecks(l, 1);
		expect(await checks.positionChanged(rec, reply(), true, true)).toEqual({
			outcome: "aborted",
			reason: EXECUTOR.reasons.aborted,
		});
	});
});
