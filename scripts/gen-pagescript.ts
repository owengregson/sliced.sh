// scripts/gen-pagescript.ts — build step `gen-pagescript` (§5.4, Task 6).
//
// Compiles every program in the registry (`src/page/index.ts`) with the build
// spoof seed and writes:
//   src/page/generated/<name>.ts   — `{ name, params, code, bind(args) }`, runtime-safe
//                                    (no imports; `bind` mirrors src/pagescript/bind.ts)
//   <dist>/js/page/<name>.js       — for `entry` programs: the bound code as an IIFE
//                                    (MAIN-world content script registered in the manifest)
// `--sources-only` regenerates TypeScript without touching an existing package in dist.
//
// `astring` and the builders never reach a shipped bundle: runtime code imports
// only the generated modules. With an empty registry the directories are still
// created and the step succeeds.
//
// Seed: `options.seed` (the build pipeline passes its `__SL_SPOOF_SEED__`, so
// page programs and the content bundle derive the same tokens), else `--seed
// <value>` / `SL_SPOOF_SEED` env, else the fixed dev seed. Entry arguments
// may be a function of `{ seed }` for seed-derived tokens.

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import config from "../build.config.json" with { type: "json" };
import { type AnyPageProgram, bindCode, DEV_SPOOF_SEED, emit } from "../src/pagescript";
import { renderEntry, renderModule } from "./gen-pagescript/module-template";
import { flagValue } from "./lib/cli";
import { installDefines } from "./lib/defines";
import { ROOT } from "./lib/paths";

export { renderEntry, renderModule } from "./gen-pagescript/module-template";
export { ROOT } from "./lib/paths";

export const GENERATED_DIR = path.join(ROOT, "src", "page", "generated");
export const SEED_ENV = "SL_SPOOF_SEED";

export interface GenerateOptions {
	/** Spoof seed; defaults to `SL_SPOOF_SEED` from the environment, then the dev seed. */
	seed?: string;
	/** Where the `.ts` modules go (default `src/page/generated`). */
	generatedDir?: string;
	/** Program registry (default: `src/page/index.ts`). */
	programs?: readonly AnyPageProgram[];
	/** Regenerate and validate source modules without writing or creating any dist files. */
	sourcesOnly?: boolean;
}

export interface GenerateResult {
	seed: string;
	generated: string[];
	entries: string[];
}

const FILE_NAME_RE = /^[A-Za-z][\w-]*$/;

/** `--seed <value>` from argv; a trailing `--seed` with no value is an error. */
export function parseSeedArg(argv: readonly string[]): string | undefined {
	return flagValue(argv, "--seed", "gen-pagescript");
}

export function parseGenerateArgs(argv: readonly string[]): GenerateOptions {
	const seed = parseSeedArg(argv);
	return {
		sourcesOnly: argv.includes("--sources-only"),
		...(seed === undefined ? {} : { seed }),
	};
}

/**
 * The registry binds from runtime registries (`URLS`, `SELECTORS`, `TOKENS`)
 * whose modules read bundler defines at load time; this process is plain bun,
 * so install the same values the bundle's `define` would (unless a test
 * preload already did).
 */
function installBuildDefines(seed: string): void {
	installDefines({
		__SL_VERSION__: "build",
		__SL_BUILD__: "build",
		__SL_SPOOF_SEED__: seed,
		__SL_LICENSE_URL__: config.licenseUrl,
		__SL_LICENSE_ENFORCE__: config.licenseEnforce === true,
		__SL_DEBUG__: false,
	});
}

/** Compile the registry (or `options.programs`) and write the generated files. */
export async function generatePrograms(
	dist: string,
	options: GenerateOptions = {}
): Promise<GenerateResult> {
	const seed = options.seed ?? process.env[SEED_ENV] ?? DEV_SPOOF_SEED;
	const generatedDir = options.generatedDir ?? GENERATED_DIR;
	const entryDir = path.join(dist, "js", "page");
	installBuildDefines(seed);
	const programs = options.programs ?? (await import("../src/page/index.ts")).programs;

	await rm(generatedDir, { recursive: true, force: true });
	await mkdir(generatedDir, { recursive: true });
	if (!options.sourcesOnly) await mkdir(entryDir, { recursive: true });

	const seen = new Set<string>();
	const generated: string[] = [];
	const entries: string[] = [];
	for (const program of programs) {
		if (!FILE_NAME_RE.test(program.name)) {
			throw new Error(`gen-pagescript: program name "${program.name}" is not a safe file name`);
		}
		if (seen.has(program.name)) {
			throw new Error(`gen-pagescript: duplicate program name "${program.name}"`);
		}
		seen.add(program.name);

		const { code, params } = emit(program, { seed });
		const modulePath = path.join(generatedDir, `${program.name}.ts`);
		await writeFile(modulePath, renderModule(program.name, params, code));
		generated.push(modulePath);

		if (!program.entry) continue;
		if (params.length > 0 && program.entryArgs === undefined) {
			throw new Error(
				`gen-pagescript: entry program "${program.name}" declares parameters but no entryArgs`
			);
		}
		const entryArgs =
			typeof program.entryArgs === "function" ? program.entryArgs({ seed }) : program.entryArgs;
		const bound = bindCode(code, params, entryArgs ?? {});
		if (options.sourcesOnly) continue;
		const entryPath = path.join(entryDir, `${program.name}.js`);
		await writeFile(entryPath, renderEntry(bound));
		entries.push(entryPath);
	}
	return { seed, generated, entries };
}

/** Build step entry (`scripts/build.ts` → `gen-pagescript`). */
export async function generatePagescript(
	dist: string,
	options: GenerateOptions = {}
): Promise<void> {
	await generatePrograms(dist, options);
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const result = await generatePrograms(path.join(ROOT, "dist"), parseGenerateArgs(argv));
	console.log(
		`gen-pagescript: ${result.generated.length} program(s), ${result.entries.length} entry file(s)`
	);
}
