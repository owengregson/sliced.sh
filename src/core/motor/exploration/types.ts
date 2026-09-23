/** The own-turn exploration planner's inputs. */
import type { Square } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";
import type { TimingMode } from "@typedefs/timing";
import type { MotorRepertoireContext } from "../repertoire";
import type { Occupancy, Pt } from "../types";

export interface ExplorationOptions {
	repertoire?: MotorRepertoireContext;
	thinkMs: number;
	mode: TimingMode;
	nReasonable: number;
	myClockMs: number;
	persona: PersonaId;
	/** `Settings.execution.previewSelectScale`, 0 when previews are off. */
	previewScale: number;
	committed: { from: Square; to: Square };
	legalDestinations(sq: Square): Square[];
	/** Adapter placement (Task 18); lets previews pick truly empty squares to deselect. */
	occupancy?: (sq: Square) => Occupancy;
	/** Where the hand is now — it owns the pointer (§13.5), so the caller always knows. */
	cursor: Pt;
}
