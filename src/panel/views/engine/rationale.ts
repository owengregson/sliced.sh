/** The timing rationale log's rows: one `TimingLogEntry` → plan, and once executed exec + verify/warn. */

import { LIMITS } from "@core/constants/limits";
import type { TimingLogEntry } from "@typedefs/timing";
import { COPY } from "../../copy";
import { clockText, seconds, signedSeconds } from "./format";

export type RationaleKind = keyof typeof COPY.engine.logKinds;

/** One rendered row of the timing rationale log (8ch time column, 5ch kind column, lines). */
export interface RationaleRow {
	kind: RationaleKind;
	time: string;
	lines: string[];
}

/** `TimingLogEntry` → the rows the log shows for it (§8.6, Appendix F §4.7). */
export function rationaleRows(entry: TimingLogEntry): RationaleRow[] {
	const time = clockText(entry.clockMs);
	const persona = COPY.personaName[entry.persona];
	const plan: RationaleRow = {
		kind: "plan",
		time,
		lines: [
			...(entry.model ? [COPY.engineView.rationale.model(entry.model.head, entry.model.band)] : []),
			...(entry.model?.fallbackReason
				? [COPY.engineView.rationale.fallback(entry.model.fallbackReason)]
				: []),
			...(entry.targetElo !== undefined && entry.opponentClockMs !== undefined
				? [COPY.engineView.rationale.context(entry.targetElo, seconds(entry.opponentClockMs))]
				: []),
			COPY.engineView.rationale.base(entry.alloc.toFixed(1), entry.mode, persona),
			...entry.topTerms.map(([name, value]) =>
				COPY.engineView.rationale.term(name, `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}`)
			),
			COPY.engineView.rationale.factors(entry.comp.toFixed(2), entry.eps.toFixed(2)),
			...(entry.rationale ?? []),
			COPY.engineView.rationale.total(seconds(entry.plannedMs), entry.mode),
		],
	};
	if (entry.actualMs === null) return [plan];
	const delta = entry.actualMs - entry.plannedMs;
	const drift = entry.plannedMs > 0 ? Math.abs(delta) / entry.plannedMs : 0;
	const exec: RationaleRow = {
		kind: "exec",
		time,
		lines: [COPY.engineView.rationale.exec(seconds(entry.actualMs), signedSeconds(delta))],
	};
	const outcome: RationaleRow =
		drift > LIMITS.timingLogDriftWarn
			? { kind: "warn", time, lines: [COPY.engineView.rationale.warn(signedSeconds(delta))] }
			: { kind: "verify", time, lines: [COPY.engineView.rationale.verify(signedSeconds(delta))] };
	return [plan, exec, outcome];
}
