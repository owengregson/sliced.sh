/** The game port's request/reply typing and the content link's read-only event surface. */

import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import type { Scheduler } from "@core/util/scheduler";

export type RequestCommand = Extract<GamePortCommand, { id: string }>;
export type RequestKind = RequestCommand["kind"];
type ReplyKindOf<K extends RequestKind> = K extends "geometry"
	? "geometryResult"
	: K extends "observeMove"
		? "observeMoveResult"
		: K extends "boardCheck"
			? "boardCheckResult"
			: K extends "cursorProbe"
				? "cursorProbeResult"
				: K extends "cursorPrepare"
					? "cursorPrepared"
					: K extends "cursorDelivery"
						? "cursorDelivered"
						: K extends "startNewGame"
							? "startNewGameResult"
							: K extends "resign"
								? "resignResult"
								: K extends "rematch"
									? "rematchResult"
									: never;
export type ReplyFor<K extends RequestKind> = Extract<GamePortMessage, { kind: ReplyKindOf<K> }>;
/** A request without its `id`; `timeoutMs` defaults to the request budget. */
export type RequestInput<K extends RequestKind> = { kind: K } & Omit<
	Extract<RequestCommand, { kind: K }>,
	"id" | "kind" | "timeoutMs"
> & { timeoutMs?: number };

export type TabMessageListener = (msg: GamePortMessage) => void;
export type AnyMessageListener = (tabId: number, msg: GamePortMessage) => void;

/** The read-only event surface (what the focus gate and hand ownership need). */
export interface ContentLinkEvents {
	onMessage(tabId: "*", cb: AnyMessageListener): () => void;
	onMessage(tabId: number, cb: TabMessageListener): () => void;
	onDisconnect(cb: (tabId: number, reason?: string) => void): () => void;
	windowIdOf(tabId: number): number | null;
}

export interface ContentLinkOptions {
	scheduler?: Scheduler;
	now?: () => number;
}
