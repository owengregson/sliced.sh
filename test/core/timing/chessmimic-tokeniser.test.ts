// test/core/timing/chessmimic-tokeniser.test.ts — Task 34: the tokeniser reproduces the upstream
// inputs bit-for-bit (searchless_chess FEN tokens, C++-binding move window, UCI vocabulary).
import { describe, expect, it } from "bun:test";
import {
	buildMoveVocabulary,
	CLASS_TOKEN,
	encodeRecentMoves,
	FEN_CHARACTERS,
	FEN_SEQUENCE_LENGTH,
	INPUT_VOCAB_SIZE,
	MOVE_TO_ACTION,
	MOVE_VOCABULARY,
	PAD_TOKEN,
	tokenizeFen,
} from "@core/timing/chessmimic-tokeniser";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import vocab from "../../../assets/models/chessmimic/vocab.json";
import reference from "../../fixtures/chessmimic-reference.json";
import sample from "../../fixtures/chessmimic-tokeniser-sample.json";

const CM = TIMING_CONSTANTS.chessmimic;

describe("vocab.json (exported from the upstream tokenizer.py)", () => {
	it("characters, special tokens and lengths match the registry", () => {
		expect<string[]>([...FEN_CHARACTERS]).toEqual(vocab.characters);
		expect(CLASS_TOKEN).toBe(vocab.classToken);
		expect(PAD_TOKEN).toBe(vocab.padToken);
		expect(INPUT_VOCAB_SIZE).toBe(vocab.inputVocabSize);
		expect<number>(FEN_SEQUENCE_LENGTH).toBe(vocab.fenSequenceLength);
		expect<number>(FEN_SEQUENCE_LENGTH).toBe(CM.fenTokens);
		expect(vocab.recentMoves).toBe(CM.recentMoves);
	});
	it("the 1 968-entry UCI vocabulary is identical, entry for entry, in order", () => {
		expect(vocab.moves).toHaveLength(CM.moveVocabSize);
		expect([...MOVE_VOCABULARY]).toEqual(vocab.moves);
		expect(buildMoveVocabulary()).toEqual(vocab.moves);
		for (let i = 0; i < vocab.moves.length; i++)
			expect(MOVE_TO_ACTION.get(vocab.moves[i] as string)).toBe(i);
	});
});

describe("hand-derived sample fixture (Task 16)", () => {
	it("matches characters, special tokens and positions", () => {
		expect<string[]>([...FEN_CHARACTERS]).toEqual(sample.characters);
		expect(CLASS_TOKEN).toBe(sample.classToken);
		expect(PAD_TOKEN).toBe(sample.padToken);
		for (const [move, id] of Object.entries(sample.vocabSamples))
			expect(MOVE_TO_ACTION.get(move)).toBe(id);
		expect(MOVE_VOCABULARY.slice(0, sample.vocabFirst.length)).toEqual(sample.vocabFirst);
		for (const p of sample.positions) expect(tokenizeFen(p.fen)).toEqual(p.tokens);
		for (const w of sample.recentMoves) expect(encodeRecentMoves(w.moves)).toEqual(w.tokens);
	});
});

describe("reference fixture (1 000 positions, upstream tokenizer.py + C++ move window)", () => {
	const positions = reference.positions;
	it("has the expected coverage of edge cases", () => {
		expect(positions).toHaveLength(1000);
		expect(positions.some((p) => p.moves.length === 0)).toBe(true);
		expect(positions.some((p) => p.moves.length > 0 && p.moves.length < CM.recentMoves)).toBe(true);
		expect(positions.some((p) => p.moves.length === CM.recentMoves)).toBe(true);
		expect(positions.some((p) => p.moves.length > CM.recentMoves)).toBe(true);
		expect(positions.some((p) => p.moves.some((m) => m.length === 5))).toBe(true); // promotion
		expect(positions.some((p) => Number(p.fen.split(" ")[4]) >= 100)).toBe(true);
		expect(positions.some((p) => Number(p.fen.split(" ")[5]) >= 100)).toBe(true);
		expect(positions.some((p) => p.fen.split(" ")[3] !== "-")).toBe(true); // en passant square
		expect(positions.some((p) => p.fen.split(" ")[2] === "-")).toBe(true); // no castling
		const bands = new Set(positions.map((p) => p.band));
		expect([...bands].sort()).toEqual([...CM.bands]);
	});
	it("FEN tokens are reproduced bit-for-bit", () => {
		let checked = 0;
		for (const p of positions) {
			const tokens = tokenizeFen(p.fen);
			expect(tokens).toEqual(p.fenTokens);
			expect(tokens).toHaveLength(FEN_SEQUENCE_LENGTH);
			checked++;
		}
		expect(checked).toBe(1000);
	});
	it("move-window tokens are reproduced bit-for-bit (last 12, left-padded with PAD_TOKEN)", () => {
		for (const p of positions) {
			const tokens = encodeRecentMoves(p.moves);
			expect(tokens).toEqual(p.moveTokens);
			expect(tokens).toHaveLength(CM.recentMoves);
		}
	});
	it("the 92-token model sequence is moves (12) + rating + clock + FEN (78)", () => {
		const p = positions[0];
		if (!p) throw new Error("empty fixture");
		expect(p.moveTokens.length + 2 + p.fenTokens.length).toBe(CM.sequenceLength);
	});
});
