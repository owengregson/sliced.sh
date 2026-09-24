/**
 * tools/timing-crawl/policy.ts — the pure half of the think-time crawl (`crawl.ts`): which games
 * qualify, which 100-Elo cell a side fills, the per-player caps, which cell the crawl works on
 * next, how a player's months are spread, and the derived per-ply clock/think record. Nothing here
 * touches the network or the disk.
 *
 * Definitions (the contract `games.jsonl` is written under):
 *
 * - **Qualifying game**: chess.com archive entry that the calibration's `acceptGame` accepts
 *   (rated, `rules = chess`, standard start, live bullet/blitz/rapid, both usernames and ratings),
 *   `end_time` in [2025-09-01, 2026-09-01) UTC, at least `MIN_PLIES` half-moves, and a `[%clk]`
 *   on every half-move.
 * - **Cell**: (time class, band of the MOVER's rating in that game). Bands are 600, 700, …, 3200:
 *   `floor(rating / 100) × 100`, 3200 and above fold into 3200; under 600 is no band.
 * - **Kept side**: a (game, colour) that counts. A side is kept iff its player's rating has a band,
 *   its cell holds fewer than `cellCap` kept sides, and its player holds fewer than `perPlayer`
 *   kept sides overall and fewer than `perPlayerTc` in that time class. A game is stored iff at
 *   least one of its sides is kept; `whiteKept` / `blackKept` say which. A side that is not kept
 *   does not count toward its player's caps nor toward its cell — downstream work that wants the
 *   caps honoured uses kept sides only.
 * - **Visited player's own sides** are additionally rationed per month (`monthQuota`) so a player's
 *   kept sides spread over the months and time classes they played, instead of the first N.
 *
 * Parts: `policy/cells.ts` (bands and cells), `policy/qualify.ts` (the window, the pre-filter and
 * the clock profile), `policy/records.ts` (the `games.jsonl` and `moves.jsonl` records),
 * `policy/ledger.ts` (caps and fills), `policy/priority.ts` (cell order, month rationing, parking
 * and the seeded randomness).
 */

export {
	ALL_CELLS,
	BAND_MAX,
	BAND_MIN,
	BAND_WIDTH,
	BANDS,
	bandFor,
	type Colour,
	cellOf,
	parseCell,
} from "./policy/cells";
export { type Caps, DEFAULT_CAPS, Ledger } from "./policy/ledger";
export {
	maxMonthsFor,
	monthQuota,
	rankCells,
	rng,
	shouldPark,
	shuffle,
	type VisitYield,
} from "./policy/priority";
export {
	archiveMonth,
	type ClockProfile,
	clockProfile,
	inWindow,
	MIN_PLIES,
	MONTH_FIRST,
	MONTH_LAST,
	prefilter,
	qualifyArchive,
	qualifyStored,
	type RawGame,
	WINDOW_END_S,
	WINDOW_START_S,
} from "./policy/qualify";
export { type MovesRecord, movesRecord, type TimingGame, timingGame } from "./policy/records";
