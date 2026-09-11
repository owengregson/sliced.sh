import { describe, expect, it } from "bun:test";
import {
	historyFromSan,
	historyKey,
	matchingHistory,
	type PositionHistory,
} from "@core/chess/history";
import { applyMoves } from "@core/chess/san";
import { CHESS_START_FEN } from "@core/constants/chess";
import { selectMove } from "@core/strength/move-selector";
import { avoidRepetition, repetitionRisk } from "@core/strength/repetition";
import { ctx, line } from "./helpers";

const START = "6k1/8/8/8/8/8/PPPP4/6K1 b - - 0 1";
const history: PositionHistory = {
	fen: START,
	moves: ["g8h8", "g1h1", "h8g8", "h1g1", "g8h8", "g1h1", "h8g8"],
};
const fen = applyMoves(history.fen, history.moves)!;

describe("draw-aware history and selection", () => {
	it("recognises an actual third occurrence and an opponent's unlisted drawing reply", () => {
		expect(repetitionRisk(history, "h1g1")).toBe(2);
		expect(repetitionRisk(history, "a2a3")).toBe(0);
		const beforeOpponentDraw = {
			fen: "6k1/8/8/8/8/8/PPPP4/6K1 w - - 0 1",
			moves: ["g1h1", "g8h8", "h1g1", "h8g8", "g1h1", "g8h8"],
		};
		expect(repetitionRisk(beforeOpponentDraw, "h1g1")).toBe(2);
	});

	it("keeps a large pawn advantage in every selection mode, retaining the actual engine rank", () => {
		const lines = [line(fen, "h1g1", { cp: 800 }, 1), line(fen, "a2a3", { cp: 775 }, 2)];
		for (const selectionMode of ["engine-elo", "hybrid", "persona-sampling"] as const) {
			const chosen = selectMove(lines, ctx({ fen, history, selectionMode, engineBestmove: "h1g1" }));
			expect(chosen.uci).toBe("a2a3");
			expect(chosen.rankInLines).toBe(2);
			expect(chosen.cpLoss).toBe(25);
			expect(chosen.rationale.join(" ")).toContain("repetition");
		}
	});

	it("keeps the draw when every searched alternative loses or throws away the advantage", () => {
		const losing = [line(fen, "h1g1", { cp: 0 }, 1), line(fen, "a2a3", { cp: -300 }, 2)];
		expect(avoidRepetition(losing, fen, history).lines).toEqual(losing);
		const unsound = [line(fen, "h1g1", { cp: 800 }, 1), line(fen, "a2a3", { cp: 50 }, 2)];
		expect(avoidRepetition(unsound, fen, history).lines).toEqual(unsound);
	});

	it("does not fabricate history when the move list is stale or incomplete", () => {
		expect(matchingHistory(history, START)).toBeNull();
		expect(historyFromSan(["e4", "e5"], CHESS_START_FEN)).toBeNull();
		const reached = applyMoves(CHESS_START_FEN, ["e2e4", "e7e5", "g1f3"])!;
		expect(historyFromSan(["e4", "e5", "Nf3"], reached)?.moves).toEqual(["e2e4", "e7e5", "g1f3"]);
		const cycle = ["g1f3", "g8f6", "f3g1", "f6g8"];
		const repeated = applyMoves(CHESS_START_FEN, [...cycle, ...cycle])!;
		expect(historyFromSan(["Nf3", "Nf6", "Ng1", "Ng8"], repeated)).toBeNull();
		expect(matchingHistory({ fen: CHESS_START_FEN, moves: cycle }, repeated)).toBeNull();
	});

	it("cache identity distinguishes repeated boards and fifty-move counters while retaining irreversible transpositions", () => {
		const cycle = ["g1f3", "g8f6", "f3g1", "f6g8"];
		const returned = applyMoves(CHESS_START_FEN, cycle)!;
		expect(historyKey(CHESS_START_FEN, cycle)).not.toBe(historyKey(returned));
		expect(historyKey(CHESS_START_FEN)).not.toBe(historyKey(CHESS_START_FEN.replace("0 1", "99 1")));
		const pushed = applyMoves(CHESS_START_FEN, [...cycle, "e2e4"])!;
		expect(historyKey(CHESS_START_FEN, [...cycle, "e2e4"])).toBe(historyKey(pushed));
	});
});
