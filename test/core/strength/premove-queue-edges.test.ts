/**
 * The self-invalidation claim behind queued trade premoves (`isQueueableCandidate`), in the edge
 * cases: another piece captures on the square, the capture gives check, a quiet check elsewhere,
 * en passant and a capture that promotes. A queued premove is played by the site only if it is
 * legal once the opponent's move lands; these pin that it is then still a sound recapture, and
 * that every other reply makes it illegal (the site drops it).
 */
import { describe, expect, it } from "bun:test";
import { classifyMove } from "@core/chess/move-classify";
import { applyMoves, legalMoves } from "@core/chess/san";
import { isQueueableCandidate } from "@core/strength/premove";
import { isObviousRecapture } from "@core/timing/calibration";

/** Every legal reply after which `premove` is still legal (the site would fire it). */
function firesAfter(afterMove: string, premove: string): string[] {
	return legalMoves(afterMove).filter((r) => {
		const next = applyMoves(afterMove, [r]);
		return next !== null && legalMoves(next).includes(premove);
	});
}

describe("queued trade premoves in the edge cases", () => {
	it("stays a sound recapture when another piece captures on the square", () => {
		// White Nd4 defended by e3; Black can take it with the knight or the bishop.
		const fen = "4k3/b7/2n5/8/3N4/4P3/8/4K3 b - - 0 1";
		const candidate = { reply: "c6d4", premove: "e3d4", reason: "recapture" as const };
		expect(isQueueableCandidate(fen, candidate)).toBe(true);
		const fires = firesAfter(fen, "e3d4");
		expect(fires.sort()).toEqual(["a7d4", "c6d4"]);
		for (const reply of fires) {
			const next = applyMoves(fen, [reply]) as string;
			expect(isObviousRecapture(fen, reply, next, "e3d4")).toBe(true);
		}
	});
	it("stays legal and sound when the capture gives check (the recapture removes the checker)", () => {
		// White Ke2, Nd4 defended by e3: ...Nxd4+ checks the king, exd4 takes the checker.
		const fen = "4k3/8/2n5/8/3N4/4P3/4K3/8 b - - 0 1";
		expect(isQueueableCandidate(fen, { reply: "c6d4", premove: "e3d4", reason: "recapture" })).toBe(
			true
		);
		const next = applyMoves(fen, ["c6d4"]) as string;
		expect(legalMoves(next)).toContain("e3d4");
	});
	it("is dropped by any reply that does not capture there, including a quiet check", () => {
		const fen = "4k3/b7/2n5/8/3N4/4P3/8/4K3 b - - 0 1";
		for (const reply of legalMoves(fen)) {
			if (reply.slice(2, 4) === "d4") continue;
			const next = applyMoves(fen, [reply]) as string;
			expect(legalMoves(next)).not.toContain("e3d4");
		}
	});
	it("never queues onto an en-passant landing square (it holds none of our pieces)", () => {
		// White just played e2-e4; Black's d4 pawn takes en passant on e3.
		const fen = "4k3/8/8/8/3pP3/8/5P2/4K3 b - e3 0 1";
		expect(legalMoves(fen)).toContain("d4e3");
		expect(isQueueableCandidate(fen, { reply: "d4e3", premove: "f2e3", reason: "recapture" })).toBe(
			false
		);
	});
	it("takes back the promoted piece, whatever it promoted to, when the capture promotes", () => {
		// White Rb1 and Nd2 (covering b1); Black's a2 pawn can take on b1 and promote.
		const fen = "4k3/8/8/8/8/8/p2N4/1R2K3 b - - 0 1";
		const candidate = { reply: "a2b1q", premove: "d2b1", reason: "recapture" as const };
		expect(isQueueableCandidate(fen, candidate)).toBe(true);
		const fires = firesAfter(fen, "d2b1");
		expect(fires.sort()).toEqual(["a2b1b", "a2b1n", "a2b1q", "a2b1r"]);
		for (const reply of fires) {
			const next = applyMoves(fen, [reply]) as string;
			// The recapture takes the new piece (a pawn that became a queen, rook, bishop or knight).
			expect(classifyMove(next, "d2b1", reply)?.capturedType as string | undefined).toBe(
				reply.slice(4, 5)
			);
		}
		// A promotion that does not capture on b1 leaves our rook there: the premove is dropped.
		const quiet = applyMoves(fen, ["a2a1q"]) as string;
		expect(legalMoves(quiet)).not.toContain("d2b1");
	});
});
