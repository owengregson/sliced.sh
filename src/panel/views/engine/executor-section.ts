/** The Executor rows (debugger, target, input mode, last action + phase timeline), license and session. */

import type { PanelSnapshot } from "@core/constants/messages";
import { normalizeTimingStats } from "@core/timing/session-stats";
import type { ExecutionResult } from "@typedefs/game";
import { COPY, SETTINGS_COPY } from "../../copy";
import { instantiate, part } from "../../template";
import phaseHtml from "../templates/engine-phase.html?raw";
import { seconds } from "./format";

export interface ExecutorSection {
	render(snapshot: PanelSnapshot): void;
}

export function createExecutorSection(el: HTMLElement): ExecutorSection {
	const valueCell = (row: string): HTMLElement => part(el, `[data-row="${row}"] .sl-engine__value`);
	const debuggerFlag = part(el, '[data-row="debugger"] .sl-engine__flag');
	const timeline = part(el, ".sl-engine__timeline");
	const session = part(el, ".sl-engine__session");

	function renderTimeline(execution: ExecutionResult | undefined): void {
		timeline.replaceChildren();
		if (!execution) return;
		for (const phase of execution.timeline) {
			const chip = instantiate(phaseHtml);
			chip.textContent = COPY.engineView.phase(phase.phase, Math.round(phase.endMs - phase.startMs));
			timeline.append(chip);
		}
	}

	return {
		render(snapshot) {
			const { settings } = snapshot;
			const attached = snapshot.executor.debuggerAttached;
			valueCell("debugger").textContent = attached ? COPY.executor.attached : COPY.executor.detached;
			debuggerFlag.hidden = !attached;
			const site = snapshot.session.site ?? snapshot.site;
			const gameId = snapshot.session.gameId;
			valueCell("target").textContent =
				site && gameId
					? COPY.engineView.target(gameId)
					: site
						? COPY.engineView.site
						: COPY.engineView.none;
			const execution = snapshot.session.lastExecution;
			// 2026-09-15: the timing presets went, so the row is the input style alone.
			valueCell("input").textContent = SETTINGS_COPY.options.inputMode[settings.execution.inputMode];
			valueCell("last").textContent = execution
				? COPY.engineView.lastAction(
						// Every committed move is a drag, and the word the user reads comes from
						// `copy.ts` (C5) — never from the service worker's own `tier` value.
						COPY.execution.drag,
						seconds(execution.elapsedMs),
						COPY.engineView.outcomes[execution.outcome]
					)
				: COPY.executor.notStarted;
			renderTimeline(execution);
			const raw = snapshot.license.rawStatus ?? snapshot.license.status;
			valueCell("license").textContent = COPY.engineView.licenseVerdict(
				raw,
				snapshot.license.rawStatus !== undefined && raw !== snapshot.license.status
			);
			const measuredTiming = normalizeTimingStats(snapshot.stats);
			session.textContent = COPY.engineView.session(
				snapshot.stats.games,
				snapshot.stats.moves,
				measuredTiming.timingSamples ? seconds(measuredTiming.avgThinkMs) : null
			);
		},
	};
}
