/**
 * tools/timing-calibration/fixture.ts — freeze a small replay set for the behavioural test.
 *
 *     bun tools/timing-calibration/fixture.ts [--sides 24] [--out test/fixtures/timing/calibration-replay.json]
 *
 * It takes holdout 2600–2999 blitz sides from the replay set (`loadReplay`), in hash order, and
 * writes each side's rows with everything the replay needs: the frame lines, the predicted reply,
 * the premove facts, the head distribution and the recaptures on the board. The game record is
 * trimmed to the moves and FENs. `test/core/timing/calibration-replay.test.ts` replays them
 * through `sim.ts` under the shipped table and pins the high-Elo book and recapture timing to the
 * humans'.
 */

import "../lib/defines";
import path from "node:path";
import { flagValue } from "../lib/cli";
import { ROOT } from "../lib/paths";
import { loadReplay, type ReplaySide } from "./sim";
import { hash32 } from "./stats";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const want = Number(flagValue(argv, "sides", "24"));
	const out =
		flagValue(argv, "out", path.join(ROOT, "test/fixtures/timing/calibration-replay.json")) ?? "";
	const data = await loadReplay();
	const pick = data.sides
		.filter((s) => {
			const r = s.rows[0]?.row;
			return s.split === "holdout" && r?.tcGroup === "blitz" && r.rating >= 2600 && r.rating < 3000;
		})
		.sort((a, b) => hash32(a.key) - hash32(b.key))
		.slice(0, want);
	const sides: ReplaySide[] = pick.map((s) => ({
		...s,
		game: { ...s.game, plies: [] },
		rows: s.rows.map((rr) => ({ ...rr, movetime: [] })),
	}));
	await Bun.write(out, `${JSON.stringify({ sides })}\n`);
	console.log(
		`${sides.length} sides, ${sides.reduce((n, s) => n + s.rows.length, 0)} rows → ${out}`
	);
}

await main();
