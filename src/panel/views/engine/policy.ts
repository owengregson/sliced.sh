/**
 * The Human-model block and the selection line, projected from a snapshot alone (no DOM): which
 * model picks the move at the active target, the Maia-3 answer and its fidelity meters.
 */

import { MAIA_INPUT } from "@core/constants/maia";
import type { PanelSnapshot } from "@core/constants/messages";
import { maiaSizeFor, usesMaia } from "@core/policy/maia-size";
import type { PillVariant } from "../../components/pill";
import { COPY } from "../../copy";

/** Selection policy at the active target and the network currently reported by the engine. */
export function selectionModel(snapshot: PanelSnapshot): string {
	const { strength } = snapshot.settings;
	const target = snapshot.opponent?.derivedTargetElo ?? strength.targetElo;
	const { selection } = COPY.engineView;
	if (usesMaia(target)) return selection.maia(selection.maiaSizes[maiaSizeFor(target)]);
	return snapshot.engine.variant === "full" ? selection.stockfishFull : selection.stockfishSmall;
}

/** What the Human-model block shows for a snapshot (exported for the view's tests). */
export interface PolicyBlock {
	name: string;
	pill: { variant: PillVariant; text: string };
	/** The last answer's pick probability and WDL, or why there is none. */
	detail: string;
	latency: string;
	meta: string;
	/** Identity of the recommendation the answer belongs to; a new one adds a sparkline sample. */
	sampleKey: string | null;
	sampleMs: number | null;
	/** The fidelity meters (§3.2) present on `rec.maia`, in template order; empty → the list hides. */
	meters: Array<{ row: PolicyMeterRow; value: string }>;
	/** H7.1: the history warning, or `null`. */
	warning: string | null;
}

export type PolicyMeterRow = keyof typeof COPY.engineView.policy.meters;

const PERCENT = 100;
const pct = (v: number): string => String(Math.round(v * PERCENT));
const ENTROPY_DIGITS = 2;
const KL_DIGITS = 3;

/**
 * The meters `rec.maia` carries, as rows: the history window and the rating asked at come with
 * every answer; the draw's own meters only when the selector drew from the model
 * (`rec.maia.meters`); the generate-and-verify pair only when that path ran.
 */
export function policyMeters(maia: NonNullable<PanelSnapshot["recommendation"]>["maia"]): {
	rows: PolicyBlock["meters"];
} {
	const { policy: copy } = COPY.engineView;
	const rows: PolicyBlock["meters"] = [];
	if (!maia) return { rows };
	if (maia.historyPlies !== undefined)
		rows.push({ row: "history", value: copy.historyValue(maia.historyPlies, MAIA_INPUT.history) });
	if (maia.selfElo !== undefined)
		rows.push({ row: "selfElo", value: copy.eloValue(Math.round(maia.selfElo)) });
	const m = maia.meters;
	if (m) {
		rows.push({ row: "entropy", value: m.entropy.toFixed(ENTROPY_DIGITS) });
		rows.push({ row: "railed", value: copy.pctValue(pct(m.railedMass)) });
		rows.push({ row: "unscored", value: copy.pctValue(pct(m.unscoredMass)) });
		rows.push({ row: "kl", value: m.klFromMaia.toFixed(KL_DIGITS) });
		rows.push({
			row: "rank",
			value: m.rank > 0 ? copy.rankValue(m.rank, m.survivors) : COPY.engineView.none,
		});
		if (m.candidates !== undefined && m.verifyDepth !== undefined)
			rows.push({ row: "candidates", value: copy.candidatesValue(m.candidates, m.verifyDepth) });
	}
	return { rows };
}

/** H7.1: the query carried fewer plies than the model's window, and the game is past that window. */
export function policyHistoryWarning(historyPlies: number | undefined, ply: number): string | null {
	if (historyPlies === undefined) return null;
	if (historyPlies >= MAIA_INPUT.history || ply <= MAIA_INPUT.history) return null;
	return COPY.engineView.policy.historyWarning;
}

/**
 * The Maia-3 block from the snapshot alone: the size the target maps to (or that Stockfish's own
 * policy applies at this rating), whether the last recommendation carried an answer, that
 * answer's pick probability and WDL, and its inference time — the value the sparkline tracks,
 * one point per recommendation the model answered (not per snapshot, which repeat it).
 */
export function policyBlock(snapshot: PanelSnapshot): PolicyBlock {
	const { strength } = snapshot.settings;
	const target = snapshot.opponent?.derivedTargetElo ?? strength.targetElo;
	const { policy: copy, selection, none } = COPY.engineView;
	const active = usesMaia(target);
	const rec = snapshot.recommendation;
	const maia = active ? rec?.maia : undefined;
	if (!active)
		return {
			name: copy.inactive,
			pill: { variant: "idle", text: copy.off },
			detail: none,
			latency: none,
			meta: none,
			sampleKey: null,
			sampleMs: null,
			meters: [],
			warning: null,
		};
	const name = copy.name(selection.maiaSizes[maia?.size ?? maiaSizeFor(target)]);
	if (!maia || !rec)
		return {
			name,
			pill: { variant: "idle", text: copy.waiting },
			detail: none,
			latency: none,
			meta: none,
			sampleKey: null,
			sampleMs: null,
			meters: [],
			warning: null,
		};
	const [loss, draw, win] = maia.wdl;
	const used = rec.chosen.source === "maia" && maia.p !== undefined;
	return {
		name,
		pill: { variant: "ok", text: copy.answered },
		detail: used ? copy.wdl(pct(win), pct(draw), pct(loss)) : copy.fallback,
		latency: maia.ms === undefined ? none : copy.latency(String(Math.round(maia.ms))),
		meta: used && maia.p !== undefined ? copy.pick(pct(maia.p)) : none,
		sampleKey: `${rec.fen}:${rec.computedAt}`,
		sampleMs: maia.ms ?? null,
		meters: policyMeters(maia).rows,
		warning: policyHistoryWarning(maia.historyPlies, snapshot.session.ply),
	};
}
