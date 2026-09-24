/**
 * tools/calibration/crawl-chesscom/args.ts — the crawl's command line: numeric options checked as
 * they are read, left to right; an unknown token throws.
 */

export interface CrawlArgs {
	maxRequests: number;
	target: number;
	perPlayer: number;
	stall: number;
	seed: number;
	ruleOnly: boolean;
}

export function parseArgs(argv: string[]): CrawlArgs {
	const args: CrawlArgs = {
		maxRequests: 6000,
		target: 110,
		perPlayer: 2,
		stall: 40,
		seed: 7,
		ruleOnly: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = (): number => {
			const v = Number(argv[++i]);
			if (!Number.isFinite(v)) throw new Error(`${a} needs a number`);
			return v;
		};
		if (a === "--max-requests") args.maxRequests = next();
		else if (a === "--target") args.target = next();
		else if (a === "--per-player") args.perPlayer = next();
		else if (a === "--stall") args.stall = next();
		else if (a === "--seed") args.seed = next();
		else if (a === "--rule-only") args.ruleOnly = true;
		else throw new Error(`unknown argument ${a}`);
	}
	return args;
}
