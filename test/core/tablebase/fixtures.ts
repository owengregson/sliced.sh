// test/core/tablebase/fixtures.ts — tablebase answers shaped like the Lichess API's JSON
// (captured from tablebase.lichess.ovh on 2026-09-23 and trimmed to the fields the client reads).

/** One move entry in the API's JSON shape. */
export function apiMove(
	uci: string,
	category: string,
	dtz: number | null,
	extra: Partial<{
		precise_dtz: number | null;
		dtm: number | null;
		zeroing: boolean;
		checkmate: boolean;
		stalemate: boolean;
	}> = {}
): Record<string, unknown> {
	return {
		uci,
		san: uci,
		zeroing: false,
		conversion: false,
		checkmate: false,
		stalemate: false,
		variant_win: false,
		variant_loss: false,
		insufficient_material: false,
		dtz,
		precise_dtz: dtz,
		dtm: null,
		dtw: null,
		dtc: null,
		category,
		...extra,
	};
}

export function apiAnswer(
	category: string,
	moves: Record<string, unknown>[]
): Record<string, unknown> {
	return {
		checkmate: false,
		stalemate: false,
		variant_win: false,
		variant_loss: false,
		insufficient_material: false,
		dtz: null,
		precise_dtz: null,
		dtm: null,
		dtw: null,
		dtc: null,
		category,
		moves,
	};
}

/** KRK, white to move and winning (real answer, every legal move). */
export const KRK_WIN_FEN = "8/8/8/4k3/8/8/2K5/7R w - - 0 1";
export const KRK_WIN = apiAnswer("win", [
	apiMove("c2c3", "loss", -24, { dtm: -24 }),
	apiMove("c2d3", "loss", -24, { dtm: -24 }),
	apiMove("h1a1", "loss", -26, { dtm: -26 }),
	apiMove("h1e1", "loss", -26, { dtm: -26 }),
	apiMove("h1h4", "loss", -26, { dtm: -26 }),
	apiMove("h1h5", "loss", -26, { dtm: -26 }),
	apiMove("c2d2", "loss", -26, { dtm: -26 }),
	apiMove("c2b3", "loss", -26, { dtm: -26 }),
	apiMove("h1b1", "loss", -28, { dtm: -28 }),
	apiMove("h1c1", "loss", -28, { dtm: -28 }),
	apiMove("h1d1", "loss", -28, { dtm: -28 }),
	apiMove("h1f1", "loss", -28, { dtm: -28 }),
	apiMove("h1g1", "loss", -28, { dtm: -28 }),
	apiMove("h1h2", "loss", -28, { dtm: -28 }),
	apiMove("h1h3", "loss", -28, { dtm: -28 }),
	apiMove("h1h6", "loss", -28, { dtm: -28 }),
	apiMove("h1h7", "loss", -28, { dtm: -28 }),
	apiMove("h1h8", "loss", -28, { dtm: -28 }),
	apiMove("c2c1", "loss", -28, { dtm: -28 }),
	apiMove("c2d1", "loss", -28, { dtm: -28 }),
	apiMove("c2b2", "loss", -28, { dtm: -28 }),
	apiMove("c2b1", "loss", -30, { dtm: -30 }),
]);

/** KRK, the lone king to move and lost (real answer, trimmed). */
export const KRK_LOSS_FEN = "8/8/8/8/8/2k5/8/K6R b - - 0 1";
export const KRK_LOSS = apiAnswer("loss", [
	apiMove("c3d4", "win", 29, { dtm: 29 }),
	apiMove("c3c4", "win", 27, { dtm: 27 }),
	apiMove("c3d3", "win", 25, { dtm: 25 }),
	apiMove("c3b3", "win", 25, { dtm: 25 }),
]);
