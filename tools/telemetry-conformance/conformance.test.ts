// tools/telemetry-conformance/conformance.test.ts — Task 33 Step 4: the offline conformance
// harness end to end. A batch of seeded simulated bot games is summarised with the shared
// `assertHumanShapedAc` / `formatConformanceReport`, exported in the Engine view's own JSON shape
// (`timingLogOf`), and fed to `report.py` — the tool the owner runs on real bot games — in three
// states: a Task-30-shaped export (ac + quality present), a pre-Task-30 export (timing columns
// only) and a tampered export (a blur, an untrusted move, an out-of-band ACPL).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { AGREEMENT_BANDS } from "@core/strength/constants";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { runSimulatedGame, timingLogOf } from "@test/sim/telemetry/harness";
import type { AcBlob } from "@typedefs/telemetry";
import type { TimingLogEntry } from "@typedefs/timing";
import {
	type AcMoveMeta,
	assertHumanShapedAc,
	formatConformanceReport,
	moveMetaOf,
	summarizeAc,
} from "./ac-model";

/** Games in the offline batch, and the target the §7.2 band is read at. */
const BATCH = { games: 4, movesPerGame: 30, targetElo: SIM_TELEMETRY.game.targetElo };
const REPORT_PY = path.resolve(import.meta.dir, "report.py");
const BATCH_TIMEOUT_MS = 60_000;

let dir = "";
let rows: TimingLogEntry[] = [];
const acs: AcBlob[] = [];
const meta: AcMoveMeta[] = [];

/** The §7.2 band for the batch's target: what a real export's quality columns must land in. */
const band = AGREEMENT_BANDS.reduce(
	(best, b) => (BATCH.targetElo >= b.elo ? b : best),
	AGREEMENT_BANDS[0]
);

function write(name: string, entries: TimingLogEntry[]): string {
	const file = path.join(dir, name);
	writeFileSync(file, JSON.stringify(entries), "utf8");
	return file;
}

interface Run {
	code: number;
	out: string;
}

async function report(file: string): Promise<Run> {
	const proc = Bun.spawn(["python3", REPORT_PY, "--target-elo", String(BATCH.targetElo), file], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { code, out: out + err };
}

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), "sl-conformance-"));
	for (let g = 0; g < BATCH.games; g++) {
		const game = await runSimulatedGame({ seed: `conformance-${g}`, moves: BATCH.movesPerGame });
		try {
			rows.push(...timingLogOf(game, `conformance-${g}`));
			for (const m of game.moves) {
				const obs = m.observation;
				if (!obs) continue;
				acs.push(obs.ac);
				meta.push(moveMetaOf(m));
			}
		} finally {
			await game.dispose();
		}
	}
	// The harness plays the engine's first line every move and has no selection layer (Task 24
	// owns it), so its own quality columns are top-1 100 % / ACPL 0. Overwrite them with a
	// deterministic in-band pattern — every other move top-1 (50 %, inside 47–53) and a cpLoss
	// ramp centred on the band — so the report's §7.2 check runs against a realistic export.
	// Task 30 fills these from the real `Recommendation`; nothing here is a strength claim.
	const acplMid = (band.acpl[0] + band.acpl[1]) / 2;
	rows = rows.map((row, i) =>
		row.telemetry
			? {
					...row,
					telemetry: { ...row.telemetry, top1: i % 2 === 0, cpLoss: acplMid + ((i % 5) - 2) * 5 },
				}
			: row
	);
}, BATCH_TIMEOUT_MS);

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("offline conformance: the batch of simulated games", () => {
	it("every blob in the batch is human-shaped and the printed report names every band", () => {
		const summary = assertHumanShapedAc(acs, { moves: meta });
		expect(summary).toEqual(summarizeAc(acs, meta));
		expect(summary.n).toBe(BATCH.games * BATCH.movesPerGame);
		expect(summary.blurCount).toBe(0);
		expect(summary.toggles).toBe(0);
		expect(summary.untrusted).toBe(0);
		expect(summary.focusFieldsSet).toBe(0);
		const text = formatConformanceReport(summary, "batch");
		expect(text).toContain(`batch: ${summary.n} moves`);
		expect(text).toContain("blur events 0");
		expect(text).toContain("multi-select");
		expect(text).toContain("hold time");
		expect(text).toContain("hold vs n_reasonable");
		expect(text).toContain("time pressure");
		expect(text).toContain("pointer offset");
	});

	it("exports one Engine-view row per planned move, with the telemetry record attached", () => {
		expect(rows).toHaveLength(BATCH.games * BATCH.movesPerGame);
		expect(rows.every((r) => r.telemetry !== undefined)).toBe(true);
		const first = rows[0]!;
		expect(Object.keys(first.telemetry ?? {}).sort()).toEqual([
			"ac",
			"cpLoss",
			"lichessBlur",
			"multiSelectEligible",
			"nReasonable",
			"orientationMs",
			"top1",
		]);
		// §8.4b item 2: an orientation latency on every move the player waited for — a premove is
		// decided before the opponent's move lands, so it carries none.
		const oriented = rows.filter((r) => r.mode !== "premove");
		expect(oriented.length).toBeGreaterThan(0);
		expect(
			oriented.every((r) => (r.telemetry?.orientationMs ?? 0) >= TELEMETRY_BANDS.orientationMinMs)
		).toBe(true);
		expect(rows.every((r) => r.actualMs !== null)).toBe(true);
	});
});

describe("offline conformance: report.py", () => {
	it("prints the ac and quality sections from a Task-30-shaped export and accepts it", async () => {
		const { code, out } = await report(write("task30.json", rows));
		expect(out).toContain("telemetry conformance report");
		expect(out).toContain(`games          ${BATCH.games}`);
		expect(out).toContain("[PASS] blur 0 (max 0)");
		expect(out).toContain("[PASS] EventTrusted on all");
		expect(out).toContain("DidSelectMultiplePieces");
		expect(out).toContain("[PASS] orientation latency present on all");
		expect(out).toContain("ln(hold) vs ln(n_reasonable)");
		expect(out).toContain("[PASS] top-1");
		expect(out).toContain("[PASS] ACPL");
		expect(out).toContain("acceptance: PASS");
		expect(out).not.toContain("not in export");
		expect(code).toBe(0);
	});

	it("says 'not in export (pre-Task 30)' for both sections when the rows carry no telemetry", async () => {
		const pre = rows.map(({ telemetry: _telemetry, ...rest }) => rest as TimingLogEntry);
		const { code, out } = await report(write("pre-task30.json", pre));
		expect(out).toContain("ac blob (§13.2)\n  not in export (pre-Task 30)");
		expect(out).toContain("move quality");
		// the two sections, plus the complexity axis that also rides on `telemetry`
		expect(out.match(/not in export \(pre-Task 30\)/g)).toHaveLength(3);
		// the timing columns still carry the whole §8.4a section
		expect(out).toContain("hold time (§8.4a, §13.2 MoveHoldTime)");
		expect(out).toContain("[INFO] ln(hold) vs ln(alloc)");
		expect(out).toContain("acceptance: PASS");
		expect(code).toBe(0);
	});

	it("fails a tampered export naming the blur, the untrusted move and the out-of-band ACPL", async () => {
		const bad = rows.map((r, i) => {
			if (!r.telemetry) return r;
			const ac: AcBlob = { ...r.telemetry.ac };
			if (i === 0) {
				ac.BlurCount = 1;
				ac.DidToggle = true;
				ac.DidBlurOnOwnTurn = true;
				ac.LastFocusToMoveTime = 400;
			}
			if (i === 1) ac.EventTrusted = false;
			return {
				...r,
				telemetry: {
					...r.telemetry,
					ac,
					lichessBlur: i === 0 ? (1 as const) : r.telemetry.lichessBlur,
					cpLoss: band.acpl[1] * 10,
				},
			};
		});
		const { code, out } = await report(write("tampered.json", bad));
		expect(out).toContain("[FAIL] blur 1 (max 0)");
		expect(out).toContain("[FAIL] EventTrusted on all");
		expect(out).toContain("[FAIL] ACPL");
		expect(out).toContain("acceptance: FAIL");
		expect(out).toContain("zero blur/toggle");
		expect(out).toContain("event trust");
		expect(code).toBe(1);
	});
});
