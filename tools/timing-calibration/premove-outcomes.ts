/**
 * tools/timing-calibration/premove-outcomes.ts — how often an entered (queued) trade premove fires,
 * and how often the site drops it because the opponent played something else.
 *
 *     bun tools/timing-calibration/premove-outcomes.ts [--table shipped|FILE] [--split holdout] [--chains 2]
 *
 * The replay (`sim.ts`) only needs the arm for the reply that was played. Cancellations are the
 * arms for replies that were *not* played, so this walks every opponent turn of the replayed
 * sides. It takes the position after our move, predicts the opponent's reply from the cached frame
 * (`predictionLines`, `replyProbability`, `plausibleScore`, the same gates as `premoveCandidate`
 * with the calibrated `tradeReplyMinProb`), and picks the first predicted capture on a square where
 * an obvious recapture exists that `isQueueableCandidate` proves safe. That is the safe trade the
 * session would arm (the recapture is the one `premoveCandidate`'s own search would confirm in all
 * but a few percent of cases, see `cap-check.ts`). It is armed with the calibrated propensity and
 * entered if the opponent's recorded think left room for the arming searches, the entry delay and
 * the gesture. It then **executes** if the opponent's recorded move makes it legal (they captured on
 * that square) and is **dropped** otherwise. A dropped premove is the site's ordinary premove
 * cancellation: the piece snaps back at the moment the opponent's move lands, exactly as it does
 * for a human's.
 *
 * It writes `verify/premove-outcomes.md`: per time class × band, entered premoves per 100 opponent
 * turns, the executed and dropped shares, and on executed ones whether the opponent captured with
 * the predicted piece or another one (the recapture is then still the proven-safe exchange).
 *
 * Parts: `premove-outcomes/arm.ts` (the safe trade the session would arm).
 */

import "../lib/defines";
import path from "node:path";
import { applyMoves, legalMoves } from "@core/chess/san";
import { PREMOVE } from "@core/constants/books";
import { createRng } from "@core/rng";
import { calibrationTimeClass, premovePropensity } from "@core/timing/calibration";
import { samplePersona } from "@core/timing/persona-latents";
import { flagValue } from "../lib/cli";
import { PATHS, wideBandOf } from "./common";
import { loadFrames, toEvalLines } from "./frames";
import { safeTradeArm } from "./premove-outcomes/arm";
import { LATENCY, loadReplay } from "./sim";
import { loadTable } from "./verify";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const split = flagValue(argv, "split", "holdout") ?? "holdout";
	const chains = Number(flagValue(argv, "chains", "2"));
	const table = await loadTable(flagValue(argv, "table", "shipped") ?? "shipped");
	const data = await loadReplay();
	const frames = await loadFrames();
	const cells = new Map<
		string,
		{ turns: number; entered: number; executed: number; other: number; dropped: number }
	>();
	for (const side of data.sides) {
		if (split !== "all" && side.split !== split) continue;
		const g = side.game;
		const f = frames.get(g.gameId);
		const first = side.rows[0]?.row;
		if (!f || !first) continue;
		const cell = `${first.tc}|${wideBandOf(first.rating)}`;
		const c = cells.get(cell) ?? { turns: 0, entered: 0, executed: 0, other: 0, dropped: 0 };
		const timeClass = calibrationTimeClass(first.baseMs / 1000, first.incMs / 1000);
		for (let chain = 0; chain < chains; chain++) {
			const persona = samplePersona(`${side.key}:${chain}`, "balanced", first.rating);
			const piP = 1 / (1 + Math.exp(-persona.pi_p));
			const trade = premovePropensity(timeClass, first.rating, piP, table).trade;
			const rng = createRng(`outcomes:${side.key}:${chain}`);
			for (const rr of side.rows) {
				// The opponent turn before this row: our previous move is ply − 2, their reply ply − 1.
				const t = rr.row.ply;
				if (t < 2) continue;
				c.turns++;
				if (trade === undefined) continue;
				const afterMove = g.fens[t - 1] as string;
				const armed = safeTradeArm(afterMove, toEvalLines(f.plies[t - 1] ?? [], f.depth));
				if (!armed || !rng.chance(trade)) continue;
				const delay =
					PREMOVE.tradeQueueDelayMinMs +
					rng.next() * (PREMOVE.tradeQueueDelayMaxMs - PREMOVE.tradeQueueDelayMinMs);
				const oppThink = rr.row.oppThinkMs ?? 0;
				if (oppThink < LATENCY.armMs + delay + LATENCY.queueGestureMs) continue;
				c.entered++;
				const actual = g.ucis[t - 1] as string;
				const next = applyMoves(afterMove, [actual]);
				const fires = next !== null && legalMoves(next).includes(armed.premove);
				if (!fires) c.dropped++;
				else if (actual === armed.reply) c.executed++;
				else c.other++;
			}
		}
		cells.set(cell, c);
	}
	const lines = [
		"# queued trade premoves: executed vs dropped",
		"",
		`split ${split}; ${chains} chains; table ${flagValue(argv, "table", "shipped")}`,
		"",
		"| tc | band | opponent turns | entered / 100 turns | executed (predicted capture) | executed (another capture on the square) | dropped by the site |",
		"|---|---|---|---|---|---|---|",
	];
	for (const [cell, c] of [...cells].sort()) {
		const [tc, band] = cell.split("|");
		const pct = (x: number) => (c.entered ? `${((100 * x) / c.entered).toFixed(0)}%` : "–");
		lines.push(
			`| ${tc} | ${band} | ${c.turns} | ${((100 * c.entered) / Math.max(1, c.turns)).toFixed(1)} | ${pct(c.executed)} | ${pct(c.other)} | ${pct(c.dropped)} |`
		);
	}
	await Bun.write(path.join(PATHS.verify, "premove-outcomes.md"), `${lines.join("\n")}\n`);
	console.log(lines.join("\n"));
	process.exit(0);
}

await main();
