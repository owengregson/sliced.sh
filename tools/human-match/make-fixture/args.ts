/** tools/human-match/make-fixture/args.ts — the generator's command line (see `make-fixture.ts`). */

import path from "node:path";
import { MAIA_SIZES, type MaiaSize } from "@core/constants/maia";
import { flagText, parseFlags } from "../../lib/cli";
import { ROOT } from "../../lib/paths";

export interface FixtureArgs {
	out: string;
	movetime: number;
	depth: number;
	sizes: MaiaSize[];
	top: number;
	limit: number;
}

const FLAGS = {
	"--out": "value",
	"--movetime": "value",
	"--depth": "value",
	"--sizes": "value",
	"--top": "value",
	"--limit": "value",
} as const;

/** A flag with no value keeps `--out`'s default and reads as `NaN` / no sizes elsewhere. */
export function parseFixtureArgs(argv: string[]): FixtureArgs {
	const args: FixtureArgs = {
		out: path.join(ROOT, "test/fixtures/strength/maia-draw.json"),
		movetime: 600,
		depth: 18,
		sizes: [...MAIA_SIZES],
		top: 8,
		limit: 0,
	};
	const seen = parseFlags(argv, FLAGS, { missingValue: "undefined" });
	const text = (flag: keyof typeof FLAGS): string | undefined => flagText(seen, flag);
	if (seen.has("--out")) args.out = text("--out") ?? args.out;
	if (seen.has("--movetime")) args.movetime = Number(text("--movetime"));
	if (seen.has("--depth")) args.depth = Number(text("--depth"));
	if (seen.has("--sizes"))
		args.sizes = (text("--sizes") ?? "")
			.split(",")
			.filter((s): s is MaiaSize => (MAIA_SIZES as readonly string[]).includes(s));
	if (seen.has("--top")) args.top = Number(text("--top"));
	if (seen.has("--limit")) args.limit = Number(text("--limit"));
	return args;
}
