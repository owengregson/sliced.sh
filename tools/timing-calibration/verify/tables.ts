/**
 * tools/timing-calibration/verify/tables.ts — the markdown the verification reports share: the
 * per-cell quantile table and the replayed-clock spend table.
 */

import type { ReplayData } from "../sim";
import type { CellResult } from "./cells";

export const f2 = (v: number | undefined) =>
	v !== undefined && Number.isFinite(v) ? v.toFixed(2) : "–";
export const pct = (v: number | undefined) =>
	v !== undefined && Number.isFinite(v) ? `${Math.round(100 * v)}%` : "–";

export function cellTable(results: readonly CellResult[]): string {
	const lines = [
		"| tc | band | situation | n (h/bot) | median h / bot [bot CI] | q10 h / bot | q25 h / bot | q75 h / bot | q90 h / bot | premove h / bot [bot CI] | < 1 s h / bot | CRPS | KS | AUC | bot paths q/f/p |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const c of results) {
		const h = c.cmp.human;
		const b = c.cmp.bot;
		const total = c.paths.queued + c.paths.fire + c.paths.plan || 1;
		lines.push(
			`| ${c.tcGroup} | ${c.band} | ${c.situation} | ${h.n}/${b.n} | ${f2(h.q[2])} / ${f2(b.q[2])} [${f2(b.ci.q[2]?.lo)}, ${f2(b.ci.q[2]?.hi)}] | ${f2(h.q[0])} / ${f2(b.q[0])} | ${f2(h.q[1])} / ${f2(b.q[1])} | ${f2(h.q[3])} / ${f2(b.q[3])} | ${f2(h.q[4])} / ${f2(b.q[4])} | ${pct(h.premove)} / ${pct(b.premove)} [${pct(b.ci.premove.lo)}, ${pct(b.ci.premove.hi)}] | ${pct(h.sub1)} / ${pct(b.sub1)} | ${f2(c.cmp.crps)} | ${f2(c.cmp.ks)} | ${f2(c.cmp.auc)} | ${pct(c.paths.queued / total)}/${pct(c.paths.fire / total)}/${pct(c.paths.plan / total)} |`
		);
	}
	return lines.join("\n");
}

/**
 * Clock spend: replaying the bot's own clock over each side (base, minus each recorded think, plus
 * the increment), how often it would have flagged before the game's last recorded move, against
 * the humans' own clocks on the same games, and the bot's total spend over the humans' (median over
 * sides). The positions are the humans' own, so this is a check on the budget, not a game outcome.
 */
export function spendReport(
	data: ReplayData,
	results: Map<string, { bot: number[] }>,
	split: string
): string {
	const groups = new Map<
		string,
		{ sides: number; botFlags: number; draws: number; humanFlags: number; ratios: number[] }
	>();
	for (const side of data.sides) {
		if (split !== "all" && side.split !== split) continue;
		const first = side.rows[0]?.row;
		if (!first) continue;
		const g = groups.get(first.tcGroup) ?? {
			sides: 0,
			botFlags: 0,
			draws: 0,
			humanFlags: 0,
			ratios: [],
		};
		g.sides++;
		const last = side.rows[side.rows.length - 1]?.row;
		if (last && last.clockMs - last.thinkMs + last.incMs <= 100) g.humanFlags++;
		const chains = results.get(first.id)?.bot.length ?? 0;
		for (let c = 0; c < chains; c++) {
			let clock = first.baseMs;
			let flagged = false;
			let bot = 0;
			let human = 0;
			for (const rr of side.rows) {
				const ms = results.get(rr.row.id)?.bot[c] ?? rr.row.thinkMs;
				bot += ms;
				human += rr.row.thinkMs;
				clock += rr.row.incMs - ms;
				if (clock <= 0) flagged = true;
			}
			g.draws++;
			if (flagged) g.botFlags++;
			if (human > 0) g.ratios.push(bot / human);
		}
		groups.set(first.tcGroup, g);
	}
	const lines = [
		"| tc | sides | human flagged | bot flagged (replayed clock) | bot / human spend (median) |",
		"|---|---|---|---|---|",
	];
	for (const [tc, g] of groups) {
		const r = [...g.ratios].sort((a, b) => a - b);
		lines.push(
			`| ${tc} | ${g.sides} | ${pct(g.humanFlags / g.sides)} | ${pct(g.botFlags / Math.max(1, g.draws))} | ${f2(r[Math.floor(r.length / 2)])} |`
		);
	}
	return lines.join("\n");
}
