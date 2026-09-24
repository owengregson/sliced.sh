/**
 * Who holds the mouse: the one user switch (auto-move) that owns both the current hand and the
 * next game's preference, the automatic arm a new executor gets, and the releases that hand the
 * mouse back without forgetting that it was armed — a session break and the lobby.
 *
 * The arm is attached here only in the waiting view or at a game start, i.e. outside every move
 * window (§13.4); a re-arm mid-game would attach the debugger and shift the board.
 */

import { PANEL_COMMAND_ERRORS } from "@core/constants/cdp";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import { queueAutoMovePreference } from "@service/handlers/settings/write-queue";
import type { MoveExecutor } from "@service/move-executor";
import type { Settings } from "@typedefs/settings";
import type { SessionCore } from "./core";

export interface HandArmingHooks {
	/** The one re-delivery path (`GameSession.reconsider`), never rejecting. */
	reconsider(reason: string): Promise<void>;
	startOpponentExploration(): void;
	/** A disarm gives up whatever the hand was about to do: the resign and the premove. */
	cancelResign(): void;
	forgetPremove(reason: string): void;
	updateReviewAdmission(): void;
	/** Is a pipeline run in flight? A disarm leaves review admission to it then. */
	pipelineRunning(): boolean;
	hideCursor(): void;
	/** The lobby hold: the hand stays off the mouse on the queue screen. */
	lobbyHeld(): boolean;
}

export class HandArming {
	private preference: boolean;
	private requestVersion = 0;
	/** Local intent wins over older storage events until its serialized write settles. */
	private pendingIntent: { armed: boolean } | null = null;
	/** A failed preference command stays stopped until the user explicitly retries. */
	private persistenceFailed = false;
	/** The executor whose automatic arm is in flight (`autoArm`), so two paths cannot arm it twice. */
	private armingExecutor: MoveExecutor | null = null;
	/**
	 * The hand was armed when a session break began and was released for it (owner, 2026-09-13:
	 * "when taking a break we should unlock mouse"); the next game re-arms it, so a break is not
	 * the user's "stop". Cleared by an explicit disarm, by the switch, and once consumed.
	 */
	rearmAfterBreak = false;

	constructor(
		private readonly core: SessionCore,
		private readonly hooks: HandArmingHooks
	) {
		this.preference = core.settings().automation.autoMove;
	}

	/** `toggleAutoMove`: is the switch on (pending intent first, else the hand or a carried arm)? */
	switchedOn(): boolean {
		return this.pendingIntent?.armed ?? (this.core.executor?.isArmed() || this.rearmAfterBreak);
	}

	/** A settings write: the stored switch going off disarms, unless a local intent is in flight. */
	settingsChanged(settings: Settings): void {
		const stopped = this.preference && !settings.automation.autoMove;
		this.preference = settings.automation.autoMove;
		if (stopped && this.pendingIntent === null) this.disarm();
	}

	/** The one user switch owns both the current hand and the next game's preference. */
	async setAutoMove(armed: boolean): Promise<void> {
		const core = this.core;
		if (core.disposed) return;
		if (armed) {
			if (!core.mayAct()) throw new Error(PANEL_COMMAND_ERRORS.assistantOff);
			if (!core.executor) throw new Error(PANEL_COMMAND_ERRORS.noExecutor);
		}
		const intent = { armed };
		this.pendingIntent = intent;
		this.persistenceFailed = false;
		const version = ++this.requestVersion;
		try {
			if (armed) {
				await this.arm(true);
				if (core.disposed || version !== this.requestVersion) return;
				if (!core.executor?.isArmed() && !this.rearmAfterBreak) return;
			} else this.disarm();
			await queueAutoMovePreference(armed);
		} catch (error) {
			// An older failed request cannot undo a newer successful arm.
			if (this.pendingIntent === intent) {
				this.persistenceFailed = true;
				this.disarm();
			}
			throw error;
		} finally {
			if (this.pendingIntent === intent) this.pendingIntent = null;
		}
	}

	/** Does anything ask for the hand armed: the pending intent, a remembered arm, the stored default? */
	wantsAutoMove(remembered = false): boolean {
		return (
			!this.persistenceFailed &&
			(this.pendingIntent?.armed ?? (remembered || this.core.settings().automation.autoMove))
		);
	}

	private async arm(reportErrors = false): Promise<void> {
		const core = this.core;
		const executor = core.executor;
		if (!executor) {
			log.info("game-session: nothing to arm (no game on this tab)", { tabId: core.tabId });
			return;
		}
		if (!core.mayAct()) {
			// §4.4: an armed hand with nothing to play is a promise the switch says is off.
			log.info("game-session: arm refused — the assistant is off", { tabId: core.tabId });
			return;
		}
		if (this.hooks.lobbyHeld()) {
			// The queue screen: the mouse stays the owner's (they have to click Play with it). The
			// request is kept, as a break's is — the hand arms the moment a game is on the board —
			// and the debugger attaches now so the infobar lands here, outside every move window.
			this.rearmAfterBreak = true;
			this.preAttachForLobby();
			log.info("game-session: arm deferred — this is the lobby; the hand arms once a game starts", {
				tabId: core.tabId,
			});
			core.notify();
			return;
		}
		core.apply("armAutoMove");
		try {
			await executor.arm();
		} catch (error) {
			log.warn("game-session: arm failed", { error: errorMessage(error) });
			core.notify();
			if (reportErrors) throw error;
			return;
		}
		// The recommendation this arm may have raced is acted on through the one re-delivery path, not
		// a copy of it here: the gate, the `MoveContext` and the §3.3 answer all live in one place,
		// so the manual arm, the automatic arm and the panel's toggle cannot drift apart.
		await this.hooks.reconsider("the hand was armed");
		this.hooks.startOpponentExploration();
		core.notify();
	}

	disarm(): void {
		const core = this.core;
		this.requestVersion += 1;
		// `disarm()` cancels whatever the hand had pending first, so a premove that has not been
		// entered yet never is; `forgetPremove` then gives up the arm as well (an unarmed hand must
		// not fire a premove on the next position either).
		core.executor?.disarm();
		this.rearmAfterBreak = false;
		const executor = core.executor;
		void executor?.whenIdle().then(() => {
			if (!executor.isArmed() && !this.hooks.pipelineRunning()) this.hooks.updateReviewAdmission();
		});
		this.hooks.cancelResign();
		// The arrow stays where the hand left it (2026-09-13): the rest point is where the next arm
		// starts from (`HandOwnership.startPoint`), and the mirror is that point made visible. Only
		// the switch, the display setting or the tab going away hide it — see `BoardMarks.hideCursor`.
		this.hooks.forgetPremove("the hand was disarmed");
		core.apply("disarm");
		core.notify();
	}

	/**
	 * The automatic arm — `attachExecutor`'s and the lobby hold's one implementation. Fix G: awaited
	 * for its *result*, not fired and forgotten. `arm()` attaches the debugger, which is slow enough
	 * to lose the race with the first position — and the manual arm (Shift+A) has always re-checked
	 * the recommendation it may have raced, while this path once did not. At ply 0 as white that
	 * re-check is the only one there will ever be. One arm per executor at a time: the lobby ending
	 * on a `hello` and the `gameStarted` that follows it must not arm the same hand twice.
	 */
	autoArm(executor: MoveExecutor, reason: string): void {
		const core = this.core;
		if (
			this.persistenceFailed ||
			this.pendingIntent?.armed === false ||
			executor.isArmed() ||
			this.armingExecutor === executor
		)
			return;
		this.armingExecutor = executor;
		void executor
			.arm()
			.then(
				async () => {
					if (
						core.disposed ||
						core.executor !== executor ||
						this.persistenceFailed ||
						this.pendingIntent?.armed === false ||
						!executor.isArmed()
					)
						return;
					// A remembered arm is spent once it has taken effect — not before, so an executor
					// replaced mid-arm (`gameStarted` right after the lobby ended) still inherits it.
					if (core.executor === executor) this.rearmAfterBreak = false;
					await this.hooks.reconsider(reason);
					this.hooks.startOpponentExploration();
				},
				(error: unknown) => log.warn("game-session: re-arm failed", error)
			)
			.finally(() => {
				if (this.armingExecutor === executor) this.armingExecutor = null;
			});
	}

	/**
	 * A new executor replaces `previous`: was the hand armed (or released for a break, which counts
	 * as armed here — the break is over)? The carried arm is consumed by the asking.
	 */
	takeCarriedArm(previous: MoveExecutor | null): boolean {
		const wasArmed = (previous?.isArmed() ?? false) || this.rearmAfterBreak;
		this.rearmAfterBreak = false;
		return wasArmed;
	}

	/**
	 * `attachExecutor` would have armed `executor`: arm it now, or — on the lobby — remember the
	 * arm for the game and attach the debugger while the queue screen is up.
	 */
	armNewExecutor(executor: MoveExecutor, wasArmed: boolean): void {
		// Either way the attach happens here — before the first position of the game, i.e. outside
		// every move window (§13.4) — never once a move is due. §4.4: neither default arms anything
		// while the assistant is off.
		if (!this.core.mayAct() || !this.wantsAutoMove(wasArmed)) return;
		// The lobby (2026-09-13): a board with no game queued. The arm waits for the game
		// (`endLobbyHold`); a carried arm is remembered the way a break's is.
		if (this.hooks.lobbyHeld()) {
			this.withholdArmForLobby(wasArmed);
			return;
		}
		this.autoArm(executor, "the hand finished arming");
	}

	/**
	 * The auto-queue is taking a session break (owner, 2026-09-13: "when taking a break we should
	 * unlock mouse"). Within a playing session the hand stays armed between games so the next one
	 * starts at once; a break is long enough that the owner wants their mouse back: the hand is
	 * released (ownership dropped, focus no longer maintained), the mirror glides to the real
	 * pointer and hides, and `rearmAfterBreak` remembers to arm again when the next game starts.
	 * The debugger stays attached — re-attaching would put the infobar's layout shift inside the
	 * next game's first move window (see `DebuggerManager`).
	 */
	releaseForBreak(): void {
		const core = this.core;
		const armed = core.executor?.isArmed() === true;
		if (armed) {
			this.disarm();
			this.rearmAfterBreak = true;
		}
		this.hooks.hideCursor();
		log.info("game-session: session break — the mouse is released", {
			tabId: core.tabId,
			rearm: armed,
		});
		core.notify();
	}

	/**
	 * The lobby is confirmed: whatever holds the owner's mouse lets go. The hand, if armed, is
	 * released the way a session break releases it (`releaseForBreak`) — remembered, re-armed when
	 * a game is on the board — and the mirror is hidden whether or not the hand was armed, because
	 * an arrow parked from the previous game keeps the shield up on its own.
	 */
	releaseForLobby(): void {
		const armed = this.core.executor?.isArmed() === true;
		const rearm = armed || this.rearmAfterBreak;
		// An arm may still be awaiting debugger attachment, before isArmed becomes true.
		// Invalidate it too, so its late completion cannot reclaim the inactive board.
		this.disarm();
		this.rearmAfterBreak = rearm;
		this.hooks.hideCursor();
		log.info("game-session: lobby — the mouse is released until a game is queued", {
			tabId: this.core.tabId,
			rearm: armed,
		});
	}

	/**
	 * `attachExecutor` would have armed, but this is the lobby. A carried arm is remembered
	 * (`rearmAfterBreak`), the stored default is re-read when the hold ends, and the debugger
	 * attaches now so its infobar — and the layout shift it brings — lands on the queue screen,
	 * where there is no move window for it to fall into (§13.4).
	 */
	private withholdArmForLobby(remember: boolean): void {
		if (remember) this.rearmAfterBreak = true;
		log.info("game-session: lobby — the automatic arm waits for a game", {
			tabId: this.core.tabId,
			remembered: remember,
		});
		this.preAttachForLobby();
	}

	private preAttachForLobby(): void {
		const core = this.core;
		const attaching = core.deps.debugger.ensureAttached?.(core.tabId);
		attaching?.catch((error: unknown) =>
			log.debug("game-session: lobby pre-attach failed", { error: errorMessage(error) })
		);
	}
}
