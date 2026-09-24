/**
 * `Settings.enabled` (§4.4) and every other settings write, as the session reacts to them: re-send
 * what the content script acts on, re-derive the models, and on the switch's edge stop everything
 * (off) or resume from the live position (on).
 */

import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import type { MoveExecutor } from "@service/move-executor";
import { executorSettingsFor } from "../executor-settings";
import { timingSettingsFor } from "../presets";
import { isLiveState } from "../transitions";
import type { SessionCore } from "./core";
import type { GameLifecycle } from "./lifecycle";
import type { SessionParts } from "./parts";

export class AssistantSwitch {
	/** `mayAct()` as of the last settings write this session saw (§4.4 flip detection). */
	private acting: boolean;

	constructor(
		private readonly core: SessionCore,
		private readonly parts: SessionParts,
		private readonly lifecycle: GameLifecycle
	) {
		this.acting = core.mayAct();
	}

	/** Page admission participates in `mayAct`; keep settings-edge detection in sync with it. */
	resync(): void {
		this.acting = this.core.mayAct();
	}

	/**
	 * The settings changed: re-send what the content script acts on (`highlightMoves`, the
	 * keybinds — §13.3 rule 4 keeps both off/default until the worker says otherwise), and act on
	 * `Settings.enabled` (§4.4) when *that* is what changed — off stops everything this session
	 * could still do to the page, on picks the live position back up.
	 */
	onSettingsChanged(): void {
		const core = this.core;
		const settings = core.settings();
		this.parts.hand.settingsChanged(settings);
		const timing = timingSettingsFor(settings.timing, core.currentTimeControl());
		core.timing?.updateSettings(timing, {
			profile: settings.strength.persona,
			targetElo: core.targetElo(),
		});
		// A new target (or the human model switched on) may map to a different Maia size.
		this.parts.maia.recommitOnSettings(settings);
		const selectionChanged = core.gamePendingOrLive()
			? this.parts.maia.warmFor(core.targetElo())
			: false;
		core.executor?.updateSettings({
			persona: settings.strength.persona,
			...executorSettingsFor(settings.execution, settings.timing),
			verifyMoves: settings.execution.verifyMoves,
			inputMode: settings.execution.inputMode,
		});
		const on = core.mayAct();
		const flipped = on !== this.acting;
		this.acting = on;
		// Sent first either way: `highlightMoves` is reported as `enabled && highlightMoves`, so
		// this is also what clears a mark the content script has already drawn.
		this.parts.marks.pushContentSettings();
		// Move ratings off: the review work stops now rather than at the next position, whatever
		// board effects say (the review engine itself is released by `game-stack`).
		this.parts.effects.settingsChanged(on);
		// Fix D: the mirror is page DOM, so it goes the moment it is no longer allowed — which is
		// either the switch or `display.virtualCursor`, and only the switch makes `flipped` true.
		if (!this.parts.marks.virtualCursorAllowed()) this.parts.marks.hideCursor();
		if (!core.mayQueue()) core.deps.autoQueue.cancel(core.tabId);
		else if (core.game) this.lifecycle.cancelQueueForNewGame(core.game.gameId);
		// 2026-09-15: a held recommendation used to be retried here when the stored timing preset
		// stopped being `manual` mid-game. With the presets gone no setting can flip "may I
		// auto-play" — arming does, and `attachExecutor` / `autoArm` re-check the recommendation.
		if (!flipped) {
			if (on && selectionChanged) void this.resumeEnabled();
			return;
		}
		if (on) void this.resumeEnabled();
		else this.stopDisabled();
	}

	/**
	 * `Settings.enabled` went off mid-session (§4.4): the search in flight is aborted, the ponder
	 * stopped, the scheduled (or running) move cancelled, the auto-queue dropped, the board
	 * cleared, and the hand disarmed — with the debugger released, because §13.4 forbids the
	 * re-attach that would let it act again mid-game, so holding it would only keep the infobar.
	 * The state machine is left alone: the game on the page is still the game, and the panel's
	 * own `settings.enabled` projection is what greys the move card (Appendix F §5.6).
	 */
	private stopDisabled(): void {
		const core = this.core;
		this.parts.cancelInFlight();
		core.deps.autoQueue.cancel(core.tabId);
		core.rec = null;
		this.parts.forgetPremove("the assistant was turned off");
		const executor = core.executor;
		executor?.disarm();
		void this.releaseDebugger(executor);
		this.parts.marks.clear();
		this.parts.effects.clear();
		log.info("game-session: the assistant was turned off — nothing is analysed or played", {
			tabId: core.tabId,
			state: core.state,
		});
		core.notify();
	}

	/**
	 * Give the debugger back — but never while the hand is still winding down. `disarm()`'s abort
	 * needs several hops to reach the hand's release, and a detach that overtakes it leaves the page
	 * with a held mouse button and a piece stuck to the cursor, so the release is awaited first
	 * (`MoveExecutor.whenIdle`). A flip back on while waiting cancels the release: the hand is
	 * disarmed either way, and an attachment the user is about to re-arm is worth keeping.
	 */
	private async releaseDebugger(executor: MoveExecutor | null): Promise<void> {
		const core = this.core;
		try {
			await executor?.whenIdle();
			if (core.disposed || core.mayAct()) return;
			await core.deps.debugger.detach(core.tabId);
			core.notify();
		} catch (error) {
			log.debug("game-session: debugger not released", { error: errorMessage(error) });
		}
	}

	/**
	 * `Settings.enabled` came back on (§4.4): resume from the position the session is sitting on
	 * instead of waiting for the next one. The hand is *not* re-armed — that would attach the
	 * debugger mid-game (§13.4) — so an armed hand is the user's to ask for again, in the waiting
	 * view; until then this is panel-only mode (§7.5).
	 */
	async resumeEnabled(): Promise<void> {
		const core = this.core;
		const snapshot = core.snapshot;
		log.info("game-session: the assistant was turned back on", {
			tabId: core.tabId,
			state: core.state,
			resumed: snapshot !== null && isLiveState(core.state),
		});
		if (core.disposed || !snapshot || !isLiveState(core.state)) return;
		// A search already in flight (or a recommendation already standing) for this position is the
		// resume: the worker's first settings read can land after the session was built, so "on"
		// is not always a transition from a stopped session.
		if (this.parts.delivery.pipelineAc !== null || core.rec !== null) return;
		// The colour is its own hold (`mayActOn`): releasing the switch does not release a position
		// whose side we still do not know. The adapter republishes it once the bridge answers. Same
		// for a snapshot that contradicts itself — the switch coming back on is not new evidence
		// about whose move it is, so the resume holds exactly as `onPosition` did.
		if (!core.mayActOn(snapshot) || !core.selfConsistent(snapshot)) return;
		const myTurn = snapshot.sideToMove === snapshot.myColor;
		if (myTurn) await this.parts.delivery.runPipeline(snapshot);
		else await this.parts.opponentTurn.start(snapshot);
	}
}
