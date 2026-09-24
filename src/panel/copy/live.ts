import { COMMON_COPY } from "./app";

// ── Task 24: Live view ─────────────────────────────────────────────────────────────────────
/** Strings the Live view adds to Appendix F §7.2 (§4.4 anatomy, §9.7 hand state, §13.6 band). */
export const COPY_LIVE = {
	secondary: "Session",
	configuration: (highlight: boolean, autoqueue: boolean): string =>
		`Highlight ${highlight ? COMMON_COPY.on : COMMON_COPY.off} · Auto-queue ${autoqueue ? COMMON_COPY.on : COMMON_COPY.off}`,
	/** Your row when the site gives no display name. */
	you: "You",
	cancel: "Cancel",
	strength: {
		header: "Active strength",
		rating: "Target rating",
		chip: (elo: number, persona: string): string => `${elo} · ${persona}`,
	},
	lines: {
		count: (n: number): string => `${n}`,
		countLabel: "Lines shown",
	},
	hand: {
		label: "Hand",
		resting: "resting",
		exploring: "exploring",
		moving: "moving",
		paused: "paused",
		detached: "detached",
	},
	band: {
		stats: (top1: number, loss: number, moves: number): string =>
			`${top1}% top-1 · ${loss} cp search loss · ${moves} moves`,
		target: (lo: number, hi: number, lossLo: number, lossHi: number, minMoves: number): string =>
			`Search-time root comparisons, not post-game ACPL or measured Elo. Reference ${lo}–${hi}% top-1 · ${lossLo}–${lossHi} cp. Warnings require ${minMoves}+ comparable choices per game and an uncertainty interval wholly outside the reference. Intervals are approximate noise guards; chess moves are correlated. Same rating band, strength settings and time control only.`,
		warning: (games: number): string => `${games} sampled games outside reference`,
	},
	clock: { opponent: "Opponent clock", you: "Your clock" },
	executorLabel: "Executor",
	/** Session strip before the first measured move: no "% vs target" figure yet. */
	sessionNoStats: (games: number, avg: string | null): string =>
		`${games} games · ${avg === null ? "—" : `${avg}s`} avg move`,
	timingSampleCount: (n: number): string =>
		`${n} measured turns, including analysis and input. Historical hand-only timing and queued premoves are excluded.`,
} as const;
