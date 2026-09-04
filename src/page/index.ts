// src/page/index.ts
/**
 * Page program registry (§5.5). `scripts/gen-pagescript.ts` compiles every
 * program listed here to `src/page/generated/<name>.ts` and, for `entry`
 * programs, to `dist/js/page/<name>.js`.
 *
 * Empty until the programs land (Task 21). Build/test-time only: this module
 * imports `@pagescript` and must never be reached from a runtime bundle.
 */

import type { AnyPageProgram } from "@pagescript";

export const programs: readonly AnyPageProgram[] = [];
