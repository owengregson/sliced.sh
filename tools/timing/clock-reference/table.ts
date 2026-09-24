/** tools/timing/clock-reference/table.ts — the reference as the markdown tables the CLI prints. */

import { BUCKETS, MIDDLEGAME, OVERALL } from "./buckets";
import type { ClockReference } from "./reference";

export function referenceTable(reference: ClockReference): string {
	const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;
	const lines = [
		`window: ${reference.window.games} games, ${reference.window.timeControl}, ` +
			`our Elo ${reference.window.ourEloRange.join("–")}, ` +
			`opp Elo ${reference.window.oppEloRange.join("–")}, ` +
			`${reference.window.lostOnTime} lost on time`,
		"",
		"| fraction of base | human n | human median | human mean | human <1 s | human >10 s | our median | our mean | our <1 s |",
		"|---|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const label of [...BUCKETS.map((b) => b.label), MIDDLEGAME, OVERALL]) {
		const h = reference.human[label];
		const s = reference.sliced[label];
		if (!h || !s) continue;
		lines.push(
			`| ${label} | ${h.n} | ${h.medianS.toFixed(2)} | ${h.meanS.toFixed(2)} | ${pct(h.shareUnder1s)} | ` +
				`${pct(h.shareOver10s)} | ${s.medianS.toFixed(2)} | ${s.meanS.toFixed(2)} | ${pct(s.shareUnder1s)} |`
		);
	}
	lines.push(
		"",
		"| after move | our games | ours | human games | human |",
		"|---|---:|---:|---:|---:|"
	);
	for (const m of reference.clockLeftAfterMove)
		lines.push(`| ${m.move} | ${m.ourGames} | ${m.oursS} | ${m.humanGames} | ${m.humanS} |`);
	const critical = reference.human[BUCKETS[1]?.label ?? ""];
	if (critical)
		lines.push(
			"",
			`human deciles in ${BUCKETS[1]?.label} (n=${critical.n}): ` +
				Object.entries(critical.percentiles)
					.map(([k, v]) => `${k} ${v}`)
					.join(", ")
		);
	const ours = reference.sliced[BUCKETS[1]?.label ?? ""];
	if (ours)
		lines.push(
			`ours   deciles in ${BUCKETS[1]?.label} (n=${ours.n}): ` +
				Object.entries(ours.percentiles)
					.map(([k, v]) => `${k} ${v}`)
					.join(", ")
		);
	return lines.join("\n");
}
