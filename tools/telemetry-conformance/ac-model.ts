// tools/telemetry-conformance/ac-model.ts
/**
 * The human-shape model of a move's `ac` blob (Part I §13.2, §9.6a, §8.4a,
 * §13.6): what every simulated or recorded move must look like. Thresholds
 * come from `TELEMETRY_BANDS` (once, C1). `assertHumanShapedAc` is the
 * assertion every behavioural executor test runs on the shadow's blobs, and
 * the conformance test runs on a batch of simulated games; `summarizeAc`
 * and `formatConformanceReport` produce the report `report.py` prints for
 * recorded games. Framework-free: violations are thrown as one `Error`.
 *
 * The parts live in `ac-model/`: move context, summary statistics, the rules, the annotation
 * rules and the text report. This file is their public entry.
 */

export {
	annotationViolations,
	assertHumanShapedAnnotations,
} from "./ac-model/annotations";
export { formatConformanceReport } from "./ac-model/format";
export { type AcMoveMeta, isNonTrivial, moveMetaOf } from "./ac-model/meta";
export {
	AcConformanceError,
	type AcExpectations,
	acConductViolations,
	acWellFormedViolations,
	assertHumanShapedAc,
	assertWellFormedAc,
} from "./ac-model/rules";
export { type AcSummary, type HoldStats, summarizeAc } from "./ac-model/summary";
