// scripts/check-constants/sources.ts — the TypeScript sources the rules scan.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { posixRelative, ROOT } from "../lib/paths";

/**
 * Collect `*.ts` sources (not `.d.ts`) under `dir`, keyed by repo-relative posix path so the
 * scope prefixes match. `generated/` directories are skipped unless `includeGenerated`.
 */
export function collectSources(
	dir: string,
	acc: Record<string, string> = {},
	includeGenerated = false
): Record<string, string> {
	for (const e of readdirSync(dir)) {
		const p = path.join(dir, e);
		if (statSync(p).isDirectory()) {
			if (/node_modules/.test(p)) continue;
			if (/generated/.test(p) && !includeGenerated) continue;
			collectSources(p, acc, includeGenerated);
		} else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) {
			acc[posixRelative(ROOT, p)] = readFileSync(p, "utf8");
		}
	}
	return acc;
}
