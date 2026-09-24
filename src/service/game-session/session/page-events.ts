/**
 * The content script's side of the session: the port feed (`hello`, `gameStarted`, `position`,
 * `gameEnded`, the opponent card, observed moves) and the tab's own navigation and removal.
 */

import type { GamePortMessage } from "@core/constants/messages";
import { log } from "@core/logger";
import type { GameMeta, GameResult, PageKind, PositionSnapshot, Site } from "@typedefs/game";
import type { AssistantSwitch } from "./assistant-switch";
import type { SessionCore } from "./core";
import type { GameLifecycle } from "./lifecycle";
import type { SessionParts } from "./parts";
import { motorTcClass, PLAYED_PAGES } from "./position-rules";

export class PageEvents {
	constructor(
		private readonly core: SessionCore,
		private readonly parts: SessionParts,
		private readonly lifecycle: GameLifecycle,
		private readonly assistant: AssistantSwitch,
		/** A `position` message: the session's own `onPosition` (the feed admits it first). */
		private readonly onPosition: (snapshot: PositionSnapshot) => Promise<void>
	) {}

	onPortMessage(msg: GamePortMessage): void {
		const core = this.core;
		if (core.disposed) return;
		switch (msg.kind) {
			case "hello":
				this.onHello(msg.site, msg.pageKind, msg.lobby === true);
				return;
			case "gameStarted":
				this.onGameStarted(msg.game);
				return;
			case "position":
				void this.onPosition(msg.snapshot);
				return;
			case "gameEnded":
				void (
					msg.gameId && core.game && msg.gameId !== core.game.gameId
						? Promise.resolve()
						: this.onGameEnded(msg.result, msg.replayed === true)
				)
					.then(() => {
						if (msg.eventId)
							core.deps.link.post(core.tabId, { kind: "gameEndReceived", eventId: msg.eventId });
					})
					.catch((error: unknown) => log.warn("game-session: game-end handling failed", error));
				return;
			case "opponent":
				core.opponentInfo = {
					isBot: msg.isBot,
					name: msg.name,
					ratingEstimate: msg.ratingEstimate,
					...(msg.title !== undefined ? { title: msg.title } : {}),
				};
				// Both ratings determine the query, including when the target is fixed.
				if (core.gamePendingOrLive() && this.parts.maia.warmFor(core.targetElo()))
					void this.assistant.resumeEnabled();
				// Re-read the clocks against the detector. The opponent itself proves nothing on the
				// queue screen — the card there is the *previous* opponent's after an auto-queue hop —
				// so only a running clock or a move ends the hold (`lobby.ts`).
				this.parts.lobby.review("an opponent was read");
				core.notify();
				return;
			case "moveObserved":
				log.debug("game-session: move observed", {
					tabId: core.tabId,
					san: msg.san,
					byMe: msg.byMe,
					atMs: msg.atMs,
				});
				core.history.observed(msg.byMe, msg.atMs);
				return;
			case "selectorMiss":
				log.warn("game-session: adapter selector miss", {
					tabId: core.tabId,
					selector: msg.selector,
				});
				return;
			default:
				return;
		}
	}

	onHello(site: Site, pageKind: PageKind, lobby = false): void {
		const core = this.core;
		const wasPlayable = PLAYED_PAGES.has(core.pageKind);
		core.site = site;
		core.pageKind = pageKind;
		// Page admission now participates in mayAct; keep settings-edge detection in sync.
		this.assistant.resync();
		if (!PLAYED_PAGES.has(pageKind)) {
			this.parts.cancelInFlight();
			this.parts.hand.releaseForLobby();
			if (!core.mayQueue()) core.deps.autoQueue.cancel(core.tabId);
			this.parts.marks.clear();
		}
		// Before the executor exists: `attachExecutor` reads the flag to withhold the arm on the lobby.
		this.parts.lobby.setPage(lobby);
		core.apply("hello");
		// §13.4: the hand must be armable *in the waiting view*, so the debugger's infobar (and
		// whatever it shifts) lands outside every move window. The executor therefore exists from
		// the moment the page says hello; `startGame` replaces it with the game's own profile and
		// carries the armed state (and the attachment) across.
		this.ensureExecutor(site);
		this.parts.marks.pushContentSettings();
		if (PLAYED_PAGES.has(pageKind)) this.parts.effects.warm();
		this.parts.lobby.review("hello");
		if (!wasPlayable && core.mayAct() && core.executor && !this.parts.lobby.held()) {
			if (this.parts.hand.wantsAutoMove(this.parts.hand.rearmAfterBreak))
				this.parts.hand.autoArm(core.executor, "a playable game returned");
		}
		core.notify();
	}

	/** A pre-game executor so `arm()` works before the first position (§13.4). */
	private ensureExecutor(site: Site): void {
		const core = this.core;
		if (core.executor) return;
		this.parts.executors.attach({
			site,
			persona: core.settings().strength.persona,
			// No time control is known yet; the game's own class replaces this at `startGame`.
			tcClass: motorTcClass("untimed"),
			gameSeed: `${core.seed}:pregame`,
		});
	}

	/** The tab navigated away from the game (`navigated`) or was closed (`tabRemoved`). */
	onTabEvent(event: "navigated" | "tabRemoved", preserveAutoQueue = false): void {
		const core = this.core;
		this.parts.cancelInFlight();
		if (!preserveAutoQueue) core.deps.autoQueue.cancel(core.tabId);
		core.rec = null;
		// The tab going away is one of the mirror's three hide reasons; a navigation is not — on
		// chess.com the route changes between every two games, and the arrow stays parked across it.
		if (event === "tabRemoved") this.parts.marks.hideCursor();
		this.parts.forgetPremove(event === "navigated" ? "the tab navigated away" : "the tab was closed");
		this.parts.marks.clear();
		this.parts.effects.clear();
		if (event === "navigated") core.game = null;
		core.apply(event);
		core.notify();
	}

	onGameStarted(meta: GameMeta): void {
		const core = this.core;
		if (core.game?.gameId === meta.gameId) return;
		// The URL flag travels as an optional `true` and is *omitted* when false, so an absent field
		// says "this message does not know", not "this is not the lobby" — `gameStarted` is posted
		// from `startSessionIfLive` the moment the page's game object has an id, which on the queue
		// screen can be before the debounced `redetect` has seen the new URL. Clearing the flag on an
		// omission therefore silently undid a `true` that `hello` had just set, and the hand armed on
		// the queue screen (owner, 2026-09-14). Only ever assert it here; `onHello` is what clears it,
		// and `redetect` re-announces `hello` precisely when the value changes, in either direction.
		if (meta.lobby === true) this.parts.lobby.setPage(true);
		this.lifecycle.startGame(meta);
		// Nothing of the previous game belongs on this board.
		this.parts.marks.clear();
		this.parts.effects.clear();
		core.apply("gameStarted");
		this.parts.lobby.review("gameStarted");
		core.notify();
	}

	onGameEnded(result: GameResult, replayed = false): Promise<void> {
		const core = this.core;
		// The mirror is deliberately *not* hidden here (2026-09-13): the game ending does not move
		// the pointer, and the next game's hand starts from the point the arrow is parked on —
		// `HandOwnership.position` survives the boundary, and so must the arrow that shows it.
		if (core.state === "game-over") return this.lifecycle.finishingGame ?? Promise.resolve();
		if (!core.apply("gameEnded")) return Promise.resolve();
		this.parts.cancelInFlight();
		const executionSettled = core.executor?.whenIdle() ?? Promise.resolve();
		core.rec = null;
		this.parts.forgetPremove("the game ended");
		this.parts.marks.clear();
		this.parts.effects.clearAfterGame();
		this.lifecycle.finishingGame = replayed
			? Promise.resolve()
			: this.lifecycle.finishGame(result, executionSettled);
		core.notify();
		return this.lifecycle.finishingGame;
	}
}
