/**
 * tools/lib/defines.ts — the bundler's compile-time `define` constants, for running `src/`
 * modules under plain `bun` (outside `bun test`, whose `test/setup.ts` preload does this).
 * Must be the **first** import of every entry script in `tools/`: ES modules evaluate imports in
 * order, and `src/core/constants/limits.ts` reads `__SL_LICENSE_ENFORCE__` at evaluation time.
 */

const g = globalThis as Record<string, unknown>;
g.__SL_VERSION__ ??= "tools";
g.__SL_BUILD__ ??= "human-match";
g.__SL_SPOOF_SEED__ ??= "deadbeef01234567deadbeef01234567";
g.__SL_LICENSE_URL__ ??= "https://license.invalid/";
g.__SL_LICENSE_ENFORCE__ ??= false;
g.__SL_DEBUG__ ??= false;
