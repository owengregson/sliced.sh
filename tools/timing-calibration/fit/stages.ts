/**
 * tools/timing-calibration/fit/stages.ts — the three stages: one replay at `p = P0` (premove),
 * one replay per (power, shift) grid value (shift surfaces), and the table from the saved
 * surfaces (optionally written into `src/core/constants/timing-calibration.ts`).
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import {
	TIMING_CALIBRATION_IDENTITY,
	type TimingCalibrationTable,
	type TimingCalibrationTimeClass,
} from "@core/constants/timing-calibration";
import { flagValue, hasFlag } from "../../lib/cli";
import { ROOT } from "../../lib/paths";
import { PATHS } from "../common";
import { loadReplay, type SimOptions } from "../sim";
import { type CellMap, KNOTS, measure, P0, type SplitKey } from "./cells";
import {
	constantShift,
	fittedTable,
	premoveTable,
	SMOOTH_SHIFT,
	tableLiteral,
	withAll,
} from "./table";

function fitDir(): string {
	const dir = PATHS.fit;
	mkdirSync(dir, { recursive: true });
	return dir;
}

function simOptions(table: TimingCalibrationTable, chains: number, seed: string): SimOptions {
	return { table, fastReply: true, hover: true, chains, seed };
}

export async function stagePremove(chains: number): Promise<void> {
	const data = await loadReplay();
	const table = withAll(TIMING_CALIBRATION_IDENTITY, (c) => ({
		...c,
		knots: [...KNOTS],
		premove: { recapture: KNOTS.map(() => P0), other: null },
	}));
	const cells = await measure(data, simOptions(table, chains, "fit-premove"));
	await Bun.write(path.join(fitDir(), "premove.json"), `${JSON.stringify(cells)}\n`);
	console.log(`premove: ${Object.keys(cells).length} cells`);
}

export async function stageShift(
	grid: readonly number[],
	power: number,
	chains: number,
	only?: TimingCalibrationTimeClass
): Promise<void> {
	const data = await loadReplay();
	const premove = await premoveTable("all");
	for (const g of grid) {
		const table = withAll(premove, (c) => ({
			...c,
			knots: [...KNOTS],
			budgetPower: power,
			shift: constantShift(g),
		}));
		const t0 = performance.now();
		const file = path.join(fitDir(), surfaceName(power, g));
		const fresh = await measure(data, simOptions(table, chains, "fit-shift"), only);
		// `--only <class>` refreshes that class's cells in an existing surface and keeps the rest.
		const old =
			only !== undefined && (await Bun.file(file).exists())
				? ((await Bun.file(file).json()) as CellMap)
				: {};
		const cells: CellMap = { ...old };
		if (only !== undefined)
			for (const k of Object.keys(cells)) if (k.startsWith(`${only}|`)) delete cells[k];
		Object.assign(cells, fresh);
		await Bun.write(file, `${JSON.stringify(cells)}\n`);
		console.log(
			`power ${power} shift ${g.toFixed(2)}: ${((performance.now() - t0) / 1000).toFixed(0)} s`
		);
	}
}

const surfaceName = (power: number, g: number) => `shift_p${power.toFixed(2)}_${g.toFixed(2)}.json`;

export async function stageTable(argv: readonly string[]): Promise<void> {
	const source = (flagValue(argv, "source", "all") ?? "all") as SplitKey;
	const lambda = Number(flagValue(argv, "lambda", String(SMOOTH_SHIFT)));
	const power = flagValue(argv, "power");
	const table = await fittedTable(source, lambda, power === undefined ? undefined : Number(power));
	const out = flagValue(argv, "out", path.join(fitDir(), `table-${source}.json`)) ?? "";
	await Bun.write(out, `${JSON.stringify(table, null, "\t")}\n`);
	console.log(tableLiteral(table));
	if (hasFlag(argv, "write")) {
		const file = path.join(ROOT, "src/core/constants/timing-calibration.ts");
		const text = await Bun.file(file).text();
		const begin = text.indexOf("// fitted-table-begin");
		const end = text.indexOf("// fitted-table-end");
		if (begin < 0 || end < 0) throw new Error("fit: table markers missing");
		const next = `${text.slice(0, begin)}// fitted-table-begin\n${tableLiteral(table)}\n${text.slice(end)}`;
		await Bun.write(file, next);
		console.log(`wrote ${file}`);
	}
}
