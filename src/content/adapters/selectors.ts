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

export const SELECTORS = {
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
	bottomColorClass: { w: ".cc-user-block-white", b: ".cc-user-block-black" } as const,
	capturedPieces: "wc-captured-pieces[player-color]",
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
		'[data-cy="game-over-modal-new-game-button"]',
		'[data-cy="sidebar-game-over-new-game-button"]',
		'[aria-label="New Game"]',
		".game-over-modal-shell-buttons button",
		".new-game-buttons-buttons button",
		".new-game-buttons-component button",
		".game-over-buttons-component button",
	],
	newGameTextRe: /new\s*(game|\d)/i,
	rematch: [
		'[data-cy="game-over-modal-rematch-button"]',
		'[data-cy="sidebar-game-over-rematch-button"]',
		'[aria-label="Rematch"]',
		".new-game-buttons-rematch",
		".game-over-buttons-incoming-rematch button",
	],
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
