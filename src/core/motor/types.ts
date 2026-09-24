/**
 * Motor-core types (§9.3, Appendix G §7.1): geometry, path points, the motor
 * profile, hand actions produced by the exploration planner and the V2.1
 * preview selections (§9.3a). `ExecutionResult` is defined once in
 * `@typedefs/game` (Task 2) and only re-exported here (C1). The `InputBackend`
 * interface belongs to Task 18 (`input-backend.ts`).
 *
 * The declarations are grouped by domain under `./types/`; this file is their single entry.
 */

import type { ExecutionResult } from "@typedefs/game";

export type * from "./types/execution";
export type * from "./types/geometry";
export type * from "./types/gestures";
export type * from "./types/profile";
export type { ExecutionResult };
