/**
 * Selector registry (C1 registry file; Appendix C §5 transcribed once).
 *
 * Every selector string used under `src/content/**` lives here. Arrays are
 * ordered candidate ladders (newest markup first) consumed through
 * `queryFirst` / `queryAllFirst`; `probe()` reports which index matched per
 * concern. Single strings are stable structural anchors or class names.
 * Regexes match class attributes whose token order varies.
 */

import type { Color, PromoPiece } from "@typedefs/game";

export const SELECTORS = {
	chesscom: {
		// board + pieces (§1.2)
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
	},
	lichess: {
		// board (§2.2)
		wrap: [".round__app .cg-wrap", ".main-board .cg-wrap", ".cg-wrap.manipulable", ".cg-wrap"],
		board: "cg-board",
		container: "cg-container",
		wrapClass: "cg-wrap",
		orientationBlack: "orientation-black",
		manipulable: "manipulable",
		pieceTag: "piece",
		pieceRoles: ["king", "queen", "rook", "bishop", "knight", "pawn"],
		whiteClass: "white",
		blackClass: "black",
		lastMove: "square.last-move",
		check: "square.check",
		anim: "piece.anim",
		dragging: "piece.dragging",
		ghost: "piece.ghost",
		fadingClass: "fading",
		ghostClass: "ghost",
		animClass: "anim",
		draggingClass: "dragging",
		translateRe: /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/,
		coordsFiles: "coords.files",
		coordsFilesBlack: "coords.files.black",
		// page structure (§2.1)
		roundApp: ".round__app",
		main: "main",
		mainRoundClass: "round",
		mainAnalyseClass: "analyse",
		bodyPlayingClass: "playing",
		// move list (§2.3) — ladders for known tag rotations; structural discovery is primary
		moves: ["aPp", "l4x", ".moves", ".tview2"],
		move: ["Z7yx", "kwdb", "u8t", ".tview2 move"],
		index: ["qZM", "i5z", "index"],
		active: [".a1t", "move.active"],
		/** Class lila puts on non-move text children of the moves container. */
		plainTextClass: "text",
		/** Tags that can never be the moves container (structural detector exclusion). */
		nonMoveContainerTagRe: /^(DIV|SPAN|BUTTON|A|P|SVG|CG-BOARD|CG-CONTAINER|COORDS|NAME|RATING)$/,
		sanTextRe: /^[a-hKQRBNO0-9x+#=\-…]+$/,
		sanNoiseRe: /[?!½]/g,
		result: [".result-wrap .result", ".result-wrap", ".tview2 .result"],
		status: ".result-wrap .status",
		// clocks (§2.4)
		clock: ".rclock",
		clockRunning: ".rclock.running",
		clockRunningClass: "running",
		clockColor: { w: ".rclock-white", b: ".rclock-black" } as const,
		clockTime: ".time",
		clockTenths: "tenths",
		corresTurn: ".rclock-turn__text",
		// players (§2.5, V2 §13.6)
		playerTop: ".ruser-top",
		playerBottom: ".ruser-bottom",
		playerName: "name",
		playerRating: "rating",
		myUserTag: "#user_tag",
		aiNameRe: /lichess\s+AI\s+level\s+(\d)/i,
		// game over / new game (§2.5)
		followUp: ".rcontrols .follow-up",
		rematch: ["button.fbt.rematch", ".follow-up .rematch", 'a.fbt.text[href*="/"]'],
		newOpponent: ["button.fbt.new-opponent", ".follow-up .new-opponent"],
		controls: ".rcontrols .ricons",
		resign: "button.fbt.resign",
		draw: "button.fbt.draw-yes",
		abort: "button.fbt.abort",
		takeback: "button.fbt.takeback-yes",
		// promotion (§2.9)
		promotion: "#promotion-choice",
		promotionSquare: "square",
		promotionOrder: ["q", "n", "r", "b"] as const,
		keyboardInput: ".keyboard-move input.ready",
		analysisFen: ".analyse__underboard .copyables input, input.copyable",
	},
} as const;

export type ChesscomSelectors = typeof SELECTORS.chesscom;
export type LichessSelectors = typeof SELECTORS.lichess;

/** Elo estimate per lichess AI level (V2 §13.6). */
export const LICHESS_AI_ELO: Readonly<Record<number, number>> = {
	1: 800,
	2: 1100,
	3: 1400,
	4: 1700,
	5: 2000,
	6: 2300,
	7: 2700,
	8: 3000,
};
