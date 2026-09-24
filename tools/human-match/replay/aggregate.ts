/**
 * tools/human-match/replay/aggregate.ts — row results pooled per rating bucket: the primary
 * agreement metrics, the secondary loss facts for the bot and the humans side by side, and the
 * selector's meters.
 */

import { Mean, pearson } from "../../lib/stats";
import { BUCKETS } from "./corpus";
import { MOVE_FACT_KEYS, type MoveFacts, type RowResult } from "./replay-row";

export interface BucketReport {
	bucket: number;
	n: number;
	humanScored: number;
	logQ: number | null;
	logP: number | null;
	top1Q: number | null;
	top1P: number | null;
	expQ: number | null;
	expP: number | null;
	bot: Record<keyof MoveFacts, number | null> & { lag1: number | null };
	human: Record<keyof MoveFacts, number | null> & { lag1: number | null };
	meters: {
		kl: number | null;
		railed: number | null;
		unscored: number | null;
		maiaShare: number | null;
	};
}

/** Lag-1 pairs of loss along each game's own-move sequence, for the bot and the humans. */
function lagPairs(rows: RowResult[]): {
	bot: Array<[number, number]>;
	human: Array<[number, number]>;
} {
	const byGame = new Map<string, RowResult[]>();
	for (const r of rows) {
		const key = r.gameId ?? r.id;
		const list = byGame.get(key) ?? [];
		list.push(r);
		byGame.set(key, list);
	}
	const bot: Array<[number, number]> = [];
	const human: Array<[number, number]> = [];
	for (const list of byGame.values()) {
		list.sort((a, b) => a.ply - b.ply);
		for (let i = 1; i < list.length; i++) {
			const a = list[i - 1]!;
			const b = list[i]!;
			bot.push([a.bot.lossCp, b.bot.lossCp]);
			if (a.human && b.human) human.push([a.human.lossCp, b.human.lossCp]);
		}
	}
	return { bot, human };
}

export function aggregate(results: RowResult[], draws: number): BucketReport[] {
	const out: BucketReport[] = [];
	for (const bucket of BUCKETS) {
		const rows = results.filter((r) => r.bucket === bucket);
		if (rows.length === 0) continue;
		const m = {
			logQ: new Mean(),
			logP: new Mean(),
			top1Q: new Mean(),
			top1P: new Mean(),
			expQ: new Mean(),
			expP: new Mean(),
			scored: new Mean(),
			kl: new Mean(),
			railed: new Mean(),
			unscored: new Mean(),
			maiaShare: new Mean(),
		};
		const keys = MOVE_FACT_KEYS;
		const bot = Object.fromEntries(keys.map((k) => [k, new Mean()])) as Record<keyof MoveFacts, Mean>;
		const human = Object.fromEntries(keys.map((k) => [k, new Mean()])) as Record<
			keyof MoveFacts,
			Mean
		>;
		for (const r of rows) {
			const qh = r.q.get(r.humanMove) ?? 0;
			// Add-half smoothing over the legal moves keeps log q finite for an undrawn human move.
			m.logQ.add(Math.log((qh * draws + 0.5) / (draws + 0.5 * r.legal)));
			m.logP.add(Math.log(Math.max(r.pHuman, 1e-9)));
			m.top1Q.add(r.topQ === r.humanMove ? 1 : 0);
			m.top1P.add(r.topP === r.humanMove ? 1 : 0);
			m.expQ.add(qh);
			m.expP.add(r.pHuman);
			m.scored.add(r.humanScored ? 1 : 0);
			if (r.meters.n > 0) {
				m.kl.add(r.meters.kl / r.meters.n);
				m.railed.add(r.meters.railed / r.meters.n);
				m.unscored.add(r.meters.unscored / r.meters.n);
			}
			m.maiaShare.add((r.sources.get("maia") ?? 0) / draws);
			for (const k of keys) {
				if (k === "mate" && !r.hasMate) continue;
				if (k === "samePiece" && !r.hasPrev) continue;
				bot[k].add(r.bot[k]);
				if (r.human) human[k].add(r.human[k]);
			}
		}
		// Lag-1 autocorrelation of loss along each game's own-move sequence.
		const pairs = lagPairs(rows);
		const facts = (src: Record<keyof MoveFacts, Mean>, lag1: number | null) =>
			Object.assign(
				Object.fromEntries(keys.map((k) => [k, src[k].value])) as Record<
					keyof MoveFacts,
					number | null
				>,
				{ lag1 }
			);
		out.push({
			bucket,
			n: rows.length,
			humanScored: m.scored.value ?? 0,
			logQ: m.logQ.value,
			logP: m.logP.value,
			top1Q: m.top1Q.value,
			top1P: m.top1P.value,
			expQ: m.expQ.value,
			expP: m.expP.value,
			bot: facts(bot, pearson(pairs.bot)),
			human: facts(human, pearson(pairs.human)),
			meters: {
				kl: m.kl.value,
				railed: m.railed.value,
				unscored: m.unscored.value,
				maiaShare: m.maiaShare.value,
			},
		});
	}
	return out;
}
