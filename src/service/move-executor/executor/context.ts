/** What every part of the executor shares: the tab it drives, its collaborators and its config. */

import type { Scheduler } from "@core/util/scheduler";
import type { BoardRectSource } from "@service/board-watch";
import type { DebuggerManager } from "@service/debugger-manager";
import type { HandOwnership } from "@service/hand-ownership";
import type { Site } from "@typedefs/game";
import type { GeometryProvider } from "../hand/geometry";
import type { FocusSource } from "../hand/motor";
import type { Emit } from "./events";
import type { ExecutorGameConfig, ExecutorLink } from "./types";

export interface ExecutorContext {
	readonly tabId: number;
	readonly site: Site;
	readonly debugger: DebuggerManager;
	readonly link: ExecutorLink;
	readonly focus: FocusSource;
	readonly ownership: HandOwnership;
	readonly board: BoardRectSource | null;
	readonly now: () => number;
	readonly scheduler: Scheduler;
	/** Live: `updateSettings` writes it in place; an execution copies it once at dispatch. */
	readonly config: ExecutorGameConfig;
	/** Board / square / promotion rects over the content link (`geometry.ts`). */
	readonly geometry: GeometryProvider;
	/** Always `MoveExecutor.emit`, looked up per call. */
	readonly emit: Emit;
	isArmed(): boolean;
	isDisposed(): boolean;
}
