/** What the Account and Diagnostics builders register with the view for refresh and cleanup. */

import type { ButtonHandle } from "../../components/button";

export interface SectionParts {
	/** Buttons the hands-off lock disables and the cleanup disposes. */
	buttons: ButtonHandle[];
	/** Extra cleanups (timers). */
	disposers: Array<() => void>;
	/** Non-setting rows re-rendered on every snapshot. */
	refreshers: Array<() => void>;
}
