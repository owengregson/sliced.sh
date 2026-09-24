/**
 * tools/timing-calibration/cap-check.ts — does the fast-reply cap change the move played?
 *
 *     bun tools/timing-calibration/cap-check.ts [--per-cell 30] [--speed 3]
 *
 * The cap ends the own-move search early. It applies only when the answer is already decided: a
 * book answer, or an obvious recapture that the opponent's-turn analysis rated best. The Maia
 * strength calibration was fitted through the full search, so the cap must not change what is
 * played. This script takes replay rows where the rule applies and searches each twice with the
 * vendored Stockfish, once at the capped movetime and once at the full one. It uses the
 * production MultiPV and depth cap. Bun runs the engine single-threaded on plain SIMD, so both
 * movetimes are scaled by `--speed`. It then reports, per time class × rating band:
 *
 *   book       how often the book move's verdict differs between the two frames: the trap check
 *              (`isTrap` on `lineFacts`) and the mate or conversion guards (a mate or a decisive
 *              score on the best line)
 *   recapture  how often the best move differs, and how often the full search puts the recapture
 *              more than 50 cp (`SEARCH_BUDGET.mergeTieCp` × 3) below its best when the capped one
 *              does not, the cases where the full search could have chosen another move
 *
 * The output is `verify/cap-check.md`. Maia's own answer is not replayed. A policy that arrives
 * after a capped deadline is the one unmeasured channel, noted in the report.
 *
 * Parts: `cap-check/items.ts` (the capped positions and their budgets).
 */

import "../lib/defines";
import path from "node:path";
import { SEARCH_BUDGET } from "@core/constants/search";
import { isTrap, lineFacts } from "@core/strength/book/book-policy";
import type { EvalLine } from "@typedefs/engine";
import { flagValue } from "../lib/cli";
import { createRefereeEngine } from "../lib/engine/referee";
import { cappedItems } from "./cap-check/items";
import { PATHS } from "./common";
import { loadReplay } from "./sim";
import { hash32 } from "./stats";

const cpOf = (l: EvalLine | undefined): number =>
	l === undefined
		? 0
		: l.score.mate !== undefined
			? Math.sign(l.score.mate) * 10_000
			: (l.score.cp ?? 0);

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const perCell = Number(flagValue(argv, "per-cell", "30"));
	const speed = Number(flagValue(argv, "speed", "3"));
	const data = await loadReplay();
	const byCell = cappedItems(data);
	const engine = await createRefereeEngine({ newGameEachSearch: true, hashMb: 32 });
	const out: string[] = [
		"# fast-reply cap: does the move change?",
		"",
		`Engine movetimes ×${speed} (Bun single-thread plain SIMD vs the browser's pthreads). Per cell ≤ ${perCell} positions, hash order.`,
		"",
		"| tc | band | kind | n | verdict / best move differs | recapture rejected by full only |",
		"|---|---|---|---|---|---|",
	];
	const totals = { book: [0, 0], recapture: [0, 0, 0] };
	for (const [cell, list] of [...byCell].sort()) {
		const sample = list
			.sort((a, b) => hash32(a.fen + a.moves.length) - hash32(b.fen + b.moves.length))
			.slice(0, perCell);
		let differs = 0;
		let rejected = 0;
		for (const it of sample) {
			const spec = { fen: it.fen, moves: it.moves, multiPv: it.multiPv, depth: it.depth };
			const capped = await engine.search({ ...spec, movetimeMs: it.cap * speed });
			const full = await engine.search({ ...spec, movetimeMs: it.full * speed });
			if (it.kind === "book") {
				const verdict = (lines: EvalLine[]) =>
					`${isTrap(it.rating, lineFacts(it.move, lines))}|${Math.abs(cpOf(lines[0])) >= 10_000}`;
				if (verdict(capped.lines) !== verdict(full.lines)) differs++;
			} else {
				if (capped.lines[0]?.pvUci[0] !== full.lines[0]?.pvUci[0]) differs++;
				const loss = (lines: EvalLine[]) => {
					const own = lines.find((l) => l.pvUci[0] === it.move);
					return own ? cpOf(lines[0]) - cpOf(own) : Number.POSITIVE_INFINITY;
				};
				const tie = SEARCH_BUDGET.mergeTieCp * 3;
				if (loss(full.lines) > tie && loss(capped.lines) <= tie) rejected++;
			}
		}
		const [tc, band, kind] = cell.split("|");
		const n = sample.length;
		if (kind === "book") {
			totals.book[0] = (totals.book[0] ?? 0) + n;
			totals.book[1] = (totals.book[1] ?? 0) + differs;
		} else {
			totals.recapture[0] = (totals.recapture[0] ?? 0) + n;
			totals.recapture[1] = (totals.recapture[1] ?? 0) + differs;
			totals.recapture[2] = (totals.recapture[2] ?? 0) + rejected;
		}
		const pct = (x: number) => (n ? `${((100 * x) / n).toFixed(1)}%` : "–");
		out.push(
			`| ${tc} | ${band} | ${kind} | ${n} | ${pct(differs)} | ${kind === "book" ? "–" : pct(rejected)} |`
		);
		console.log(out[out.length - 1]);
	}
	const t = totals;
	out.push(
		"",
		`Totals: book ${t.book[1]}/${t.book[0]} verdicts differ; recapture ${t.recapture[1]}/${t.recapture[0]} best moves differ, ${t.recapture[2]}/${t.recapture[0]} recaptures rejected by the full search only.`,
		"",
		"Not measured: Maia's answer arriving after a capped deadline (the pipeline then selects with the engine's own policy). The book answer is chosen before the search, and a pondered recapture is the engine's own top line, so the channel only matters where Maia would have played something else.",
		""
	);
	await Bun.write(path.join(PATHS.verify, "cap-check.md"), out.join("\n"));
	console.log(out.slice(-4).join("\n"));
	engine.dispose();
	process.exit(0);
}

await main();
