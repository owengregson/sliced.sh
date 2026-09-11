import { SELECTION_CONSTANTS } from "./constants";
import type { SelectionMode } from "./types";

/** Above the custom temperature's plateau, Hybrid retains the native rating-limited choice. */
export function usesNativeSelection(mode: SelectionMode, effectiveElo: number): boolean {
	return (
		mode === "engine-elo" || (mode === "hybrid" && effectiveElo >= SELECTION_CONSTANTS.tau.pivotElo)
	);
}
