/** tools/human-match/replay/report.ts — the per-bucket report as a markdown table. */

import type { BucketReport } from "./aggregate";

function fmt(v: number | null, digits = 3, scale = 1): string {
	return v === null ? "—" : (v * scale).toFixed(digits);
}

export function markdown(reports: BucketReport[], header: string[]): string {
	const cols = reports.map((r) => `${r.bucket}`);
	const rows: Array<[string, (r: BucketReport) => string]> = [
		["positions", (r) => `${r.n}`],
		["human move scored by the pool", (r) => fmt(r.humanScored, 1, 100)],
		["E[log q(m_human)]  (wrapper)", (r) => fmt(r.logQ)],
		["E[log p(m_human)]  (raw Maia)", (r) => fmt(r.logP)],
		["top-1 agreement q %", (r) => fmt(r.top1Q, 1, 100)],
		["top-1 agreement p %", (r) => fmt(r.top1P, 1, 100)],
		["E[q(m_human)]", (r) => fmt(r.expQ)],
		["E[p(m_human)]", (r) => fmt(r.expP)],
		["ACPL bot / human", (r) => `${fmt(r.bot.lossCp, 1)} / ${fmt(r.human.lossCp, 1)}`],
		[
			"inaccuracy % bot / human",
			(r) => `${fmt(r.bot.inaccuracy, 1, 100)} / ${fmt(r.human.inaccuracy, 1, 100)}`,
		],
		[
			"mistake % bot / human",
			(r) => `${fmt(r.bot.mistake, 1, 100)} / ${fmt(r.human.mistake, 1, 100)}`,
		],
		[
			"blunder % bot / human",
			(r) => `${fmt(r.bot.blunder, 1, 100)} / ${fmt(r.human.blunder, 1, 100)}`,
		],
		[
			"piece hangs per 40 moves bot / human",
			(r) => `${fmt(r.bot.hang, 2, 40)} / ${fmt(r.human.hang, 2, 40)}`,
		],
		["mate found % bot / human", (r) => `${fmt(r.bot.mate, 1, 100)} / ${fmt(r.human.mate, 1, 100)}`],
		[
			"same piece as last move % bot / human",
			(r) => `${fmt(r.bot.samePiece, 1, 100)} / ${fmt(r.human.samePiece, 1, 100)}`,
		],
		["lag-1 loss autocorrelation bot / human", (r) => `${fmt(r.bot.lag1)} / ${fmt(r.human.lag1)}`],
		["Maia share of draws %", (r) => fmt(r.meters.maiaShare, 1, 100)],
		["mean KL(draw ‖ Maia)", (r) => fmt(r.meters.kl, 4)],
		["mean railed mass", (r) => fmt(r.meters.railed)],
		["mean unscored mass", (r) => fmt(r.meters.unscored)],
	];
	const lines = [
		"# Human move-match replay",
		"",
		...header.map((h) => `- ${h}`),
		"",
		`| metric | ${cols.join(" | ")} |`,
		`|---|${cols.map(() => "---:").join("|")}|`,
		...rows.map(([name, cell]) => `| ${name} | ${reports.map(cell).join(" | ")} |`),
		"",
	];
	return lines.join("\n");
}
