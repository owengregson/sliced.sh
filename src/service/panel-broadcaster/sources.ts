/**
 * The broadcaster's read surface. `GameSessionRegistry` did not exist when the broadcaster was
 * written (Task 30 ruling): `SnapshotSources` is the narrow read surface it needs — Task 30's
 * registry implements `session(tabId)` / `executor(tabId)` and passes the shared
 * `DebuggerManager` / `FocusGate` / `HandOwnership` as `hand`. Without one, a service worker runs
 * on `idleSnapshotSources()` (no game tab, no hand).
 */

import type { PanelSnapshot } from "@core/constants/messages";
import type { DebuggerManager } from "@service/debugger-manager";
import type { FocusGate } from "@service/focus-gate";
import type { HandOwnership } from "@service/hand-ownership";
import type { LicenseGate } from "@service/license-gate";
import type { MoveExecutor } from "@service/move-executor";
import type { EngineStatus } from "@typedefs/engine";
import type { GameSessionView, Recommendation } from "@typedefs/game";
import type { LicenseState } from "@typedefs/settings";

/** The game facts of a session; `hand` / `lastExecution` come from the executor. */
export type SessionGameView = Omit<GameSessionView, "hand" | "lastExecution">;
export type OpponentView = NonNullable<PanelSnapshot["opponent"]>;

/** What the broadcaster reads from one tab's `GameSession`. */
export interface SessionSource {
	/** One explicit user switch controls this hand and the saved next-game preference. */
	setAutoMove?(armed: boolean): Promise<void>;
	/** Sidebar shortcuts use the same action path as the game page. */
	onKeybind?(action: string): Promise<void>;
	view(): SessionGameView;
	/** The current position's recommendation (§3.2 step 4), if my turn has one. */
	recommendation(): Recommendation | null;
	/** V2 §13.6 opponent identity with the derived target, once the adapter reported it. */
	opponent(): OpponentView | null;
	/**
	 * The hand was armed from outside the session (`PANEL_SET_AUTO_MOVE`): act on whatever the
	 * unarmed hand made the session withhold (§3.2 step 5).
	 *
	 * The session owns this, not the caller. Only it can answer whether a move is still owed for the
	 * position it is holding (the §3.3 state, not the snapshot) and only it can build the
	 * `MoveContext` the §13.2 exploration plans from — and a caller that scheduled for itself would
	 * be a second hand-written copy of the "is a move already pending" gate, which is how a double
	 * move gets shipped. Never rejects: the arm it follows has already succeeded, so a failure here
	 * must not tell the panel the arm failed.
	 */
	handArmed(): Promise<void>;
	/**
	 * The panel asked for the move to play at once (`PANEL_PLAY_NOW`, §8.5's manual path). Resolves
	 * `true` when there was a move — the scheduled one, else the standing recommendation — and it was
	 * handed to the hand; `false` when there was nothing to play, which is the caller's cue to report
	 * that. It does **not** wait for the hand: the outcome reaches the panel through the broadcaster.
	 *
	 * Here for the same reason as `handArmed()`: only the session can re-plan the move for an instant
	 * play (`TimingModel.replan`) and build the `MoveContext` the hand's §13.2 exploration reads, so a
	 * caller that played it for itself would hand the hand an empty context. Never rejects.
	 */
	playNowRequested(): Promise<boolean>;
}

/** The per-tab executor surface the panel handlers and the broadcaster use. */
export type ExecutorHandle = Pick<
	MoveExecutor,
	| "isArmed"
	| "pendingMove"
	| "runningMove"
	| "handView"
	| "on"
	| "arm"
	| "disarm"
	| "schedule"
	| "playNow"
	| "cancel"
	| "whenIdle"
>;

/** The shared hand stack (one per service worker; Task 18's singletons). */
export interface HandSources {
	debugger: Pick<DebuggerManager, "isAttached" | "lastError" | "ensureAttached" | "detach">;
	focus: Pick<FocusGate, "snapshot">;
	ownership: Pick<HandOwnership, "realPointerCount">;
}

export interface SnapshotSources {
	/** The game session on `tabId`, or `null` (idle snapshot). */
	session(tabId: number): SessionSource | null;
	/** The move executor on `tabId`, or `null` (no hand: unarmed, detached). */
	executor(tabId: number): ExecutorHandle | null;
	/** `null` until Task 30 constructs the hand stack. */
	hand: HandSources | null;
	/** Last status the offscreen host reported (`RemoteEngine.status()`); `undefined` before any. */
	engineStatus(): EngineStatus | undefined;
	license(): LicenseState;
}

/** Sources for a service worker without a session registry (every tab idle). */
export function idleSnapshotSources(license: Pick<LicenseGate, "getState">): SnapshotSources {
	return {
		session: () => null,
		executor: () => null,
		hand: null,
		engineStatus: () => undefined,
		license: () => license.getState(),
	};
}

/**
 * Sources whose registry is supplied after the broadcaster exists. The broadcaster is built
 * before the game stack so the stack can push snapshots into it, while its sources are the
 * registry the stack then constructs — a cycle, resolved through this holder rather than a
 * closure over a later `const`: a source read before `bind` answers "idle" instead of throwing
 * a temporal-dead-zone error at worker boot.
 */
export function lateBoundSources(license: () => LicenseState): {
	sources: SnapshotSources;
	bind(target: SnapshotSources): void;
} {
	let bound: SnapshotSources | null = null;
	return {
		sources: {
			session: (tabId) => bound?.session(tabId) ?? null,
			executor: (tabId) => bound?.executor(tabId) ?? null,
			get hand() {
				return bound?.hand ?? null;
			},
			engineStatus: () => bound?.engineStatus(),
			license,
		},
		bind(target) {
			bound = target;
		},
	};
}
