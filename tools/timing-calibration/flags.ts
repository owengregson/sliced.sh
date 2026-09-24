/**
 * tools/timing-calibration/flags.ts — the closed-loop clock check: does the calibrated bot run out
 * of time more often than the humans, and how does its clock end?
 *
 *     bun tools/timing-calibration/flags.ts [--tables identity,shipped,FILE…] [--split holdout] [--chains 2]
 *
 * Each side is replayed on the bot's **own** clock (`SimOptions.ownClock`). The context, budget,
 * caps and clock policies see what the bot has left, and a chain whose clock reaches zero before
 * the game's last recorded move counts as flagged. The positions and the opponent's moves and clock
 * stay the recorded ones, so this checks the budget, not a game result. Per time-control group ×
 * 400-Elo band it reports:
 *
 *   flagged         bot (per chain) vs the humans on the same games (their last recorded clock
 *                   minus think plus increment ≤ 0.1 s)
 *   spend           the bot's total think over the humans' on the same moves (median over sides)
 *   final clock     the clock left after the side's last recorded move, as a fraction of the base:
 *                   10/50/90 % quantiles, bot vs human
 *
 * It writes `verify/flags.md`.
 */

import "../lib/defines";
import path from "node:path";
import { TIMING_CALIBRATION_IDENTITY } from "@core/constants/timing-calibration";
import { flagValue } from "../lib/cli";
import { PATHS, wideBandOf } from "./common";
import { loadReplay, simulate } from "./sim";
import { quantileSorted } from "./stats";
import { loadTable } from "./verify";

interface Acc {
	sides: number;
	humanFlags: number;
	humanFinal: number[];
	draws: number;
	botFlags: number;
	botFinal: number[];
	spend: number[];
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const split = flagValue(argv, "split", "holdout") ?? "holdout";
	const chains = Number(flagValue(argv, "chains", "2"));
	const specs = (flagValue(argv, "tables", "identity,shipped") ?? "identity,shipped").split(",");
	// `SPEC@shipped` replays the shipped band set's outputs (`heads.jsonl`) instead of `SL_HEADS_TAG`'s.
	const current = await loadReplay();
	const shipped =
		process.env.SL_HEADS_TAG && specs.some((s) => s.endsWith("@shipped"))
			? await loadReplay({ headsTag: "" })
			: current;
	const pick = (spec: string) =>
		(spec.endsWith("@shipped") ? shipped : current).sides.filter(
			(s) => split === "all" || s.split === split
		);
	const sides = pick("");
	const lines = [
		"# closed-loop clock check",
		"",
		`split ${split}; ${chains} chains per side; the bot on its own clock (positions and opponent as recorded)`,
		"",
		"| run | tc | band | sides | flagged h / bot | spend bot / h (median) | final clock q10 h / bot | q50 h / bot | q90 h / bot |",
		"|---|---|---|---|---|---|---|---|---|",
	];
	const cellOf = (s: (typeof sides)[number]) => {
		const r = s.rows[0]?.row;
		return r ? `${r.tcGroup}|${wideBandOf(r.rating)}` : "";
	};
	for (const spec of specs) {
		const name = spec.replace(/@shipped$/, "");
		const table = name === "identity" ? TIMING_CALIBRATION_IDENTITY : await loadTable(name);
		const production = name !== "identity";
		const runSides = pick(spec);
		const flagged = new Set<string>();
		const lastClock = new Map<string, number>();
		const spent = new Map<string, number>();
		await simulate(
			{ sides: runSides },
			{
				table,
				fastReply: production,
				hover: production,
				chains,
				seed: "flags",
				ownClock: true,
				onFlag: (key, chain) => flagged.add(`${key}:${chain}`),
				onClock: (key, chain, _ply, clockMs, thinkMs) => {
					lastClock.set(`${key}:${chain}`, clockMs);
					spent.set(`${key}:${chain}`, (spent.get(`${key}:${chain}`) ?? 0) + thinkMs);
				},
			}
		);
		const cells = new Map<string, Acc>();
		for (const s of sides) {
			const first = s.rows[0]?.row;
			const last = s.rows[s.rows.length - 1]?.row;
			if (!first || !last) continue;
			const key = cellOf(s);
			const a = cells.get(key) ?? {
				sides: 0,
				humanFlags: 0,
				humanFinal: [],
				draws: 0,
				botFlags: 0,
				botFinal: [],
				spend: [],
			};
			a.sides++;
			const humanFinal = last.clockMs - last.thinkMs + last.incMs;
			if (humanFinal <= 100) a.humanFlags++;
			a.humanFinal.push(Math.max(0, humanFinal) / first.baseMs);
			const humanSpend = s.rows.reduce((t, rr) => t + rr.row.thinkMs, 0);
			for (let c = 0; c < chains; c++) {
				const id = `${s.key}:${c}`;
				a.draws++;
				if (flagged.has(id)) a.botFlags++;
				a.botFinal.push(Math.max(0, lastClock.get(id) ?? 0) / first.baseMs);
				if (!flagged.has(id) && humanSpend > 0) a.spend.push((spent.get(id) ?? 0) / humanSpend);
			}
			cells.set(key, a);
		}
		for (const [key, a] of [...cells].sort()) {
			const [tc, band] = key.split("|");
			const q = (xs: number[], p: number) => {
				const sorted = [...xs].sort((x, y) => x - y);
				return sorted.length ? quantileSorted(sorted, p).toFixed(2) : "–";
			};
			const pct = (x: number, n: number) => (n ? `${((100 * x) / n).toFixed(1)}%` : "–");
			lines.push(
				`| ${spec} | ${tc} | ${band} | ${a.sides} | ${pct(a.humanFlags, a.sides)} / ${pct(a.botFlags, a.draws)} | ${q(a.spend, 0.5)} | ${q(a.humanFinal, 0.1)} / ${q(a.botFinal, 0.1)} | ${q(a.humanFinal, 0.5)} / ${q(a.botFinal, 0.5)} | ${q(a.humanFinal, 0.9)} / ${q(a.botFinal, 0.9)} |`
			);
		}
		console.log(`${spec}: done`);
	}
	await Bun.write(path.join(PATHS.verify, "flags.md"), `${lines.join("\n")}\n`);
	console.log(lines.join("\n"));
	process.exit(0);
}

await main();
