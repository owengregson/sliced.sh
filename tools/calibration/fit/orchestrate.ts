/**
 * tools/calibration/fit/orchestrate.ts — the fit run: every cell of `--cells` (or `--only`) that
 * has no saved surface yet, one worker process per cell, then the smoothing stage.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { cellsInDir } from "../cells";
import type { FitArgs } from "./args";
import { writeSmoothed } from "./table";

/** The cells in `dir` by time class, then bucket. */
function sortedCells(dir: string): string[] {
	return cellsInDir(dir).sort((a, b) => {
		const [ta, ba] = a.split(":");
		const [tb, bb] = b.split(":");
		return ta === tb ? Number(ba) - Number(bb) : (ta ?? "") < (tb ?? "") ? -1 : 1;
	});
}

/** Fit every cell not yet fitted, `args.workers` processes of `entry` at a time, then smooth. */
export async function orchestrate(args: FitArgs, entry: string): Promise<void> {
	let cells = sortedCells(args.cells);
	if (args.only.length > 0) cells = cells.filter((c) => args.only.includes(c));
	const done = (c: string) =>
		existsSync(path.join(args.out, "cells", `${c.replace(":", "-")}.json`));
	const queue = cells.filter((c) => !done(c));
	console.log(`${cells.length} cells, ${queue.length} to fit, ${args.workers} workers`);
	const passthrough = [
		"--cells",
		args.cells,
		"--out",
		args.out,
		"--chains",
		String(args.chains),
		"--temps",
		args.temps.join(","),
		"--offsets",
		`${args.offsets[0]}:${args.offsets[args.offsets.length - 1]}:${(args.offsets[1] ?? 0) - (args.offsets[0] ?? 0) || 100}`,
		"--seed",
		args.seed,
		"--split",
		args.split,
		"--model",
		args.model,
		...(args.refine ? [] : ["--full-grid"]),
	];
	const started = performance.now();
	const runOne = async (): Promise<void> => {
		for (;;) {
			const cell = queue.shift();
			if (cell === undefined) return;
			const proc = Bun.spawn([process.execPath, entry, ...passthrough, "--worker", "--cell", cell], {
				stdout: "inherit",
				stderr: "inherit",
			});
			const code = await proc.exited;
			if (code !== 0) console.error(`${cell}: worker exited ${code}`);
			else
				console.log(
					`${cell} fitted (${((performance.now() - started) / 60_000).toFixed(1)} min elapsed, ${queue.length} queued)`
				);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, args.workers) }, runOne));
	await writeSmoothed(args);
}
