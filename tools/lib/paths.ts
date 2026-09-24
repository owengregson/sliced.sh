/** tools/lib/paths.ts — where the tools find the repository they run against. */

import path from "node:path";

/** The repository root: every tool resolves checked-in assets and fixtures against it. */
export const ROOT = path.resolve(import.meta.dir, "../..");
