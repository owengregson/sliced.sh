/**
 * tools/human-match/make-fixture/frames.ts — the engine half of the fixture: one real referee
 * frame per position over exactly the union of each size's top moves (`go searchmoves`).
 */

import type { MaiaSize } from "@core/constants/maia";
import { createRefereeEngine } from "../../lib/engine/referee";
import type { FixtureArgs } from "./args";
import type { FixturePosition } from "./types";

/** Fills `engine` and `lines` of every position in place. */
export async function searchFrames(
	positions: FixturePosition[],
	sizes: readonly MaiaSize[],
	args: Pick<FixtureArgs, "movetime" | "depth" | "top">
): Promise<void> {
	console.log("engine: booting the vendored Stockfish 19 smallnet …");
	const engine = await createRefereeEngine({ threads: 1, hashMb: 32 });
	const started = performance.now();
	for (const p of positions) {
		const roots = new Set<string>();
		for (const size of sizes)
			for (const [uci] of (p.policy[size]?.moves ?? []).slice(0, args.top)) roots.add(uci);
		const searchmoves = [...roots];
		const frame = await engine.search({
			fen: p.fen,
			movetimeMs: args.movetime,
			depth: args.depth,
			multiPv: searchmoves.length,
			searchmoves,
		});
		p.engine = {
			searchmoves,
			bestmove: frame.bestmove,
			depth: frame.depth,
			complete: frame.complete,
		};
		p.lines = frame.lines;
		console.log(
			`  #${p.index} ${searchmoves.length} roots → ${frame.lines.length} lines depth ${frame.depth}${frame.complete ? "" : " (incomplete)"} best ${frame.bestmove} ${frame.elapsedMs.toFixed(0)} ms`
		);
	}
	engine.dispose();
	console.log(
		`engine: ${positions.length} frames in ${((performance.now() - started) / 1000).toFixed(1)} s`
	);
}
