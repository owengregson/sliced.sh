/**
 * tools/calibration/verify/args.ts — the verification's command line: the table under test, the
 * label its results are filed under, the players and rating model, the worker and report switches.
 * A value flag always takes the next token (the empty string at the end); an unknown token throws.
 */

import { CELLS_DIR } from "../cells";
import { MODEL_FILE } from "../rating-eval";

export interface VerifyArgs {
	/** The players verified on (never the ones the table and the rating model were fitted on). */
	split: "fit" | "holdout";
	model: string;
	table: string;
	label: string;
	chains: number;
	workers: number;
	only: string[];
	cells: string;
	worker: boolean;
	cell?: string;
	seed: string;
	reportOnly: boolean;
}

export function parseArgs(argv: string[]): VerifyArgs {
	const args: VerifyArgs = {
		table: "shipped",
		label: "",
		chains: 8,
		workers: 9,
		only: [],
		cells: CELLS_DIR,
		worker: false,
		seed: "verify",
		reportOnly: false,
		split: "holdout",
		model: MODEL_FILE,
	};
	for (let i = 0; i < argv.length; i++) {
		const v = argv[i + 1] ?? "";
		switch (argv[i]) {
			case "--table":
				args.table = v;
				i++;
				break;
			case "--label":
				args.label = v;
				i++;
				break;
			case "--chains":
				args.chains = Number(v);
				i++;
				break;
			case "--workers":
				args.workers = Number(v);
				i++;
				break;
			case "--only":
				args.only = v.split(",").filter(Boolean);
				i++;
				break;
			case "--cells":
				args.cells = v;
				i++;
				break;
			case "--seed":
				args.seed = v;
				i++;
				break;
			case "--cell":
				args.cell = v;
				i++;
				break;
			case "--worker":
				args.worker = true;
				break;
			case "--split":
				args.split = v as VerifyArgs["split"];
				i++;
				break;
			case "--model":
				args.model = v;
				i++;
				break;
			case "--report":
				args.reportOnly = true;
				break;
			default:
				throw new Error(`unknown argument ${argv[i]}`);
		}
	}
	if (!args.label) args.label = args.table;
	return args;
}
