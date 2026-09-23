/**
 * Public entry of the engine controller: engine options, network routing and priority-aware
 * cached analysis. The parts live in `engine-controller/`:
 *
 *   - `controller.ts`        — the `EngineController` state machine (settings → options, network
 *                              variant changes, game resets, routed admission);
 *   - `routed-queue.ts`      — the priority queue and the supersede rule of the routed path;
 *   - `cache-policy.ts`      — which cached result answers which request, and its generation;
 *   - `deferred-analysis.ts` — a request held behind a game reset (no configurator);
 *   - `options-diff.ts`      — the option delta sent to the engine;
 *   - `types.ts`             — the construction seam and the status record.
 */

export { EngineController } from "@service/engine-controller/controller";
export type {
	EngineControllerDeps,
	EngineControllerStatus,
} from "@service/engine-controller/types";
