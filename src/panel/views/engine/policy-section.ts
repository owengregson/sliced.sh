/** The Human-model block's DOM: name, status pill, answer detail, latency sparkline and meters. */

import { LIMITS } from "@core/constants/limits";
import type { PanelSnapshot } from "@core/constants/messages";
import { createPill, type PillHandle } from "../../components/pill";
import { COPY } from "../../copy";
import { statusIcon } from "../../engine-status";
import { part } from "../../template";
import { type PolicyMeterRow, policyBlock } from "./policy";
import { createSparkline } from "./sparkline";

export interface PolicySection {
	render(snapshot: PanelSnapshot): void;
	dispose(): void;
}

export function createPolicySection(el: HTMLElement): PolicySection {
	const policyName = part(el, ".sl-engine__policy-name");
	const policyDetail = part(el, ".sl-engine__policy-detail");
	const policyLatency = part(el, ".sl-engine__policy-latency");
	const policyMeta = part(el, ".sl-engine__policy-meta");
	const policySparkline = createSparkline(
		part(el, ".sl-engine__policy-spark"),
		COPY.engineView.policy.sparkline,
		LIMITS.policySparklineSamples
	);
	const policyPill: PillHandle = createPill(part(el, ".sl-engine__policy-status"), {
		variant: "idle",
		icon: "status.idle",
		text: COPY.engineView.policy.off,
	});
	const policyMetersList = part(el, ".sl-engine__policy-meters");
	const policyWarning = part(el, ".sl-engine__policy-warning");
	const meterRows = Object.keys(COPY.engineView.policy.meters) as PolicyMeterRow[];
	const meterCells = new Map<PolicyMeterRow, { row: HTMLElement; value: HTMLElement }>();
	for (const row of meterRows) {
		const rowEl = part(policyMetersList, `[data-meter="${row}"]`);
		part(rowEl, ".sl-engine__key").textContent = COPY.engineView.policy.meters[row];
		meterCells.set(row, { row: rowEl, value: part(rowEl, ".sl-engine__value") });
	}
	/** One sparkline point per recommendation the model answered, not per (repeating) snapshot. */
	let lastPolicySample: string | null = null;

	return {
		render(snapshot) {
			const policy = policyBlock(snapshot);
			policyName.textContent = policy.name;
			policyDetail.textContent = policy.detail;
			policyLatency.textContent = policy.latency;
			policyMeta.textContent = policy.meta;
			policyPill.update({
				variant: policy.pill.variant,
				icon: statusIcon(policy.pill.variant),
				text: policy.pill.text,
			});
			const shown = new Map(policy.meters.map((m) => [m.row, m.value]));
			for (const [row, cells] of meterCells) {
				const value = shown.get(row);
				cells.row.hidden = value === undefined;
				cells.value.textContent = value ?? "";
			}
			policyMetersList.hidden = policy.meters.length === 0;
			policyWarning.hidden = policy.warning === null;
			policyWarning.textContent = policy.warning ?? "";
			if (
				policy.sampleKey !== null &&
				policy.sampleMs !== null &&
				policy.sampleKey !== lastPolicySample
			) {
				lastPolicySample = policy.sampleKey;
				policySparkline.push(policy.sampleMs);
			}
		},
		dispose() {
			policySparkline.dispose();
			policyPill.dispose();
		},
	};
}
