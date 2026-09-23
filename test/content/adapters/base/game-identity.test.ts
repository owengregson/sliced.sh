import { describe, expect, it } from "bun:test";
import { GameIdentity } from "@content/adapters/base/game-identity";

const board = (): Element => ({}) as Element;

describe("GameIdentity", () => {
	it("keeps its serial as plies accumulate on one board", () => {
		const id = new GameIdentity();
		const b = board();
		for (let ply = 0; ply < 6; ply += 1) id.advance(b, ply, false, true);
		expect(id.generation).toBe(0);
		expect(id.pathKey("/play/computer")).toBe("-play-computer#0");
	});

	it("advances when the board is replaced, reset to ply zero, or a finished game restarts", () => {
		const id = new GameIdentity();
		const first = board();
		id.advance(first, 0, false, true);
		id.advance(board(), 1, false, true);
		expect(id.generation).toBe(1);
		const same = board();
		id.advance(same, 4, false, true);
		expect(id.generation).toBe(2);
		id.advance(same, 0, false, true);
		expect(id.generation).toBe(3);
		id.advance(same, 1, true, false);
		id.advance(same, 1, false, false);
		expect(id.generation).toBe(3); // ended but not active: no restart yet
		id.advance(same, 1, false, true);
		expect(id.generation).toBe(4);
	});
});
