/**
 * tools/timing-crawl/policy/cells.ts — the 100-Elo bands and the (time class, band) cells the
 * crawl fills. A cell is keyed by the MOVER's rating in that game.
 */

import { TIME_CLASSES, type TimeClass } from "../../calibration/common";

export const BAND_MIN = 600;
export const BAND_MAX = 3200;
export const BAND_WIDTH = 100;
export const BANDS: readonly number[] = Array.from(
	{ length: (BAND_MAX - BAND_MIN) / BAND_WIDTH + 1 },
	(_, i) => BAND_MIN + BAND_WIDTH * i
);

export type Colour = "w" | "b";

export function bandFor(rating: number): number | null {
	if (!(rating >= BAND_MIN)) return null;
	return Math.min(BAND_MAX, Math.floor(rating / BAND_WIDTH) * BAND_WIDTH);
}

export function cellOf(tc: TimeClass, band: number): string {
	return `${tc}:${band}`;
}

export const ALL_CELLS: readonly string[] = TIME_CLASSES.flatMap((tc) =>
	BANDS.map((b) => cellOf(tc, b))
);

export function parseCell(cell: string): { tc: TimeClass; band: number } {
	const [tc, band] = cell.split(":");
	return { tc: tc as TimeClass, band: Number(band) };
}
