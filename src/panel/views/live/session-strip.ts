/**
 * Session strip: overall game/timing totals, comparable search loss with its sample count,
 * and the diagnostic warning from sufficiently sampled games in the current reference cohort.
 * This is not independently analysed ACPL or an estimate of playing Elo. The pills show:
 * Telemetry (`clean` / `blur seen` / `mouse touched` from `snapshot.focus`), hand state
 * (`session.hand`) and the executor (Attached / Detached / Not started — hidden until auto-play
 * has been used this panel session).
 */

import type { PanelSnapshot } from "@core/constants/messages";
import { QUALITY_STATISTICS } from "@core/constants/telemetry";
import { checkQualityBand } from "@core/strength/quality-band";
import { normalizeQualityStats, qualityCohortKey } from "@core/strength/session-quality";
import { normalizeTimingStats } from "@core/timing/session-stats";
import type { IconName } from "@design/icons";
import { createPill, type PillHandle, type PillVariant } from "../../components/pill";
import { COPY, COPY_LIVE } from "../../copy";
import { instantiate, part } from "../../template";
import stripHtml from "../templates/live/session-strip.html?raw";

const MS = 1000;

export interface SessionStripState {
	snapshot: PanelSnapshot;
	/** Auto-play has been armed or the debugger attached at some point this session. */
	autoPlayUsed: boolean;
	/** The debugger was attached at some point (owned by the view; shared with the banner). */
	wasAttached: boolean;
}

export interface SessionStripHandle {
	readonly el: HTMLElement;
	update(state: SessionStripState): void;
	dispose(): void;
}

export interface PillView {
	variant: PillVariant;
	icon: IconName;
	text: string;
}

export function telemetryPill(focus: PanelSnapshot["focus"]): PillView {
	if (focus.realPointerEventsDuringHand > 0)
		return { variant: "danger", icon: "feedback.danger", text: COPY.telemetry.mouse };
	if (focus.blurSeenThisMove)
		return { variant: "warn", icon: "feedback.warning", text: COPY.telemetry.blur };
	return { variant: "ok", icon: "status.ok", text: COPY.telemetry.clean };
}

export function handPill(hand: PanelSnapshot["session"]["hand"]): PillView {
	switch (hand) {
		case "exploring":
		case "moving":
			return { variant: "thinking", icon: "exec.drag", text: COPY_LIVE.hand[hand] };
		case "paused":
			return { variant: "warn", icon: "exec.click", text: COPY_LIVE.hand.paused };
		case "detached":
			return { variant: "danger", icon: "status.detached", text: COPY_LIVE.hand.detached };
		default:
			return { variant: "idle", icon: "exec.drag", text: COPY_LIVE.hand.resting };
	}
}

export function executorPill(snapshot: PanelSnapshot, wasAttached: boolean): PillView {
	if (snapshot.executor.debuggerAttached)
		return { variant: "ok", icon: "status.attached", text: COPY.executor.attached };
	if (wasAttached || snapshot.session.hand === "detached")
		return { variant: "warn", icon: "status.detached", text: COPY.executor.detached };
	return { variant: "idle", icon: "status.offline", text: COPY.executor.notStarted };
}

/** The Elo the band is checked against: the derived target, else the slider (§13.6). */
export function bandTargetElo(snapshot: PanelSnapshot): number {
	return snapshot.opponent?.derivedTargetElo ?? snapshot.settings.strength.targetElo;
}

export function createSessionStrip(host: HTMLElement): SessionStripHandle {
	const el = instantiate(stripHtml);
	const stats = part(el, ".sl-live__stats");
	const band = part(el, ".sl-live__band");
	const warning = part(el, ".sl-live__band-warning");
	const pills = part(el, ".sl-live__strip-pills");
	host.append(el);

	const mk = (name: string, label: string): PillHandle => {
		const pill = createPill(pills, { variant: "idle", icon: null, text: "" });
		pill.el.dataset.pill = name;
		pill.el.setAttribute("aria-label", label);
		return pill;
	};
	const telemetry = mk("telemetry", COPY.telemetry.label);
	const hand = mk("hand", COPY_LIVE.hand.label);
	const executor = mk("executor", COPY_LIVE.executorLabel);

	function apply(pill: PillHandle, view: PillView, label: string): void {
		pill.update({ ...view, ariaLabel: `${label}: ${view.text}` });
	}

	function update(state: SessionStripState): void {
		const snap = state.snapshot;
		const s = normalizeTimingStats(normalizeQualityStats(snap.stats));
		const avg = s.timingSamples ? (s.avgThinkMs / MS).toFixed(1) : null;
		stats.textContent = COPY_LIVE.sessionNoStats(s.games, avg);
		stats.title = COPY_LIVE.timingSampleCount(s.timingSamples ?? 0);
		const key = qualityCohortKey(
			bandTargetElo(snap),
			snap.settings.strength,
			snap.session.timeControl
		);
		const quality = s.qualityCohorts?.find((cohort) => cohort.key === key);
		band.hidden = !quality;
		if (quality) {
			const check = checkQualityBand(bandTargetElo(snap), quality);
			band.textContent = COPY_LIVE.band.stats(
				Math.round(quality.top1Pct),
				Math.round(quality.acpl),
				quality.scoredMoves
			);
			band.dataset.band =
				check.state === "outside" ? "out" : check.state === "inside" ? "in" : check.state;
			band.setAttribute(
				"title",
				COPY_LIVE.band.target(
					check.band.top1[0],
					check.band.top1[1],
					check.band.acpl[0],
					check.band.acpl[1],
					QUALITY_STATISTICS.minGameMoves
				)
			);
		} else band.removeAttribute("title");
		const streak = quality?.outOfBandStreak ?? 0;
		warning.hidden = streak < QUALITY_STATISTICS.warningGames;
		warning.textContent = warning.hidden ? "" : COPY_LIVE.band.warning(streak);
		el.classList.toggle("sl-live__strip-row--warn", !warning.hidden);

		apply(telemetry, telemetryPill(snap.focus), COPY.telemetry.label);
		apply(hand, handPill(snap.session.hand), COPY_LIVE.hand.label);
		executor.el.hidden = !state.autoPlayUsed;
		apply(executor, executorPill(snap, state.wasAttached), COPY_LIVE.executorLabel);
	}

	return {
		el,
		update,
		dispose() {
			telemetry.dispose();
			hand.dispose();
			executor.dispose();
			el.remove();
		},
	};
}
