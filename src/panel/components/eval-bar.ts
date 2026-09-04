/**
 * Eval bar (Appendix F §5.5, §7.4): `role="meter"` 0–100 where the fill is White's expected
 * score from the WDL model (win + draw/2), not raw centipawns, so ±3 is not pinned at the edge.
 * Scores are given from White's point of view. Jumps larger than 30 % of the bar (blunders)
 * get the faster transition class; `stale` and `neutral` are visual states.
 */

import { UI_TIMINGS } from "@core/constants/ui";
import { clamp } from "@core/util/clamp";
import type { Eval } from "@typedefs/engine";
import { COPY } from "../copy";
import { instantiate, part } from "../template";
import html from "../views/templates/components/eval-bar.html?raw";

/** Win / draw / loss from White's point of view, as fractions (per-mille is accepted). */
export type Wdl = readonly [number, number, number];

export interface EvalBarState {
	/** From White's point of view. */
	score?: Eval;
	wdl?: Wdl;
	stale?: boolean;
	neutral?: boolean;
}

export interface EvalBarHandle {
	readonly el: HTMLElement;
	update(state: EvalBarState): void;
	dispose(): void;
}

const CP_PER_PAWN = 100;
/** Logistic fallback when no WDL is available (the rail and the WDL numbers should agree, so callers pass WDL). */
const LOGISTIC_SCALE_CP = 400;
const PERCENT = 100;

function normalizeWdl(wdl: Wdl): [number, number, number] {
	const sum = wdl[0] + wdl[1] + wdl[2];
	if (sum <= 0) return [0, 1, 0];
	return [wdl[0] / sum, wdl[1] / sum, wdl[2] / sum];
}

/** White's share of the bar, 0..1. */
export function whiteShare(score: Eval, wdl?: Wdl): number {
	if (score.mate !== undefined && score.mate !== 0) return score.mate > 0 ? 1 : 0;
	if (wdl) {
		const [w, d] = normalizeWdl(wdl);
		return clamp(w + d / 2, 0, 1);
	}
	const cp = score.cp ?? 0;
	return 1 / (1 + 10 ** (-cp / LOGISTIC_SCALE_CP));
}

/** "+1.34", "−0.50", "M5", "−M3" (White's point of view). */
export function formatScore(score: Eval): string {
	if (score.mate !== undefined && score.mate !== 0) {
		const m = COPY.eval.mateShort(Math.abs(score.mate));
		return score.mate > 0 ? m : `−${m}`;
	}
	const cp = score.cp ?? 0;
	const pawns = (Math.abs(cp) / CP_PER_PAWN).toFixed(2);
	if (cp > 0) return `+${pawns}`;
	if (cp < 0) return `−${pawns}`;
	return pawns;
}

/** Largest-remainder rounding so the three percentages sum to exactly 100. */
export function roundPercentages(wdl: Wdl): [number, number, number] {
	const parts = normalizeWdl(wdl).map((v) => v * PERCENT);
	const floors = parts.map((v) => Math.floor(v));
	let remainder = PERCENT - floors.reduce((a, b) => a + b, 0);
	const order = parts
		.map((v, i) => ({ i, frac: v - Math.floor(v) }))
		.sort((a, b) => b.frac - a.frac || a.i - b.i);
	for (const { i } of order) {
		if (remainder <= 0) break;
		floors[i] = (floors[i] ?? 0) + 1;
		remainder -= 1;
	}
	return [floors[0] ?? 0, floors[1] ?? 0, floors[2] ?? 0];
}

/** Appendix F §7.4: "White +1.34, 71% win, 22% draw, 7% loss" / "Mate in 5 for Black". */
export function evalValueText(score: Eval, wdl?: Wdl): string {
	if (score.mate !== undefined && score.mate !== 0) {
		return COPY.eval.mateFor(
			Math.abs(score.mate),
			score.mate > 0 ? COPY.eval.whiteName : COPY.eval.blackName
		);
	}
	const cp = score.cp ?? 0;
	const side = cp < 0 ? COPY.eval.blackName : COPY.eval.whiteName;
	const magnitude = `+${(Math.abs(cp) / CP_PER_PAWN).toFixed(2)}`;
	const label = `${side} ${cp === 0 ? (0).toFixed(2) : magnitude}`;
	if (!wdl) return label;
	const [w, d, l] = roundPercentages(wdl);
	// Percentages are from the advantaged side's point of view? No — always White's (§7.4 example).
	return COPY.eval.valueText(label, w, d, l);
}

export function createEvalBar(host: HTMLElement | null): EvalBarHandle {
	const el = instantiate(html);
	const white = part(el, ".sl-evalbar__white");
	const mate = part(el, ".sl-evalbar__mate");
	let lastShare = 0.5;

	function paint(share: number, jump: boolean): void {
		const pct = Math.round(share * PERCENT);
		white.style.height = `${pct}%`;
		el.setAttribute("aria-valuenow", String(pct));
		el.classList.toggle("sl-evalbar--jump", jump);
		lastShare = share;
	}

	function update(state: EvalBarState): void {
		if (state.neutral || !state.score) {
			el.classList.add("sl-evalbar--neutral");
			el.classList.remove(
				"sl-evalbar--live",
				"sl-evalbar--mate",
				"sl-evalbar--stale",
				"sl-evalbar--jump"
			);
			mate.hidden = true;
			el.removeAttribute("aria-valuetext");
			paint(0.5, false);
			return;
		}
		const score = state.score;
		const share = whiteShare(score, state.wdl);
		const isMate = score.mate !== undefined && score.mate !== 0;
		const jump = !state.stale && Math.abs(share - lastShare) > UI_TIMINGS.evalJumpFraction;
		el.classList.remove("sl-evalbar--neutral");
		el.classList.add("sl-evalbar--live");
		el.classList.toggle("sl-evalbar--mate", isMate);
		el.classList.toggle("sl-evalbar--stale", state.stale === true);
		el.setAttribute("aria-valuetext", evalValueText(score, state.wdl));
		if (isMate && score.mate !== undefined) {
			mate.hidden = false;
			mate.textContent = COPY.eval.mateShort(Math.abs(score.mate));
			mate.dataset.side = score.mate > 0 ? "white" : "black";
		} else {
			mate.hidden = true;
			delete mate.dataset.side;
		}
		paint(share, jump);
	}

	host?.append(el);
	return {
		el,
		update,
		dispose() {
			el.remove();
		},
	};
}
