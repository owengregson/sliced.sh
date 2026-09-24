/** tools/move-review/score/report.ts — what a scoring run prints and writes. */

import type { Called, Tally } from "./classify";
import type { FrameSet } from "./frames";

export function scoreSummary(t: Tally, set: FrameSet, allowLegacy: boolean) {
	return {
		provenance: [...set.provenance.values()],
		legacyEvidenceAllowed: allowLegacy,
		frames: set.frames.size,
		labelled: { classified: t.labelledClassified, brilliant: t.recalled, of: t.labelledTotal },
		labelledQualities: t.labelledQualities,
		labelledReasons: t.labelledReasons,
		others: {
			meaning: "Unpinned moves, NOT verified negatives; extra calls here do not measure precision.",
			classified: t.otherClassified,
			brilliant: t.overCalls.length,
			per1000:
				t.otherClassified > 0
					? Number(((t.overCalls.length * 1000) / t.otherClassified).toFixed(2))
					: null,
		},
		unclassified: t.unclassified,
		missingFrames: t.missingFrames,
		verifiedNegatives: {
			classified: t.negativeClassified,
			falsePositives: t.falsePositives,
			trueNegatives: t.negativeClassified - t.falsePositives,
		},
		distribution: t.distribution,
		...(t.marks.length > 0 ? { marks: t.marks } : {}),
	};
}

/** `--verbose`: the missed labelled moves and the unlabelled brilliant calls, one per line. */
export function printCalls(t: Tally): void {
	console.log(
		"missed:",
		t.missed
			.map(
				(c: Called) =>
					`${c.game}/${c.ply} ${c.san} (${c.rating}) ${c.reason ?? "no-offer"} loss=${c.loss} after=${c.played}`
			)
			.join("\n  ")
	);
	console.log(
		"over-calls:",
		t.overCalls
			.map((c) => `${c.game}/${c.ply} ${c.san} (${c.rating}) loss=${c.loss} after=${c.played}`)
			.join("\n  ")
	);
}
