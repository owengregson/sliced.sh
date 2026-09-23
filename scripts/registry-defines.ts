// scripts/registry-defines.ts — placeholder bundler defines for build scripts.
//
// `src/core/constants/limits.ts` (and `urls.ts`) read the bundler's `__SL_*` defines at module
// scope; the bundle and `test/setup.ts` provide them, a plain `bun scripts/<x>.ts` run does not.
// A script that imports the registry *statically* imports this module first — ESM evaluates
// imports in order, so the globals exist before `limits.ts` runs. Scripts that `import()` the
// registry lazily (`build/copy-assets.ts`, `vendor-engine/registry.ts`) call
// `installRegistryDefines()` themselves right before the import.

import { installRegistryDefines } from "./lib/defines";

installRegistryDefines();
