/** tools/telemetry-conformance/ac-model/format.ts — a summary as the text `report.py` also prints. */

import { TELEMETRY_BANDS } from "../../../src/core/constants/telemetry";
import type { AcSummary } from "./summary";

const ms = (x: number): string => `${x.toFixed(0)} ms`;
const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)} %`);

/** The per-game summary the conformance test and `report.py` print. */
export function formatConformanceReport(s: AcSummary, title = "ac conformance"): string {
	const B = TELEMETRY_BANDS;
	const h = s.holdNormal;
	return [
		`${title}: ${s.n} moves`,
		`  blur events ${s.blurCount} (max ${B.blurCountMax}) · toggles ${s.toggles} · untrusted ${s.untrusted} · focus fields set ${s.focusFieldsSet}`,
		`  multi-select ${pct(s.multiSelect.rate)} (${s.multiSelect.count}/${s.multiSelect.eligible} non-trivial; band ${pct(B.multiSelect.rate[0])}–${pct(B.multiSelect.rate[1])} from n≥${B.multiSelect.minMovesForBand}, hard max ${pct(B.multiSelect.hardMax)})`,
		`  hold time (normal/long, n=${h.n}): mean ${ms(h.mean)} sd ${ms(h.sd)} cv ${h.cv.toFixed(2)} (min ${B.holdTime.cvMin}) · min ${ms(h.min)} (floor ${ms(B.holdTime.minMs)}) · q10/q50/q90 ${ms(h.q10)} / ${ms(h.q50)} / ${ms(h.q90)}`,
		`  hold vs n_reasonable r=${s.holdVsComplexity === null ? "n/a" : s.holdVsComplexity.toFixed(2)} (min ${B.holdTime.complexityCorrMin})`,
		`  time pressure: mean ${ms(s.compression.pressure.mean)} (n=${s.compression.pressure.n}) vs comfortable ${ms(s.compression.comfortable.mean)} (n=${s.compression.comfortable.n}) · ratio ${s.compression.ratio === null ? "n/a" : s.compression.ratio.toFixed(2)} (max ${B.compression.maxMeanRatio})`,
		`  pointer offset mean ${s.pointerOffset.mean.toFixed(0)} px · max ${s.pointerOffset.max.toFixed(0)} px`,
	].join("\n");
}
