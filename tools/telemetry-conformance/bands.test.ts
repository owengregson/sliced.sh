// tools/telemetry-conformance/bands.test.ts — Task 33 Step 4 / C1.
//
// `report.py` runs offline, on a checkout with no toolchain, so it cannot import the TypeScript
// registries: it mirrors them in one `BANDS = json.loads(""" … """)` block. Of the two ways to
// stop that mirror drifting — generate a JSON file from the registry at build time, or check the
// literal from a test — this is the second, which is the simpler: no generated artefact, no extra
// step in `bun run check`, and the failure lands on whoever changed the registry.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { AGREEMENT_BANDS } from "@core/strength/constants";

const REPORT_PY = path.resolve(import.meta.dir, "report.py");
const BLOCK_RE = /^BANDS = json\.loads\("""\n([\s\S]*?)\n"""\)$/m;

function reportBands(): Record<string, unknown> {
	const source = readFileSync(REPORT_PY, "utf8");
	const match = BLOCK_RE.exec(source);
	if (!match?.[1])
		throw new Error('report.py: no `BANDS = json.loads(""" … """)` block to compare against');
	return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("report.py mirrors the TypeScript band registries", () => {
	it("exposes exactly the mirrored keys (a new mirror must be added here too)", () => {
		expect(Object.keys(reportBands()).sort()).toEqual([
			"agreement",
			"blurCountMax",
			"compression",
			"holdTime",
			"multiSelect",
			"orientationMinMs",
		]);
	});

	it("every mirrored §13 threshold equals TELEMETRY_BANDS", () => {
		const B = TELEMETRY_BANDS;
		expect(reportBands()).toMatchObject({
			blurCountMax: B.blurCountMax,
			multiSelect: {
				rate: [B.multiSelect.rate[0], B.multiSelect.rate[1]],
				hardMax: B.multiSelect.hardMax,
				minMovesForBand: B.multiSelect.minMovesForBand,
				minMovesForNonZero: B.multiSelect.minMovesForNonZero,
				minThinkMs: B.multiSelect.minThinkMs,
				minClockMs: B.multiSelect.minClockMs,
			},
			holdTime: {
				cvMin: B.holdTime.cvMin,
				cvAfterMoves: B.holdTime.cvAfterMoves,
				minMs: B.holdTime.minMs,
				complexityCorrMin: B.holdTime.complexityCorrMin,
			},
			compression: {
				pressureClockMs: B.compression.pressureClockMs,
				comfortableClockMs: B.compression.comfortableClockMs,
				maxMeanRatio: B.compression.maxMeanRatio,
				minMovesPerSide: B.compression.minMovesPerSide,
			},
			orientationMinMs: B.orientationMinMs,
		});
	});

	it("the §7.2 agreement band table is mirrored knot for knot", () => {
		expect(reportBands().agreement).toEqual(
			AGREEMENT_BANDS.map((b) => ({ elo: b.elo, top1: [...b.top1], acpl: [...b.acpl] }))
		);
	});
});
