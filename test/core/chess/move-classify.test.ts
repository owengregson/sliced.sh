// test/core/chess/move-classify.test.ts
import { describe, expect, it } from "bun:test";
import { classifyMove } from "@core/chess/move-classify";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** After 1.e4 d5 2.exd5 — black to move. */
const AFTER_EXD5 = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
/** Fool's mate position — black to move, Qh4 mates. */
const FOOLS = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";
const CASTLE = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
/** Black king a8 boxed by Kb6 + Rh1: a8b8 is the only legal move. */
const ONLY = "k7/8/1K6/8/8/8/8/7R b - - 0 1";

describe("classifyMove", () => {
	it("classifies a quiet pawn push", () => {
		expect(classifyMove(START, "e2e4")).toEqual({
			isCapture: false,
			isRecapture: false,
			isCheck: false,
			isCastle: false,
			isPromotion: false,
			isOnlyMove: false,
			pieceType: "p",
			capturedType: null,
			givesMate: false,
		});
	});
	it("flags a recapture when prevMove captured on the same square", () => {
		const c = classifyMove(AFTER_EXD5, "d8d5", "e4d5");
		expect(c?.isCapture).toBe(true);
		expect(c?.isRecapture).toBe(true);
		expect(c?.pieceType).toBe("q");
		expect(c?.capturedType).toBe("p");
	});
	it("does not flag a recapture without prevMove or on another square", () => {
		expect(classifyMove(AFTER_EXD5, "d8d5")?.isRecapture).toBe(false);
		expect(classifyMove(AFTER_EXD5, "d8d5", "b1c3")?.isRecapture).toBe(false);
		expect(classifyMove(AFTER_EXD5, "d8d5", "not-uci")?.isRecapture).toBe(false);
		// A non-capture landing on prevMove's square is not a recapture.
		expect(classifyMove(START, "e2e4", "e7e4")?.isRecapture).toBe(false);
	});
	it("detects check and mate", () => {
		const c = classifyMove(FOOLS, "d8h4");
		expect(c?.isCheck).toBe(true);
		expect(c?.givesMate).toBe(true);
		const d = classifyMove(START, "e2e4");
		expect(d?.givesMate).toBe(false);
	});
	it("detects castling", () => {
		expect(classifyMove(CASTLE, "e1g1")?.isCastle).toBe(true);
		expect(classifyMove(CASTLE, "e1c1")?.isCastle).toBe(true);
		expect(classifyMove(CASTLE, "e1g1")?.pieceType).toBe("k");
		expect(classifyMove(CASTLE, "e1f1")?.isCastle).toBe(false);
	});
	it("detects promotion", () => {
		const c = classifyMove("8/4P3/k7/8/8/8/8/4K3 w - - 0 1", "e7e8q");
		expect(c?.isPromotion).toBe(true);
		expect(c?.pieceType).toBe("p");
	});
	it("detects the only legal move", () => {
		expect(classifyMove(ONLY, "a8b8")?.isOnlyMove).toBe(true);
		expect(classifyMove(START, "e2e4")?.isOnlyMove).toBe(false);
	});
	it("counts en passant as a capture", () => {
		// 1.e4 a6 2.e5 d5 — white can capture en passant on d6.
		const fen = "rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3";
		const c = classifyMove(fen, "e5d6", "d7d5");
		expect(c?.isCapture).toBe(true);
		expect(c?.capturedType).toBe("p");
		expect(c?.isRecapture).toBe(false);
	});
	it("returns null for illegal moves and bad FENs", () => {
		expect(classifyMove(START, "e2e5")).toBeNull();
		expect(classifyMove(START, "zz")).toBeNull();
		expect(classifyMove("bad fen", "e2e4")).toBeNull();
	});
});
