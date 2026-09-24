/**
 * Move-timing model interfaces (Part I §8.3, normative). `TimingPlan`,
 * `TimingMode` and `TimingLogEntry` live in `@typedefs/timing` (shared across
 * contexts) and are re-exported here; everything else in the §8.3 surface is
 * declared in this file.
 *
 * The declarations are grouped under `./types/`; this file is their single entry.
 */

import type { MoveWindowBudget, TimingLogEntry, TimingMode, TimingPlan } from "@typedefs/timing";

export type * from "./types/context";
export type * from "./types/features";
export type * from "./types/head";
export type { MoveWindowBudget, TimingLogEntry, TimingMode, TimingPlan };
