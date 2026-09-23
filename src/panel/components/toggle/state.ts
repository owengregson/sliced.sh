/** The toggle's visible state and label as pure functions of its flags. */

import { COPY } from "../../copy";

export type ToggleState = "off" | "on" | "arming" | "armed" | "waiting";

export interface ToggleFlags {
	checked: boolean;
	/** Auto-play variant: hold to arm, click to disarm. */
	armedVariant: boolean;
	waiting: boolean;
	/** A hold is in progress. */
	holding: boolean;
}

export function toggleState({ checked, armedVariant, waiting, holding }: ToggleFlags): ToggleState {
	if (holding) return "arming";
	if (checked) return armedVariant ? (waiting ? "waiting" : "armed") : "on";
	return "off";
}

/**
 * The label for a state. §6.1 step 4: after a disarm the armed variant reads "Auto-play off"
 * until the next update or arm; otherwise the caller's own label shows.
 */
export function toggleLabel(
	state: ToggleState,
	armedVariant: boolean,
	disarmed: boolean,
	baseLabel: string
): string {
	return state === "arming"
		? COPY.toggle.arming
		: state === "armed"
			? COPY.toggle.armed
			: state === "waiting"
				? COPY.toggle.waiting
				: armedVariant && disarmed
					? COPY.toggle.off
					: baseLabel;
}
