import { describe, expect, it } from "bun:test";
import { cheapThreats, threatAnswered } from "@core/chess/threat";

/** After 1.e4 e5 2.Nf3 Nc6 3.d4 d6 4.d5: the d5 pawn attacks the c6 knight, black to move. */
const PAWN_ON_KNIGHT = "r1bqkbnr/ppp2ppp/2np4/3Pp3/4P3/5N2/PPP2PPP/RNBQKB1R b KQkq - 0 4";
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** A knight attacked by a knight is not a cheap threat: equal value. */
const KNIGHT_ON_KNIGHT = "rnbqkb1r/pppppppp/5n2/8/4N3/8/PPPPPPPP/RNBQKB1R b KQkq - 0 3";

describe("cheap threats", () => {
	it("a pawn attacking a knight is a cheap threat; nothing else in that position is", () => {
		expect(cheapThreats(PAWN_ON_KNIGHT)).toEqual([
			{ attacked: "c6", attacker: "d5", attackedValue: 3, attackerValue: 1 },
		]);
		expect(cheapThreats(START)).toEqual([]);
		expect(cheapThreats(KNIGHT_ON_KNIGHT)).toEqual([]);
		expect(cheapThreats("not a fen")).toEqual([]);
	});

	it("the move answers the threat by moving the piece or taking the attacker, not otherwise", () => {
		expect(threatAnswered(PAWN_ON_KNIGHT, "c6e7")?.attacked).toBe("c6");
		expect(threatAnswered(PAWN_ON_KNIGHT, "c6b8")?.attacked).toBe("c6");
		expect(threatAnswered(PAWN_ON_KNIGHT, "g8f6")).toBeNull();
		expect(threatAnswered(PAWN_ON_KNIGHT, "zz")).toBeNull();
		expect(threatAnswered(START, "e2e4")).toBeNull();
	});
});
