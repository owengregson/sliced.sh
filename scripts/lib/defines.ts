// scripts/lib/defines.ts — the bundler's `__SL_*` defines for plain `bun scripts/<x>.ts` runs.
//
// `src/core/constants/limits.ts` (and `urls.ts`) read the bundler's `__SL_*` defines at module
// scope; the bundle and `test/setup.ts` provide them, a plain `bun` run does not. Each installer
// fills only the globals that are still undefined, so a test preload's values win.

const g = globalThis as Record<string, unknown>;

/** The placeholders the constants registry needs to evaluate at all. */
export function installRegistryDefines(): void {
	g.__SL_LICENSE_ENFORCE__ ??= false;
	g.__SL_LICENSE_URL__ ??= "";
}

/** Every define, as the bundle would see it (runtime registries bound into page programs). */
export function installDefines(defaults: Readonly<Record<string, unknown>>): void {
	for (const [k, v] of Object.entries(defaults)) if (g[k] === undefined) g[k] = v;
}
