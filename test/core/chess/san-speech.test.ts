// test/core/chess/san-speech.test.ts — Task 30: the words `chrome.tts` speaks for a SAN move.
import { describe, expect, it } from "bun:test";
import { sanToSpeech } from "@core/chess/san-speech";

describe("sanToSpeech", () => {
	it("names the piece and the square", () => {
		expect(sanToSpeech("Nf3")).toBe("knight f3");
		expect(sanToSpeech("Qd8")).toBe("queen d8");
		expect(sanToSpeech("e4")).toBe("e4");
	});
	it("says takes for a capture", () => {
		expect(sanToSpeech("Nxd5")).toBe("knight takes d5");
		expect(sanToSpeech("exd5")).toBe("e takes d5");
	});
	it("says check and checkmate", () => {
		expect(sanToSpeech("Qh5+")).toBe("queen h5 check");
		expect(sanToSpeech("Qxf7#")).toBe("queen takes f7 checkmate");
	});
	it("names castling by side", () => {
		expect(sanToSpeech("O-O")).toBe("castles kingside");
		expect(sanToSpeech("O-O-O")).toBe("castles queenside");
		expect(sanToSpeech("O-O+")).toBe("castles kingside check");
	});
	it("says the promotion piece", () => {
		expect(sanToSpeech("e8=Q")).toBe("e8 promotes to queen");
		expect(sanToSpeech("exd8=N+")).toBe("e takes d8 promotes to knight check");
	});
	it("drops annotation marks and passes anything else through", () => {
		expect(sanToSpeech("Nf3!?")).toBe("knight f3");
		expect(sanToSpeech("")).toBe("");
		expect(sanToSpeech("  ")).toBe("");
	});
});
