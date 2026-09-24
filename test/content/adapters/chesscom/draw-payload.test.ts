import { describe, expect, it } from "bun:test";
import { clearPayloadOf, drawPayloadOf } from "@content/adapters/chesscom/draw-payload";

describe("chess.com mark payloads", () => {
	it("carries the orientation, and forceOverlay only when asked", () => {
		expect(drawPayloadOf([], [], {}, true)).toEqual({
			arrows: [],
			highlights: [],
			orientation: "black",
		});
		expect(drawPayloadOf([], [], { forceOverlay: true }, false)).toEqual({
			arrows: [],
			highlights: [],
			orientation: "white",
			forceOverlay: true,
		});
	});

	it("names keys only when there are keys (an empty array would clear nothing)", () => {
		expect(clearPayloadOf([])).toEqual({});
		const keys = ["a"];
		const payload = clearPayloadOf(keys) as { keys: string[] };
		expect(payload).toEqual({ keys: ["a"] });
		expect(payload.keys).not.toBe(keys);
	});
});
