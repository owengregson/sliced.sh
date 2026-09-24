/**
 * tools/pgn-clock-reference.ts — the human blitz clock reference
 * (`test/fixtures/timing/human-blitz-clock.json`), extracted from a chess.com PGN export.
 *
 * The measurement behind `docs/research/chessmimic-bands-and-the-clock-2026-09-13.md` §2: in the
 * owner's own 3+0 games at ~2400, the **human opponent of each game** is the control — the same
 * position, the same clock, a real player of our own rating. This script turns that export into
 * the aggregate table `test/core/timing/blitz-clock-budget.test.ts` asserts against, so the tests
 * carry a measured target rather than a hand-set one.
 *
 *     bun tools/pgn-clock-reference.ts --pgn "chess_com_games_2026-09-13 (1).pgn"
 *     bun tools/pgn-clock-reference.ts --pgn FILE --out test/fixtures/timing/human-blitz-clock.json
 *     bun tools/pgn-clock-reference.ts --pgn FILE --print      # table only, writes nothing
 *
 * The PGN itself is personal game data and is **not** checked in; only the derived aggregate is.
 * Nothing here runs in the extension or in `bun run check`.
 *
 * The parts: PGN parsing and think attribution in `tools/lib/pgn/` (with the parsing notes),
 * buckets and statistics, the game window, the reference and its table in
 * `tools/timing/clock-reference/`. This file is their public entry and the CLI.
 */

import path from "node:path";
import { flagValue, hasFlag } from "./lib/cli";
import { parseGames, parseTimeControl } from "./lib/pgn/export";
import { buildReference } from "./timing/clock-reference/reference";
import { referenceTable } from "./timing/clock-reference/table";

export {
	type ParsedGame,
	parseClock,
	parseGames,
	parseTimeControl,
} from "./lib/pgn/export";
export { type Think, thinksOf } from "./lib/pgn/thinks";
export { percentile } from "./lib/stats";
export {
	BUCKETS,
	type BucketSpec,
	type BucketStats,
	bucketedStats,
	bucketOf,
	MIDDLEGAME,
	MIDDLEGAME_FROM,
	MIDDLEGAME_TO,
	OVERALL,
	statsOf,
} from "./timing/clock-reference/buckets";
export { buildReference, type ClockReference } from "./timing/clock-reference/reference";
export {
	clockMilestones,
	type GameRow,
	type Milestone,
	selectWindow,
	type WindowOptions,
} from "./timing/clock-reference/window";

async function main(argv: readonly string[]): Promise<void> {
	const pgn = flagValue(argv, "pgn");
	if (!pgn) throw new Error("--pgn FILE is required");
	const root = path.resolve(import.meta.dir, "..");
	const out = path.resolve(
		root,
		flagValue(argv, "out", "test/fixtures/timing/human-blitz-clock.json") ?? ""
	);
	const tc = parseTimeControl(flagValue(argv, "tc", "180") ?? "180");
	if (!tc) throw new Error("--tc must look like 180 or 180+2");
	const reference = buildReference(parseGames(await Bun.file(path.resolve(pgn)).text()), {
		pgn,
		account: flagValue(argv, "account", "gc_elif") ?? "gc_elif",
		baseSec: tc.baseSec,
		incSec: tc.incSec,
		minOurElo: Number(flagValue(argv, "min-our-elo", "2400")),
		minOppElo: Number(flagValue(argv, "min-opp-elo", "2200")),
		minOurMoves: Number(flagValue(argv, "min-our-moves", "12")),
		recent: Number(flagValue(argv, "recent", "10")),
	});
	process.stdout.write(`${referenceTable(reference)}\n`);
	if (hasFlag(argv, "print")) process.exit(0);
	await Bun.write(out, `${JSON.stringify(reference, null, "\t")}\n`);
	process.stdout.write(`\nwrote ${path.relative(root, out)}\n`);
}

if (import.meta.main) await main(process.argv);
