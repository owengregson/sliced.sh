/**
 * tools/calibration/fit/args.ts — the fit's command line: the sweep grid, the players and rating
 * model it fits on, the worker and smoothing switches. Walked left to right; an unknown token
 * throws; a value flag always takes the next token.
 */

import path from "node:path";
import { CELLS_DIR } from "../cells";
import { DATA_DIR } from "../common";
import { MODEL_FILE } from "../rating-eval";
import { JOINT } from "./smooth";

export const FIT_DIR = path.join(DATA_DIR, "fit");

export interface FitArgs {
	cells: string;
	out: string;
	workers: number;
	chains: number;
	offsets: number[];
	temps: number[];
	only: string[];
	seed: string;
	worker: boolean;
	cell?: string;
	smooth: boolean;
	write: boolean;
	/** The players the table is fitted on (`all` = both splits: the shipped table). */
	split: "fit" | "holdout" | "all";
	/** The rating model file (trained on the same players as the fit). */
	model: string;
	/** Coarse grid (every other value) then the full grid's neighbours of the best point. */
	refine: boolean;
	/** `JOINT.smooth.weight` override for `--smooth` (the weight is chosen on held-out players). */
	smoothWeight: number;
}

function range(spec: string): number[] {
	const [a, b, s] = spec.split(":").map(Number);
	if (a === undefined || b === undefined || s === undefined || !(s > 0))
		throw new Error(`bad range ${spec}`);
	const out: number[] = [];
	for (let v = a; v <= b + 1e-9; v += s) out.push(Math.round(v * 1000) / 1000);
	return out;
}

export function parseArgs(argv: string[]): FitArgs {
	const args: FitArgs = {
		cells: CELLS_DIR,
		out: FIT_DIR,
		workers: 9,
		chains: 4,
		offsets: range("-600:1000:100"),
		temps: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8],
		only: [],
		seed: "calibration",
		worker: false,
		smooth: false,
		write: false,
		split: "fit",
		model: MODEL_FILE,
		refine: true,
		smoothWeight: JOINT.smooth.weight,
	};
	for (let i = 0; i < argv.length; i++) {
		const v = argv[i + 1];
		switch (argv[i]) {
			case "--cells":
				args.cells = v ?? args.cells;
				i++;
				break;
			case "--out":
				args.out = v ?? args.out;
				i++;
				break;
			case "--workers":
				args.workers = Number(v);
				i++;
				break;
			case "--chains":
				args.chains = Number(v);
				i++;
				break;
			case "--offsets":
				args.offsets = range(v ?? "");
				i++;
				break;
			case "--temps":
				args.temps = (v ?? "").split(",").map(Number);
				i++;
				break;
			case "--only":
				args.only = (v ?? "").split(",").filter(Boolean);
				i++;
				break;
			case "--seed":
				args.seed = v ?? args.seed;
				i++;
				break;
			case "--cell":
				if (v !== undefined) args.cell = v;
				i++;
				break;
			case "--worker":
				args.worker = true;
				break;
			case "--smooth":
				args.smooth = true;
				break;
			case "--split":
				args.split = v as FitArgs["split"];
				i++;
				break;
			case "--model":
				args.model = v ?? args.model;
				i++;
				break;
			case "--smooth-weight":
				args.smoothWeight = Number(v);
				i++;
				break;
			case "--full-grid":
				args.refine = false;
				break;
			case "--write":
				args.write = true;
				break;
			default:
				throw new Error(`unknown argument ${argv[i]}`);
		}
	}
	return args;
}
