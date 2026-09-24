/** tools/move-review/score/tuning.ts — `--set group.field=value` overrides of the classifier. */

import { DEFAULT_MOVE_QUALITY_TUNING, type MoveQualityTuning } from "@core/engine/move-quality";

/** The shipped tuning with each `group.field=value` applied; an unknown field throws. */
export function tuningWith(assignments: readonly string[]): MoveQualityTuning {
	const tuning: MoveQualityTuning = {
		classification: { ...DEFAULT_MOVE_QUALITY_TUNING.classification },
		brilliant: { ...DEFAULT_MOVE_QUALITY_TUNING.brilliant },
	};
	for (const assignment of assignments) {
		const [key, value] = assignment.split("=");
		const [group, field] = (key ?? "").split(".");
		const target = tuning[group as keyof MoveQualityTuning] as Record<string, number> | undefined;
		if (!target || field === undefined || !(field in target) || !Number.isFinite(Number(value)))
			throw new Error(`--set ${assignment}: unknown field or value`);
		target[field] = Number(value);
	}
	return tuning;
}
