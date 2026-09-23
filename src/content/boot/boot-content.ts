/**
 * The content script's composition root, once `<body>` exists: builds the site adapter on a
 * `PageBridgeClient`, the page-side layers (highlights, board effects, move-list ratings, the
 * free-title badges, the pointer mirror behind the input shield), opens the game port and wires
 * them:
 *   - the game feed (`hello`, `opponent`, `gameStarted`, `position`, `moveObserved`) and
 *     `gameEnded`;
 *   - every `focus` / `blur` / `visibilitychange` edge as `focus`;
 *   - the board's viewport rect as `boardRect` whenever the page moves or resizes it (§9.5), so
 *     the service worker never drives the hand into coordinates the page has already left behind;
 *   - page-kind re-detection on `popstate`, on the adapter's game start and page-kind change, and
 *     on a `location.href` change, re-sending `hello` when it changes;
 *   - the command router (`command-router.ts`) for everything the worker sends;
 *   - the initial keybinds from the `CONTENT_HELLO` request.
 *
 * Every listener / timer is released by `dispose()`. No page storage, no synthetic events, no DOM
 * insertion from this world (§13.3).
 */

import { createChesscomAdapter } from "@content/adapters/chesscom";
import { createBoardEffects } from "@content/board-effects";
import { createFeedPort, type FeedPort } from "@content/feed-port";
import { createFreeTitle } from "@content/free-title";
import { createHighlights } from "@content/highlights";
import { createMoveListRatings } from "@content/move-list-ratings";
import { createPageBridgeClient } from "@content/page-bridge-client";
import type { GamePortMessage } from "@core/constants/messages";
import { MSG } from "@core/constants/messages";
import { sendTyped } from "@core/messaging/typed-messages";
import type { Site } from "@typedefs/game";
import { createCommandRouter } from "./command-router";
import { createControlReads } from "./control-reads";
import type { CursorBinding } from "./cursor-binding";
import { createGameFeed } from "./game-feed";
import { createInputShield } from "./input-shield";
import { watchNavigation } from "./navigation";
import { createOpponentPoll } from "./opponent-poll";
import { createPageState } from "./page-state";
import { createResponders } from "./responders";
import type { ContentHandle, ContentOptions } from "./types";

export function bootContent(
	site: Site,
	win: Window,
	doc: Document,
	options: ContentOptions,
	cursorBinding: CursorBinding
): ContentHandle {
	const adapterVersion = options.adapterVersion ?? __SL_VERSION__;
	const ownBridge = options.bridge === undefined;
	const bridge = options.bridge ?? createPageBridgeClient({ window: win });
	const adapter = createChesscomAdapter({ document: doc, window: win, bridge });
	const highlights = createHighlights(adapter, false);
	// Its own layer, its own setting and its own clear (§13.3 rule 4: off until `settings` says so).
	const moveListRatings = createMoveListRatings(bridge);
	const freeTitle = createFreeTitle(doc, win);
	const boardEffects = createBoardEffects(bridge, { flipped: () => adapter.isFlipped() });
	const page = createPageState(adapter, win);
	const cursor = cursorBinding.tracker;
	const shield = createInputShield(cursorBinding, bridge, () => page.kind);
	const virtualCursor = shield.virtualCursor;
	let disposed = false;
	let port: FeedPort | null = null;
	const disposers: Array<() => void> = [cursorBinding.removeKeybinds];
	const isDisposed = (): boolean => disposed;

	// ---- outgoing ---------------------------------------------------------------
	const post = (msg: GamePortMessage): void => {
		if (!disposed) port?.post(msg);
	};
	const opponent = createOpponentPoll(adapter, post, isDisposed);
	disposers.push(opponent.stop);
	cursorBinding.onSample = (s) => post({ kind: "cursor", ...s });
	const feed = createGameFeed({
		site,
		adapterVersion,
		adapter,
		page,
		opponent,
		post,
		disposed: isDisposed,
		onGame: (gameId) => moveListRatings.setGame(gameId),
		onPageChanged: () => shield.releaseIfOffGamePage(),
	});

	// ---- incoming ---------------------------------------------------------------
	const handleCommand = createCommandRouter({
		binding: cursorBinding,
		shield,
		highlights,
		boardEffects,
		moveListRatings,
		freeTitle,
		responders: createResponders({ adapter, bridge, cursor, post, disposed: isDisposed }),
		controls: createControlReads({ adapter, virtualCursor, post, disposed: isDisposed }),
		post,
		disposed: isDisposed,
	});

	// ---- wiring -------------------------------------------------------------------
	const ownPort = options.port === undefined;
	port = options.port
		? options.port(handleCommand)
		: createFeedPort({
				onCommand: handleCommand,
				// The worker went away: nobody is left to move the mirror or lower the shield.
				onDisconnect: shield.release,
			});
	feed.hello();
	opponent.read();
	feed.startSessionIfLive();

	disposers.push(adapter.onPositionChange(feed.publish));
	// §9.5: the board moving under the hand is a geometry change the service worker must know about
	// before it commits the rest of a drag to the old coordinate space.
	disposers.push(
		adapter.onBoardRect((rect) =>
			post({
				kind: "boardRect",
				rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
			})
		)
	);
	disposers.push(adapter.onGameStart(() => feed.redetect()));
	disposers.push(adapter.onPageKindChange(feed.redetect));
	disposers.push(adapter.onGameEnd((result) => post({ kind: "gameEnded", result })));
	disposers.push(adapter.onFocusEdge((edge) => post({ kind: "focus", ...edge })));
	disposers.push(watchNavigation(win, feed.redetect));

	sendTyped({ type: MSG.CONTENT_HELLO })
		.then((reply) => {
			if (!disposed && reply && reply.keybinds) cursorBinding.keybinds = reply.keybinds;
		})
		.catch(() => {
			// SW asleep or absent: keep the defaults until a `keybinds` command arrives
		});

	return {
		site,
		adapter: () => adapter,
		pageKind: () => page.kind,
		dispose() {
			if (disposed) return;
			disposed = true;
			feed.stopReadyPoll();
			for (const d of disposers.splice(0).reverse()) d();
			// Before the bridge goes: the mirror and the effect layer are page DOM and must not be
			// left behind (§13.3).
			boardEffects.dispose();
			moveListRatings.dispose();
			freeTitle.dispose();
			virtualCursor.dispose();
			cursor.dispose();
			adapter.destroy();
			if (ownPort) port?.dispose();
			if (ownBridge) bridge.dispose?.();
		},
	};
}
