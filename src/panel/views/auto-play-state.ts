import type { PanelSnapshot } from "@core/constants/messages";
import { COPY } from "../copy";

/** Saved intent reads as on only while the session explicitly defers it in the lobby. */
export function autoPlayState(snapshot: PanelSnapshot) {
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
