/** tools/human-match/replay/args.ts — the replay's command line (see `replay.ts`). */

import type { MaiaSize } from "@core/constants/maia";
import { SEARCH_BUDGET } from "@core/constants/search";
import { flagText, parseFlags } from "../../lib/cli";

export interface ReplayArgs {
	corpus?: string;
	frames?: string;
	framesOut?: string;
	engine: boolean;
	policies?: string;
	policiesOut?: string;
	maia: boolean;
	fixture: boolean;
	size?: MaiaSize;
	draws: number;
	seed: string;
	limit: number;
	movetime: number;
	out?: string;
	json?: string;
}

const FLAGS = {
	"--corpus": "value",
	"--frames": "value",
	"--frames-out": "value",
	"--engine": "switch",
	"--policies": "value",
	"--policies-out": "value",
	"--maia": "switch",
	"--fixture": "switch",
	"--size": "value",
	"--draws": "value",
	"--seed": "value",
	"--limit": "value",
	"--movetime": "value",
	"--out": "value",
	"--json": "value",
} as const;

export function parseReplayArgs(argv: string[]): ReplayArgs {
	const seen = parseFlags(argv, FLAGS, { missingValue: "throw" });
	const text = (flag: keyof typeof FLAGS): string | undefined => flagText(seen, flag);
	const args: ReplayArgs = {
		engine: seen.has("--engine"),
		maia: seen.has("--maia"),
		fixture: seen.has("--fixture"),
		draws: 2000,
		seed: text("--seed") ?? "human-match",
		limit: 0,
		movetime: SEARCH_BUDGET.moveMs.blitz,
	};
	const corpus = text("--corpus");
	if (corpus !== undefined) args.corpus = corpus;
	const frames = text("--frames");
	if (frames !== undefined) args.frames = frames;
	const framesOut = text("--frames-out");
	if (framesOut !== undefined) args.framesOut = framesOut;
	const policies = text("--policies");
	if (policies !== undefined) args.policies = policies;
	const policiesOut = text("--policies-out");
	if (policiesOut !== undefined) args.policiesOut = policiesOut;
	const size = text("--size");
	if (size !== undefined) args.size = size as MaiaSize;
	if (seen.has("--draws")) args.draws = Number(text("--draws"));
	if (seen.has("--limit")) args.limit = Number(text("--limit"));
	if (seen.has("--movetime")) args.movetime = Number(text("--movetime"));
	const out = text("--out");
	if (out !== undefined) args.out = out;
	const json = text("--json");
	if (json !== undefined) args.json = json;
	if (!args.fixture && !args.corpus) throw new Error("--corpus FILE or --fixture is required");
	return args;
}
