// scripts/build/options.ts — what a build is asked for, and the per-build values resolved once.

export interface BuildOptions {
	dev: boolean;
	fast: boolean;
	watch: boolean;
	/** Spoof seed for this build (default: `SL_SPOOF_SEED` env, else a fresh random one). */
	spoofSeed?: string;
}

/** `BuildOptions` with the per-build values resolved once for the whole pipeline (`runBuild`). */
export interface BuildEnv extends BuildOptions {
	spoofSeed: string;
	/** `__SL_BUILD__`; also mirrored into a dev manifest's `version_name`. */
	buildStamp: string;
}

/**
 * One seed per build: the page programs (`gen-pagescript`) and the content
 * bundle (`define.__SL_SPOOF_SEED__`) must derive identical tokens.
 */
export function newSpoofSeed(): string {
	return process.env.SL_SPOOF_SEED ?? crypto.randomUUID().replaceAll("-", "");
}

export function resolveBuildEnv(o: BuildOptions): BuildEnv {
	return {
		...o,
		spoofSeed: o.spoofSeed ?? newSpoofSeed(),
		buildStamp: new Date().toISOString(),
	};
}

/** `--dev` implies `--fast` (no typecheck); `--watch` is parsed but has no loop yet. */
export function parseBuildArgs(flags: ReadonlySet<string>): BuildOptions {
	return {
		dev: flags.has("--dev"),
		fast: flags.has("--fast") || flags.has("--dev"),
		watch: flags.has("--watch"),
	};
}
