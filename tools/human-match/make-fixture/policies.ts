/**
 * tools/human-match/make-fixture/policies.ts — the Maia half of the fixture: every size's full
 * legal-move distribution per parity position, checked against the torch reference's argmax.
 */

import path from "node:path";
import { parseFen, plyOf } from "@core/chess/fen";
import type { MaiaSize } from "@core/constants/maia";
import { maiaIndexToUci, maiaMoveIndex } from "@core/policy/maia-encoder";
import { createMaiaRunner } from "../../lib/maia";
import { ROOT } from "../../lib/paths";
import type { FixturePosition } from "./types";

export interface ParityPosition {
	fen: string;
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
}
interface ExpectedFixture {
	positions: Array<{ top: Array<[string, number]> }>;
}

/** Positions with their policies filled and no engine frame yet. */
export async function positionsWithPolicies(
	source: readonly ParityPosition[],
	sizes: readonly MaiaSize[]
): Promise<FixturePosition[]> {
	const maia = await createMaiaRunner(1);
	const positions: FixturePosition[] = [];
	for (const [index, p] of source.entries()) {
		const parts = parseFen(p.fen);
		if (!parts) throw new Error(`position ${index}: unreadable FEN`);
		const policy: FixturePosition["policy"] = {};
		for (const size of sizes) {
			const answer = await maia.query(size, p.historyFens, p.selfElo, p.oppoElo);
			policy[size] = { moves: answer.moves, wdl: answer.wdl };
		}
		positions.push({
			index,
			fen: p.fen,
			historyFens: p.historyFens,
			selfElo: p.selfElo,
			oppoElo: p.oppoElo,
			ply: plyOf(parts),
			policy,
			engine: { searchmoves: [], bestmove: null, depth: 0, complete: false },
			lines: [],
		});
	}
	// Sanity against the torch reference: the argmax must agree for every position.
	for (const size of sizes) {
		const file = Bun.file(path.join(ROOT, `test/fixtures/maia3/expected-${size}.json`));
		if (!(await file.exists())) continue;
		const expected = (await file.json()) as ExpectedFixture;
		let agree = 0;
		for (const p of positions) {
			const want = expected.positions[p.index]?.top[0]?.[0];
			const mirrored = p.fen.split(" ")[1] === "b";
			const wantBoard =
				want === undefined ? undefined : maiaIndexToUci(maiaMoveIndex(want, false), mirrored);
			if (wantBoard !== undefined && p.policy[size]?.moves[0]?.[0] === wantBoard) agree++;
		}
		console.log(`maia ${size}: argmax agrees with torch on ${agree}/${positions.length}`);
		if (agree !== positions.length) throw new Error(`maia ${size}: parity mismatch, aborting`);
	}
	await maia.dispose();
	return positions;
}
