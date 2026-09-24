/** The Engine block: version · NNUE, threads/hash, selection model, nps + depth, status pill, sparkline. */

import type { PanelSnapshot } from "@core/constants/messages";
import { UI_TIMINGS } from "@core/constants/ui";
import { createPill, type PillHandle } from "../../components/pill";
import { COPY } from "../../copy";
import { enginePill, statusIcon } from "../../engine-status";
import { part } from "../../template";
import { formatNps, nnueNames } from "./format";
import { selectionModel } from "./policy";
import { createSparkline } from "./sparkline";

export interface EngineStatusSection {
	render(snapshot: PanelSnapshot): void;
	dispose(): void;
}

export function createEngineStatusSection(el: HTMLElement): EngineStatusSection {
	const version = part(el, ".sl-engine__version");
	const resources = part(el, ".sl-engine__resources");
	const selection = part(el, ".sl-engine__selection");
	const nps = part(el, ".sl-engine__nps");
	const depth = part(el, ".sl-engine__depth");
	const sparkline = createSparkline(part(el, ".sl-engine__spark:not(.sl-engine__spark--policy)"));
	const statusPill: PillHandle = createPill(part(el, ".sl-engine__status"), {
		variant: "idle",
		icon: "status.idle",
		text: COPY.engine.loading,
	});
	/** The nps sparkline samples once per `UI_TIMINGS.sparklineSampleMs`, not once per snapshot. */
	let lastSampleAt = Number.NEGATIVE_INFINITY;

	return {
		render(snapshot) {
			const { engine, settings } = snapshot;
			version.textContent = engine.fallbackFrom
				? `${COPY.engine.rows.version(engine.version, nnueNames(engine.nnue))} · ${COPY.engine.rows.fallback}`
				: COPY.engine.rows.version(engine.version, nnueNames(engine.nnue));
			resources.textContent = COPY.engine.rows.resources(engine.threads, settings.engine.hashMb);
			selection.textContent = selectionModel(snapshot);
			const npsValue = engine.nps ?? snapshot.recommendation?.nps;
			nps.textContent = formatNps(npsValue);
			depth.textContent = COPY.engineView.depth(snapshot.recommendation?.depth ?? 0);
			const p = enginePill(snapshot, "ok");
			statusPill.update({ variant: p.variant, icon: statusIcon(p.variant), text: p.text });
			const now = Date.now();
			if (npsValue !== undefined && now - lastSampleAt >= UI_TIMINGS.sparklineSampleMs) {
				lastSampleAt = now;
				sparkline.push(npsValue);
			}
		},
		dispose() {
			sparkline.dispose();
			statusPill.dispose();
		},
	};
}
