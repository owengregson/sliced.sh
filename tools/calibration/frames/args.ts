/**
 * tools/calibration/frames/args.ts — the frame cache's command line, walked left to right (so
 * `--no-policies` and `--policies` resolve by order); an unknown token or a valueless flag throws.
 */

import path from "node:path";
import { ROOT } from "../../lib/paths";

export interface FramesArgs {
	corpus: string;
	policies?: string;
	out: string;
	workers: number;
	limit: number;
	filterSplit?: string;
	filterTc?: Set<string>;
	samplePerCell: number;
	seed: string;
	worker?: string;
	/** Search only rows whose policies are already written (a run alongside `maia-batch.ts`). */
	requirePolicies?: boolean;
}

export function parseArgs(argv: string[]): FramesArgs {
	const dataDir = path.join(ROOT, "data/calibration");
	const args: FramesArgs = {
		corpus: path.join(dataDir, "corpus.jsonl"),
		policies: path.join(dataDir, "policies.jsonl"),
		out: path.join(dataDir, "frames.jsonl"),
		workers: 9,
		limit: 0,
		samplePerCell: 0,
		seed: "frames",
	};
	const take = (i: number): string => {
		const v = argv[i + 1];
		if (v === undefined) throw new Error(`${argv[i]} needs a value`);
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--corpus":
				args.corpus = take(i++);
				break;
			case "--policies":
				args.policies = take(i++);
				break;
			case "--require-policies":
				args.requirePolicies = true;
				break;
			case "--no-policies":
				delete args.policies;
				break;
			case "--out":
				args.out = take(i++);
				break;
			case "--workers":
				args.workers = Math.max(1, Number(take(i++)));
				break;
			case "--limit":
				args.limit = Number(take(i++));
				break;
			case "--filter-split":
				args.filterSplit = take(i++);
				break;
			case "--filter-tc":
				args.filterTc = new Set(take(i++).split(","));
				break;
			case "--sample-per-cell":
				args.samplePerCell = Number(take(i++));
				break;
			case "--seed":
				args.seed = take(i++);
				break;
			case "--worker":
				args.worker = take(i++);
				break;
			default:
				throw new Error(`unknown argument ${argv[i]}`);
		}
	}
	return args;
}
