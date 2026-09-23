// scripts/check-constants/page-programs.ts — rule (d): the emitted page programs
// (`src/page/generated/<name>.ts`, written by `gen:pagescript` earlier in the pipeline). The
// `code` a MAIN-world script ships must contain none of the §13.3 rule 5 product/engine words
// (Task 33).

import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/paths";
import { failOnFindings } from "../lib/report";
import { GENERATED_PAGE_DIR } from "./scope";
import { collectSources } from "./sources";

/** Words that must never appear in an emitted page program (§13.3 rule 5). Case-sensitive, as listed. */
export const FORBIDDEN_PAGE_SUBSTRINGS = [
	"sliced",
	"engine",
	"stockfish",
	"eval",
	"bestmove",
	"fen",
	"analysis",
] as const;

/** The forbidden words present in `code`. */
export function findForbiddenSubstrings(code: string): string[] {
	return FORBIDDEN_PAGE_SUBSTRINGS.filter((w) => code.includes(w));
}

export interface ForbiddenProgramHit {
	file: string;
	word: string;
}

const CODE_EXPORT_RE = /^export const code = (".*");$/m;

/**
 * The emitted `code` of every generated page program in `files` (keys under
 * `GENERATED_PAGE_DIR`) that contains a forbidden word. A generated module without a
 * parsable `code` export is reported as a hit on `"<unreadable>"` so it can never pass unseen.
 */
export function findForbiddenProgramSubstrings(
	files: Record<string, string>
): ForbiddenProgramHit[] {
	const out: ForbiddenProgramHit[] = [];
	for (const [file, src] of Object.entries(files)) {
		if (!file.startsWith(GENERATED_PAGE_DIR) || !file.endsWith(".ts")) continue;
		const m = CODE_EXPORT_RE.exec(src);
		let code: unknown;
		try {
			code = m ? JSON.parse(m[1] ?? "") : undefined;
		} catch {
			code = undefined;
		}
		if (typeof code !== "string") {
			out.push({ file, word: "<unreadable>" });
			continue;
		}
		for (const word of findForbiddenSubstrings(code)) out.push({ file, word });
	}
	return out;
}

/**
 * The emitted page programs; fails closed when `gen:pagescript` has not run — a missing
 * directory *and* an empty one (a half-finished or cleaned generation), because both mean
 * "nothing was scanned", which must never read as "nothing was wrong".
 */
export function checkEmittedPrograms(generatedDir = GENERATED_PAGE_DIR): void {
	const dir = path.resolve(ROOT, generatedDir);
	const hint = `run \`bun run gen:pagescript\` before check-constants (the emitted page programs are scanned for forbidden words)`;
	if (!existsSync(dir)) throw new Error(`${generatedDir} is missing: ${hint}`);
	const files = collectSources(dir, {}, true);
	if (Object.keys(files).length === 0)
		throw new Error(`${generatedDir} holds no emitted page program: ${hint}`);
	failOnFindings(
		findForbiddenProgramSubstrings(files),
		(h) => `forbidden word "${h.word}" in emitted page program ${h.file} (§13.3 rule 5)`,
		(n) => `${n} forbidden word(s) in emitted page programs`
	);
}
