// tools/telemetry-conformance/bands.test.ts — Task 33 Step 4 / C1.
//
// `report.py` runs offline, on a checkout with no toolchain, so it cannot import the TypeScript
// registries: it mirrors them in one `BANDS = json.loads(""" … """)` block. Of the two ways to
// stop that mirror drifting — generate a JSON file from the registry at build time, or check the
// literal from a test — this is the second, which is the simpler: no generated artefact, no extra
// step in `bun run check`, and the failure lands on whoever changed the registry.
//
// The comparison is exhaustive in both directions: a *deep* key-path set (so a threshold added to
// `report.py` at any nesting depth has to be registered here) and a whole-object `toEqual` (so no
// value can drift and nothing can go missing).
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

/** Every dotted path to a leaf (arrays are leaves), sorted — a key set that sees nesting. */
function keyPaths(value: unknown, prefix = ""): string[] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
	return Object.entries(value as Record<string, unknown>)
		.flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k))
		.sort();
}

/** The mirror `report.py` is expected to hold, built from the registries. */
const B = TELEMETRY_BANDS;
const expected = {
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
	agreement: AGREEMENT_BANDS.map((b) => ({ elo: b.elo, top1: [...b.top1], acpl: [...b.acpl] })),
};

describe("report.py mirrors the TypeScript band registries", () => {
	it("mirrors exactly these thresholds, at every depth (a new one must be registered here too)", () => {
		expect(keyPaths(reportBands())).toEqual(keyPaths(expected));
	});

	it("every mirrored value equals the registry it came from", () => {
		expect(reportBands()).toEqual(expected);
	});

	it("the §7.2 agreement band table is mirrored knot for knot", () => {
		expect(reportBands().agreement).toEqual(expected.agreement);
	});
});
