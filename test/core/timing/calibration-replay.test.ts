/**
 * The think-time calibration on real positions. The fixture is 2600–2999 blitz sides from the
 * holdout players (`tools/timing-calibration/fixture.ts`), with frozen engine frames and the
 * shipped ChessMimic band's distributions. It is replayed through the harness's production path
 * (`sim.ts`: premove arming and queueing, planMove, preparation and the hand) with the shipped
 * table, the fast-reply cap and the anticipatory hover. The recorded think times of book moves and
 * obvious recaptures must then sit near the humans' on the same positions, where the uncalibrated
 * behaviour (identity table, no cap, no hover) does not. This is a regression pin on a small
 * sample. The held-out verification is `docs/qa/timing-calibration-2026-09-24.md`.
 */

import { describe, expect, it } from "bun:test";
import {
	TIMING_CALIBRATION,
	TIMING_CALIBRATION_IDENTITY,
	type TimingCalibrationTable,
} from "@core/constants/timing-calibration";
import { PREMOVE_MAX_MS } from "../../../tools/timing-calibration/common";
import { type ReplayData, simulate } from "../../../tools/timing-calibration/sim";
import fixture from "../../fixtures/timing/calibration-replay.json";

const data = fixture as unknown as ReplayData;

interface Stats {
	median: number;
	premove: number;
}

function stats(ms: number[]): Stats {
	const s = [...ms].sort((a, b) => a - b);
	return {
		median: s[Math.floor(s.length / 2)] ?? Number.NaN,
		premove: s.filter((v) => v <= PREMOVE_MAX_MS).length / s.length,
	};
}

async function replay(table: TimingCalibrationTable, production: boolean) {
	const results = await simulate(data, {
		table,
		fastReply: production,
		hover: production,
		chains: 6,
		seed: "fixture",
	});
	const out: Record<string, { human: number[]; bot: number[] }> = {};
	for (const side of data.sides) {
		for (const rr of side.rows) {
			const res = results.get(rr.row.id);
			if (!res) continue;
			const cell = out[rr.row.situation] ?? { human: [], bot: [] };
			out[rr.row.situation] = cell;
			cell.human.push(rr.row.thinkMs);
			cell.bot.push(...res.bot);
		}
	}
	return out;
}

describe("the calibrated think times at 2600–2999 blitz (held-out players, frozen frames)", () => {
	it("releases book moves and obvious recaptures about as fast as the humans did", async () => {
		const after = await replay(TIMING_CALIBRATION, true);
		const before = await replay(TIMING_CALIBRATION_IDENTITY, false);
		for (const situation of ["book", "recapture"] as const) {
			const cell = after[situation];
			const base = before[situation];
			expect(cell?.human.length ?? 0).toBeGreaterThan(40);
			if (!cell || !base) continue;
			const h = stats(cell.human);
			const b = stats(cell.bot);
			const was = stats(base.bot);
			// The median within 35 % of the humans' (log-ratio 0.3), and closer than before.
			expect(Math.abs(Math.log(b.median / h.median))).toBeLessThan(0.3);
			expect(Math.abs(Math.log(b.median / h.median))).toBeLessThan(
				Math.abs(Math.log(was.median / h.median))
			);
		}
		// Recaptures: premoved about as often as the humans (who premove a third or more of them).
		const r = after.recapture;
		if (r) expect(Math.abs(stats(r.bot).premove - stats(r.human).premove)).toBeLessThan(0.15);
	}, 60_000);
});
