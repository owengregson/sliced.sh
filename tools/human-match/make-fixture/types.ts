/** tools/human-match/make-fixture/types.ts — the shape of `test/fixtures/strength/maia-draw.json`. */

import type { MaiaSize } from "@core/constants/maia";
import type { EvalLine } from "@typedefs/engine";

export interface FixturePolicy {
	moves: Array<[string, number]>;
	wdl: [number, number, number];
}

export interface FixturePosition {
	index: number;
	fen: string;
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
	ply: number;
	policy: Partial<Record<MaiaSize, FixturePolicy>>;
	engine: {
		searchmoves: string[];
		bestmove: string | null;
		depth: number;
		complete: boolean;
	};
	lines: EvalLine[];
}

export interface MaiaDrawFixture {
	provenance: {
		source: string;
		generator: string;
		engine: string;
		models: string[];
		command: string;
		threads: number;
		hashMb: number;
		collection: string;
		capturedOn: string;
		note: string;
	};
	positions: FixturePosition[];
}
