/**
 * tools/calibration/crawl-chesscom/time-class-rule.ts — the check of `timeClassFor` against
 * chess.com's own `time_class` over every live standard game in the response cache, written to
 * `time-class-rule.json`.
 */

import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PATHS, parseTimeControl, timeClassFor } from "../common";
import { type ArchiveGame, acceptGame } from "./archive";
import { readCache } from "./http";

export interface RuleReport {
	rule: string;
	gamesChecked: number;
	mismatches: number;
	mismatchExamples: Array<{ time_control: string; time_class: string; predicted: string }>;
	/** time_control → chess.com time_class → count, over every distinct live standard game fetched. */
	counts: Record<string, Record<string, number>>;
	/** The same over the accepted (rated, standard, clocked) games only. */
	acceptedCounts: Record<string, Record<string, number>>;
	/** The estimated duration range (`base + 40 × inc`, s) chess.com assigned to each class. */
	effRange: Record<string, { min: number; max: number }>;
}

export function deriveTimeClassRule(): RuleReport {
	const counts: Record<string, Record<string, number>> = {};
	const acceptedCounts: Record<string, Record<string, number>> = {};
	const effRange: Record<string, { min: number; max: number }> = {};
	const seen = new Set<string>();
	let checked = 0;
	let mismatches = 0;
	const examples = new Map<
		string,
		{ time_control: string; time_class: string; predicted: string }
	>();
	for (const f of readdirSync(PATHS.cache)) {
		const entry = readCache(path.join(PATHS.cache, f));
		if (!entry || !/\/games\/\d{4}\/\d{2}$/.test(entry.url)) continue;
		const games = (entry.body as { games?: ArchiveGame[] } | null)?.games ?? [];
		for (const g of games) {
			if (!g.uuid || seen.has(g.uuid) || !g.time_control || !g.time_class) continue;
			if (g.rules !== "chess" || g.time_class === "daily") continue;
			seen.add(g.uuid);
			const tc = parseTimeControl(g.time_control);
			if (!tc) continue;
			const row = counts[g.time_control] ?? {};
			row[g.time_class] = (row[g.time_class] ?? 0) + 1;
			counts[g.time_control] = row;
			if (acceptGame(g)) {
				const arow = acceptedCounts[g.time_control] ?? {};
				arow[g.time_class] = (arow[g.time_class] ?? 0) + 1;
				acceptedCounts[g.time_control] = arow;
			}
			const eff = tc.baseS + 40 * tc.incS;
			const r = effRange[g.time_class] ?? { min: eff, max: eff };
			r.min = Math.min(r.min, eff);
			r.max = Math.max(r.max, eff);
			effRange[g.time_class] = r;
			checked++;
			const predicted = timeClassFor(tc.baseS, tc.incS);
			if (predicted !== g.time_class) {
				mismatches++;
				const key = `${g.time_control}:${g.time_class}`;
				if (!examples.has(key))
					examples.set(key, { time_control: g.time_control, time_class: g.time_class, predicted });
			}
		}
	}
	return {
		rule: "eff = base + 40*inc (s); bullet if eff < 180, blitz if eff < 600, else rapid",
		gamesChecked: checked,
		mismatches,
		mismatchExamples: [...examples.values()],
		counts,
		acceptedCounts,
		effRange,
	};
}

export function writeRule(): void {
	const report = deriveTimeClassRule();
	writeFileSync(PATHS.timeClassRule, `${JSON.stringify(report, null, "\t")}\n`);
	console.log(
		`time-class rule: ${report.gamesChecked} live games checked, ${report.mismatches} mismatches, ${Object.keys(report.counts).length} time controls`
	);
	for (const ex of report.mismatchExamples.slice(0, 20)) {
		console.log(`  mismatch ${ex.time_control}: chess.com ${ex.time_class}, rule ${ex.predicted}`);
	}
	console.log(`  eff ranges: ${JSON.stringify(report.effRange)}`);
}
