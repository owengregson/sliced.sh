/**
 * H11/H13 terms inside Maia's near-indifference band: both rescale the band's weights around a
 * probability-weighted mean of 1, so neither moves mass outside it.
 */

import { MAIA } from "@core/constants/maia";
import { fmt } from "../format";
import type { MaiaPractical, MaiaTieBreak } from "./types";

/** H11's band: the survivors whose weight is at least `MAIA.tieBandRatio` of the top weight. */
export function tieBandOf(weights: ReadonlyMap<string, number>): string[] {
	if (weights.size < 2) return [];
	let top = 0;
	for (const w of weights.values()) top = Math.max(top, w);
	return [...weights.keys()].filter((u) => (weights.get(u) ?? 0) >= MAIA.tieBandRatio * top);
}

/**
 * Multiply the weights of `band` by `factorOf(uci)`, normalised by their probability-weighted
 * mean, so the band's total mass is unchanged and nothing outside it moves. Returns the band
 * size when it reordered anything.
 */
function scaleBand(
	weights: Map<string, number>,
	band: readonly string[],
	factorOf: (uci: string) => number
): number {
	if (band.length < 2) return 0;
	let mass = 0;
	let scaledMass = 0;
	for (const u of band) {
		const weight = weights.get(u) ?? 0;
		mass += weight;
		scaledMass += weight * Math.max(0, factorOf(u));
	}
	const mean = mass > 0 ? scaledMass / mass : 0;
	if (!(mean > 0)) return 0;
	let moved = false;
	for (const u of band) {
		const factor = Math.max(0, factorOf(u)) / mean;
		if (factor !== 1) moved = true;
		weights.set(u, (weights.get(u) ?? 0) * factor);
	}
	return moved ? band.length : 0;
}

/** H11: the technique prior over the band (a move the map does not name counts as 1). */
export function applyTieBreak(
	weights: Map<string, number>,
	band: readonly string[],
	tieBreak: MaiaTieBreak | undefined
): number {
	if (tieBreak === undefined || band.length < 2) return 0;
	const values = typeof tieBreak === "function" ? tieBreak(band) : tieBreak;
	return scaleBand(weights, band, (u) => values.get(u) ?? 1);
}

/**
 * H13: `1 + trickiness` over the band (a move the map does not name counts as 0), normalised to
 * probability-weighted mean 1 — the same shape as the tie-break, so neither moves mass outside the
 * band. Returns the band size and the trickiness rows for the rationale.
 */
export function applyPractical(
	weights: Map<string, number>,
	band: readonly string[],
	practical: MaiaPractical | undefined
): { moved: number; rows: string[] } {
	if (practical === undefined || band.length < 2) return { moved: 0, rows: [] };
	const values = typeof practical === "function" ? practical(band) : practical;
	const moved = scaleBand(weights, band, (u) => 1 + Math.max(0, values.get(u) ?? 0));
	const rows = band.map((u) => `${u} ${fmt(Math.max(0, values.get(u) ?? 0), 2)}`);
	return { moved, rows };
}
