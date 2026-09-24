/**
 * tools/calibration/verify/orchestrate.ts — the verification run: every cell of `--cells` (or
 * `--only`) the label has no result for, `args.workers` worker processes at a time.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { cellsInDir } from "../cells";
import { VERIFY_DIR } from "../common";
import type { VerifyArgs } from "./args";

/** Verify every cell not yet verified under the label, spawning `entry` per cell. */
export async function verifyCells(args: VerifyArgs, entry: string): Promise<void> {
	const cells = cellsInDir(args.cells).filter(
		(c) => args.only.length === 0 || args.only.includes(c)
	);
	const done = (c: string) =>
		existsSync(path.join(VERIFY_DIR, args.label, "cells", `${c.replace(":", "-")}.json`));
	const queue = cells.filter((c) => !done(c));
	console.log(`${cells.length} cells, ${queue.length} to verify with table ${args.table}`);
	const worker = async (): Promise<void> => {
		for (;;) {
			const cell = queue.shift();
			if (cell === undefined) return;
			const proc = Bun.spawn(
				[
					process.execPath,
					entry,
					"--worker",
					"--cell",
					cell,
					"--table",
					args.table,
					"--label",
					args.label,
					"--chains",
					String(args.chains),
					"--cells",
					args.cells,
					"--seed",
					args.seed,
					"--split",
					args.split,
					"--model",
					args.model,
				],
				{ stdout: "inherit", stderr: "inherit" }
			);
			const code = await proc.exited;
			if (code !== 0) console.error(`${cell}: worker exited ${code}`);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, args.workers) }, worker));
}
