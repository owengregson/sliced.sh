/**
 * Eval section: a fixed horizontal White-relative rail beneath the two player clocks,
 * clocks with the active caret and the < 20 s danger, the eval numeral with
 * its sign and `M5` / `−M3` mate form, and the fixed-width WDL groups. Engine scores arrive
 * from the side to move (`Recommendation.eval`, `.wdl`); everything is shown from White's
 * point of view through `toWhitePov` (Task 13).
 */

import { sideToMove } from "@core/chess/fen";
import type { PanelSnapshot } from "@core/constants/messages";
import { toWhitePov } from "@core/engine/snapshot";
import type { Eval } from "@typedefs/engine";
import type { Color } from "@typedefs/game";
import { type ClockHandle, createClock } from "../../components/clock";
import {
	createEvalBar,
	type EvalBarHandle,
	evalValueText,
	formatScore,
	roundPercentages,
	type Wdl,
} from "../../components/eval-bar";
import { COPY, COPY_LIVE } from "../../copy";
import { mountIcons } from "../../icons-mount";
import { instantiate, part } from "../../template";
import rowHtml from "../templates/live/row.html?raw";

export interface EvalView {
	/** White's point of view, or null before any recommendation. */
	score: Eval | null;
	wdl: Wdl | null;
}

/** `Recommendation.eval` / `.wdl` (side to move) → White's point of view. */
export function evalFromRecommendation(
	rec: PanelSnapshot["recommendation"] | PanelSnapshot["session"]["evaluation"]
): EvalView {
	if (!rec) return { score: null, wdl: null };
	const stm: Color = sideToMove(rec.fen) ?? "w";
	const score = toWhitePov(rec.eval, stm);
	let wdl: Wdl | null = null;
	if (rec.wdl) {
		const [w, d, l] = rec.wdl;
		wdl = stm === "w" ? [w, d, l] : [l, d, w];
	}
	return { score, wdl };
}

export interface EvalSectionOptions {
	rail: HTMLElement;
	opponentSlot: HTMLElement;
	meSlot: HTMLElement;
	evalRow: HTMLElement;
}

export interface EvalSectionState {
	snapshot: PanelSnapshot;
	/** WDL folded into the tooltip; numeral inline in the opponent row (§8.2 step 3, §4.5). */
	inline: boolean;
	compact: boolean;
}

export interface EvalSectionHandle {
	update(state: EvalSectionState): void;
	dispose(): void;
}

interface Row {
	el: HTMLElement;
	caret: HTMLElement;
	name: HTMLElement;
	rating: HTMLElement;
	clock: ClockHandle;
	inline: HTMLElement;
}

function makeRow(slot: HTMLElement, kind: "opponent" | "me"): Row {
	const el = instantiate(rowHtml);
	el.dataset.row = kind;
	const row: Row = {
		el,
		caret: part(el, ".sl-live__caret"),
		name: part(el, ".sl-live__name"),
		rating: part(el, ".sl-live__rating"),
		clock: createClock(part(el, ".sl-live__clock")),
		inline: part(el, ".sl-live__eval-inline"),
	};
	row.clock.el.setAttribute(
		"aria-label",
		kind === "opponent" ? COPY_LIVE.clock.opponent : COPY_LIVE.clock.you
	);
	mountIcons(el);
	slot.append(el);
	return row;
}

const other = (c: Color): Color => (c === "w" ? "b" : "w");

export function createEvalSection(options: EvalSectionOptions): EvalSectionHandle {
	const bar: EvalBarHandle = createEvalBar(options.rail);
	const opponent = makeRow(options.opponentSlot, "opponent");
	const me = makeRow(options.meSlot, "me");
	const score = part(options.evalRow, ".sl-live__eval-score");
	const wdlHost = part(options.evalRow, ".sl-live__wdl");
	const wdlParts = {
		w: part(wdlHost, '[data-wdl="w"]'),
		d: part(wdlHost, '[data-wdl="d"]'),
		l: part(wdlHost, '[data-wdl="l"]'),
	};
	const label = part(options.evalRow, ".sl-live__eval-label");
	const chip = part(options.evalRow, ".sl-live__eval-chip");
	let lastScoreText = "";
	let lastEvaluation: EvalView = { score: null, wdl: null };
	let lastGameId: string | null | undefined;
	let lastPly = 0;

	function renderRow(row: Row, color: Color, state: EvalSectionState): void {
		const { session } = state.snapshot;
		row.el.dataset.color = color;
		const active = session.sideToMove === color;
		row.el.dataset.active = active ? "true" : "false";
		row.caret.hidden = !active;
		const clock = session.clocks?.[color];
		row.clock.update({
			ms: clock ? clock.ms : null,
			active,
			running: clock?.running === true && session.state.startsWith("live:"),
			...(session.clocksAt !== undefined ? { at: session.clocksAt } : {}),
		});
	}

	function update(state: EvalSectionState): void {
		const snap = state.snapshot;
		const myColor: Color = snap.session.myColor ?? "w";
		const theirs = other(myColor);
		// The horizontal rail is always White on the left and Black on the right, matching
		// the White-relative score and WDL regardless of board orientation.
		renderRow(opponent, theirs, state);
		renderRow(me, myColor, state);
		opponent.name.textContent =
			snap.opponent?.name ?? COPY.eval[theirs === "w" ? "whiteName" : "blackName"];
		opponent.name.title = opponent.name.textContent;
		const rating = snap.opponent?.ratingEstimate;
		opponent.rating.textContent = rating === null || rating === undefined ? "" : String(rating);
		opponent.rating.hidden = rating === null || rating === undefined || state.compact;
		me.name.textContent = COPY_LIVE.you;
		me.rating.textContent = "";
		me.rating.hidden = true;

		if (snap.session.gameId !== lastGameId || snap.session.ply < lastPly)
			lastEvaluation = { score: null, wdl: null };
		lastGameId = snap.session.gameId;
		lastPly = snap.session.ply;
		const recommendationIsCurrent =
			snap.session.state !== "live:opponent-turn" && snap.session.state !== "live:my-turn:analysing";
		const current = evalFromRecommendation(
			snap.session.evaluation ?? (recommendationIsCurrent ? snap.recommendation : undefined)
		);
		if (current.score) lastEvaluation = current;
		const view = current.score ? current : lastEvaluation;
		const stale =
			!snap.settings.enabled ||
			!current.score ||
			(snap.engine.state !== "searching" && snap.engine.state !== "ready");
		const evalBarOn = snap.settings.display.evalBar;
		bar.el.hidden = !evalBarOn;
		options.rail.hidden = !evalBarOn;
		if (view.score) {
			bar.update({ score: view.score, ...(view.wdl ? { wdl: view.wdl } : {}), stale });
		} else bar.update({ neutral: true });

		const text = view.score ? formatScore(view.score) : COPY.eval.pending;
		if (text !== lastScoreText) {
			score.textContent = text;
			lastScoreText = text;
		}
		const pct = view.wdl ? roundPercentages(view.wdl) : null;
		wdlParts.w.textContent = pct ? COPY.eval.wdlWin(pct[0]) : "";
		wdlParts.d.textContent = pct ? COPY.eval.wdlDraw(pct[1]) : "";
		wdlParts.l.textContent = pct ? COPY.eval.wdlLoss(pct[2]) : "";
		wdlHost.hidden = !pct || state.inline || state.compact;
		const valueText = view.score ? evalValueText(view.score, view.wdl ?? undefined) : "";

		// The evaluation chip has one fixed slot in every layout and turn state. Retain the
		// latest known evaluation while the next position is being searched, clearly labelled.
		options.evalRow.hidden = !evalBarOn;
		chip.dataset.evaluation = !view.score ? "pending" : stale ? "cached" : "current";
		label.textContent = view.score && stale ? COPY.eval.cachedLabel : COPY.eval.label;
		const accessible = view.score
			? stale
				? COPY.eval.cached(valueText)
				: valueText
			: COPY.eval.pendingLabel;
		chip.setAttribute("aria-label", accessible);
		chip.setAttribute("title", accessible);
		opponent.inline.hidden = true;
		opponent.inline.textContent = "";
		me.inline.hidden = true;
	}

	return {
		update,
		dispose() {
			bar.dispose();
			opponent.clock.dispose();
			me.clock.dispose();
			opponent.el.remove();
			me.el.remove();
		},
	};
}
