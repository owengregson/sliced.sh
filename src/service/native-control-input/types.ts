import type { Rng } from "@core/rng";
import type { Scheduler } from "@core/util/scheduler";
import type { ContentLink } from "@service/content-link";
import type { DebuggerManager } from "@service/debugger-manager";
import type { FocusGate } from "@service/focus-gate";
import type { HandOwnership } from "@service/hand-ownership";

export interface NativeControlInputOptions {
	link: ContentLink;
	debugger: DebuggerManager;
	ownership: HandOwnership;
	focus: Pick<FocusGate, "canExecute">;
	rng: Rng;
	scheduler?: Scheduler;
	now?: () => number;
	showCursor?: () => boolean;
}
