// scripts/registry-defines.ts — placeholder bundler defines for build scripts.
//
// `src/core/constants/limits.ts` (and `urls.ts`) read the bundler's `__SL_*` defines at module
// scope; the bundle and `test/setup.ts` provide them, a plain `bun scripts/<x>.ts` run does not.
// A script that imports the registry *statically* imports this module first — ESM evaluates
// imports in order, so the globals exist before `limits.ts` runs. Scripts that `import()` the
// registry lazily (`nnue-assets.ts`, `vendor-engine.ts`) install the same placeholders inline.

const g = globalThis as Record<string, unknown>;
g.__SL_LICENSE_ENFORCE__ ??= false;
g.__SL_LICENSE_URL__ ??= "";

// A module, not a script: `tools/human-match/defines.ts` declares its own top-level `g`.
export {};
