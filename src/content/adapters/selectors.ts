/**
 * chess.com selector registry (C1 registry file; Appendix C §5 transcribed once).
 *
 * Every selector string used under `src/content/**` lives here. Arrays are
 * ordered candidate ladders (newest markup first) consumed through
 * `queryFirst` / `queryAllFirst`; `probe()` reports which index matched per
 * concern. Single strings are stable structural anchors or class names.
 * Regexes match class attributes whose token order varies.
 */

import type { Color, PromoPiece } from "@typedefs/game";

const NEW_GAME_IDENTITIES = [
	'[data-cy="game-over-modal-new-game-button"]',
	'[data-cy="sidebar-game-over-new-game-button"]',
	'[aria-label="New Game"]',
] as const;

export const SELECTORS = {
	freeTitle: {
		account: 'a.sidebar-link[data-user-activity-key="profile"][href]',
		block: ".cc-user-block-component",
		username: '.cc-user-username-component, [data-test-element="user-tagline-username"]',
		large: ".cc-user-block-large",
		title: ".cc-user-title-component",
		profile: ".profile-badges",
		profileNative: ".profile-badge:has(.badges-titled)",
		profileStreak: ".profile-badge:has(.streak-badge-icon, .streak-badge-name)",
		popover: ".user-popover-content",
		tagline: ".user-popover-tagline",
		avatar: "a.user-popover-avatar[href]",
		about: ".user-popover-about",
		ratings: ".user-popover-ratings",
		popoverBadges: ".user-popover-badges-component",
		popoverNative: ".user-popover-badges-titled",
		classes: {
			small: "cc-user-title-component cc-text-x-small-bold",
			large: "cc-user-title-component cc-text-x-large-bold",
			profile: "profile-badge",
			profileIcon: "badges-icon-square badges-titled",
			profileAbout: "badges-about",
			profileName: "cc-heading-xx-small badges-name",
			profileExtra: "cc-text-small badges-extra",
			popoverBadges: "user-popover-badges-component",
			popoverBadge: "user-popover-badges-badge user-popover-badges-titled",
			popoverLabel: "cc-text-small-bold user-popover-badges-label",
		},
	},
	// board + pieces (§1.2)
	/** Custom-element tag the MAIN-world bridge awaits (`customElements.whenDefined`). */
	boardTag: "wc-chess-board",
	board: [
		"wc-chess-board#board-single",
		"wc-chess-board#board-play-computer",
		"wc-chess-board",
		"chess-board",
		"#board-single",
		".board",
	],
	boardFlippedClass: "flipped",
	piece: ".piece",
	pieceCodeRe: /\b([wb])([prnbqk])\b/,
	squareRe: /\bsquare-([1-8])([1-8])\b/,
	highlight: ".highlight",
	dragging: ".piece.dragging",
	hover: ".hover-square",
	coordinateLight: "svg.coordinates text.coordinate-light",
	// move list (§1.3)
	moveList: [
		"wc-simple-move-list",
		"wc-vertical-move-list",
		"wc-horizontal-move-list",
		".move-list",
		".vertical-move-list",
		"#move-list",
	],
	moveRow: ".main-line-row",
	moveNode: [
		".node.main-line-ply",
		".node",
		"[data-node]",
		"[data-ply]",
		".move-text-component",
		".move-text",
	],
	moveListAnnotationNodes: ".node.main-line-ply[data-node]",
	moveListNodeAttr: "data-node",
	moveListOffsetClass: "offset-for-annotation-icon",
	moveListDecoration: "svg, .node-annotation-icon",
	moveText: [".node-highlight-content", ".move-san"],
	moveSelected: [
		".node-highlight-content.selected",
		".node .selected",
		".move-node-highlighted .move-text-component",
		".move-node.selected .move-text",
	],
	moveNodeWhiteClass: "white-move",
	figurine: "[data-figurine]",
	figurineAttr: "data-figurine",
	result: [".result-row .game-result", "wc-simple-move-list .result-text", ".result-text"],
	// clocks (§1.4)
	clock: ".clock-component",
	clockTop: ".clock-component.clock-top",
	clockBottom: ".clock-component.clock-bottom",
	clockColor: { w: ".clock-white", b: ".clock-black" } as const,
	clockActive: [".clock-player-turn", ".clock-playerTurn", ".running"],
	clockTime: [".clock-time-monospace", '[role="timer"]', '[data-cy="clock-time"]'],
	computerClock: ".player-row-component .move-time-time.player-row-move-time",
	computerClockDark: ".move-time-dark",
	computerClockTime: ".move-time-content.move-time-monospace",
	// players (§1.5)
	playerTop: [
		"#board-layout-player-top",
		".board-layout-player.board-layout-top",
		".player-component.player-top",
	],
	playerBottom: [
		"#board-layout-player-bottom",
		".board-layout-player.board-layout-bottom",
		".player-component.player-bottom",
	],
	username: [
		".cc-user-username-component",
		'[data-test-element="user-tagline-username"]',
		".user-username-component",
		".user-tagline-username",
	],
	rating: [
		".cc-user-rating-white",
		".cc-user-rating-black",
		".user-tagline-rating",
		".player-rating",
	],
	/** The title chip inside a player card (`<div class="cc-user-title-component …">FM</div>`), 2026-09-13. */
	playerTitle: ".cc-user-title-component",
	bottomColorClass: { w: ".cc-user-block-white", b: ".cc-user-block-black" } as const,
	capturedPieces: "wc-captured-pieces[player-color]",
	/** Read-only game toolbar supplied by the owner: no live game owns this board. */
	postGameToolbar: ".game-icons-container-component",
	postGameActions: [
		'button[aria-label="Share"], button:has(svg[data-glyph="graph-nodes-share"])',
		'button[aria-label="Add to Collection"], button:has(svg[data-glyph="board-simple-stack-plus"])',
		'a[href*="/analysis/game/live/"]',
	],
	// game over / new game (§1.6)
	gameOver: [
		".game-over-modal-shell-content",
		".game-over-modal-container",
		".game-over-modal-content",
		"wc-game-over-modal",
		".game-over-modal",
		".player-game-over-component",
		".game-over-header-component",
		".board-modal-container-container",
		".game-result-component",
	],
	gameOverHeader: ".game-over-modal-header-component",
	gameOverTitle: ".game-over-modal-title-component",
	gameOverHeaderClassRe: /\bgame-over-modal-header-(userWon|userLost|whiteWon|blackWon|draw)\b/,
	newGame: [
		...NEW_GAME_IDENTITIES,
		".game-over-modal-shell-buttons button",
		".new-game-buttons-buttons button",
		".new-game-buttons-component button",
		".game-over-buttons-component button",
		'[data-cy="game-over-modal-play-again-button"]',
	],
	newGameIdentity: NEW_GAME_IDENTITIES.join(","),
	lobbyPlay: [".play-menu-component button"],
	lobbyPlayTextRe: /^play(?:\s+online)?$/i,
	newGameTextRe: /^new\s+(?:game\b|\d)/i,
	playAgainTextRe: /^play\s+again\b/i,
	rematchTextRe: /\brematch\b/i,
	queueTextRe:
		/^(?:cancel(?:\s+(?:search|game|challenge))?|searching\b.*|finding\s+(?:an?\s+)?opponent\b.*|looking\s+for\s+(?:an?\s+)?opponent\b.*|waiting\s+for\s+(?:an?\s+)?opponent\b.*)$/i,
	queueCancel: [
		'[data-cy="seek-cancel-button"]',
		'[data-cy="cancel-seek-button"]',
		'[data-cy="matchmaking-cancel-button"]',
		'[aria-label="Cancel Search"]',
	],
	queueStatus: [
		".seek-component",
		".matchmaking-component",
		".play-menu-component [role='status']",
		".new-game-buttons-component [role='status']",
	],
	actionHidden: '[hidden], [aria-hidden="true"], [inert]',
	actionDisabled: '[disabled], [aria-disabled="true"], [aria-busy="true"]',
	actionNativeDisabled: ":disabled",
	rematch: [
		'[data-cy="game-over-modal-rematch-button"]',
		'[data-cy="sidebar-game-over-rematch-button"]',
		'[aria-label="Rematch"]',
		".new-game-buttons-rematch",
		".game-over-buttons-incoming-rematch button",
	],
	// rematching titled players (2026-09-13). The owner's captures: the outgoing offer is
	// `<button … aria-label="Rematch">` beside the new-game button; an incoming offer replaces
	// both with `.game-over-buttons-incoming-rematch` holding `aria-label="Decline Rematch"` /
	// `aria-label="Accept Rematch"`. The cancel of a pending outgoing offer was not captured, so
	// it is a labelled search inside the game-over button containers (the open QA item).
	/** Our outgoing offer: exactly "Rematch", never a button inside the incoming panel. */
	rematchOffer: [
		'[data-cy="game-over-modal-rematch-button"]',
		'[data-cy="sidebar-game-over-rematch-button"]',
		'button[aria-label="Rematch"]',
		".new-game-buttons-rematch",
	],
	rematchOfferTextRe: /^rematch$/i,
	/** The incoming-offer panel ("Good game! Rematch?") and its two answers. */
	rematchIncoming: ".game-over-buttons-incoming-rematch",
	rematchAccept: [
		'button[aria-label="Accept Rematch"]',
		'[aria-label="Accept Rematch"]',
		".game-over-buttons-incoming-rematch button",
	],
	rematchAcceptTextRe: /^accept\b/i,
	rematchDecline: [
		'button[aria-label="Decline Rematch"]',
		'[aria-label="Decline Rematch"]',
		".game-over-buttons-incoming-rematch button",
	],
	rematchDeclineTextRe: /^decline\b/i,
	/** Where a pending offer's cancel control can live: the game-over button containers. */
	rematchCancelScope: [
		".game-over-buttons-component",
		".game-over-buttons-buttons",
		".game-over-modal-shell-buttons",
		".new-game-buttons-component",
		".new-game-buttons-buttons",
	],
	rematchCancelControl: 'button, [role="button"]',
	/** "Cancel" / "Cancel Rematch" / "Cancel rematch offer" — but never a matchmaking "Cancel Search". */
	rematchCancelLabelRe: /\bcancel\b/i,
	rematchCancelSearchRe: /\bsearch\b/i,
	// resign (2026-09-12). chess.com's live-game markup for the resign control and its "Resign?"
	// confirmation is not captured in the fixtures, so both are candidate ladders (most specific
	// first) plus a text fallback — the open QA item in `docs/qa/resign-2026-09-12.md`.
	resign: [
		'[data-cy="resign-button"]',
		'[data-cy="game-controls-resign-button"]',
		'button[aria-label="Resign"]',
		'[aria-label="Resign"]',
		".resign-button-component",
		".game-controls-component button",
		".game-controls-container button",
		".board-layout-controls button",
	],
	resignTextRe: /^resign$/i,
	/** Matches an `aria-label` / `title` that mentions resigning ("Resign", "Resign game"). */
	resignLabelRe: /\bresign\b/i,
	resignConfirm: [
		'[data-cy="resign-confirm-button"]',
		'[data-cy="confirm-resign-button"]',
		'button[aria-label="Yes"]',
		'[role="dialog"] button',
		".board-modal-container-container button",
		".board-modal-container button",
		"wc-modal button",
		".modal-content button",
		".cc-modal-component button",
		".confirm-button",
		".game-controls-component button",
		".game-controls-container button",
	],
	/**
	 * The confirmation appears in a popup after the resign click (owner, 2026-09-12). Every
	 * clickable control on the page — the popup's buttons are found as controls that were *not*
	 * visible before the resign click, whatever their class names.
	 */
	resignAnyControl: 'button, [role="button"], a[href]',
	/** Containers a confirmation popup is likely to live in; a new control inside one ranks first. */
	resignPopup: [
		'[role="dialog"]',
		'[role="alertdialog"]',
		".board-modal-container-container",
		".board-modal-container",
		"wc-modal",
		".modal-content",
		".cc-modal-component",
		".popup",
		".confirm-modal",
	],
	/** The confirmation's own label is exactly "Resign" (the owner, 2026-09-13): nothing looser. */
	resignConfirmTextRe: /^resign$/i,
	// promotion (§1.9)
	promotionWindow: [
		".promotion-window",
		".promotion-window-3d",
		".promotion-menu",
		"wc-promotion-window",
	],
	promotionPiece: (c: Color, p: PromoPiece): string => `.promotion-piece.${c}${p}`,
	promotionPieceAny: ".promotion-piece",
	dailySubmit: ".daily-game-footer-component",
	// bots (V2 §13.6)
	botCard: [".bot-component", ".play-computer-bot-card", ".bot-selection-component"],
	botName: [".bot-component-name", ".bot-name", ".cc-user-username-component"],
	botRating: [".bot-component-rating", ".bot-rating", ".cc-user-rating-white"],
	botCta: '[data-cy="bot-selection-cta-button"]',
} as const;

/** Promotion picker order (the `.promotion-piece` index chess.com renders). */
export const PROMOTION_ORDER: readonly PromoPiece[] = ["q", "n", "r", "b"];
