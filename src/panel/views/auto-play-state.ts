import type { PanelSnapshot } from "@core/constants/messages";
import { COPY } from "../copy";

export interface AutoPlayState {
	checked: boolean;
	/** Saved intent is waiting for an active game; the hand is not armed yet. */
	waiting: boolean;
	label: string;
}

/** Saved intent reads as on only while the session explicitly defers it in the lobby. */
export function autoPlayState(snapshot: PanelSnapshot): AutoPlayState {
	const waiting =
		!snapshot.autoMove.armed &&
		snapshot.settings.automation.autoMove &&
		snapshot.session.lobbyHold === true;
	return {
		checked: snapshot.autoMove.armed || waiting,
		waiting,
		label: waiting
			? COPY.toggle.waiting
			: snapshot.autoMove.armed
				? COPY.toggle.armed
				: COPY.toggle.off,
	};
}
