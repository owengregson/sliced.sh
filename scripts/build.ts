// scripts/build.ts — `bun run build [--dev] [--fast]`: the §11.2 pipeline, `dist/` → release zip.
//
// The pipeline is the ordered list of named steps in `build/steps.ts`; the bundler setup is
// `build/bundle.ts`, the asset copy `build/copy-assets.ts`, the sound allowlist
// `build/sounds.ts`. This file is the public entry and the CLI.

import { type BuildOptions, parseBuildArgs, resolveBuildEnv } from "./build/options";
import { runSteps, steps } from "./build/steps";
import { cliFlags } from "./lib/cli";

export { type BuildEnv, type BuildOptions, newSpoofSeed } from "./build/options";
export { prunePackagedSounds } from "./build/sounds";
export { type Step, steps } from "./build/steps";
export { DIST, ROOT } from "./lib/paths";

export async function runBuild(o: BuildOptions): Promise<void> {
	await runSteps(steps, resolveBuildEnv(o));
}

if (import.meta.main) await runBuild(parseBuildArgs(cliFlags()));
