/**
 * tools/timing-calibration/stats/sample.ts — stable, hash-ordered choices: the per-player cap on
 * game-sides and the FNV-1a hash every selection orders by.
 */

/**
 * Deterministic per-player cap: at most `cap` game-sides per (player, time class), chosen by a
 * hash of the game id so the same sides are kept on every run.
 */
export function capSides<T extends { player: string; tc: string; gameId: string }>(
	rows: readonly T[],
	cap: number
): T[] {
	const sides = new Map<string, Set<string>>();
	for (const r of rows) {
		const key = `${r.player}\t${r.tc}`;
		let s = sides.get(key);
		if (!s) {
			s = new Set();
			sides.set(key, s);
		}
		s.add(r.gameId);
	}
	const keep = new Set<string>();
	for (const [key, games] of sides) {
		const ordered = [...games].sort((a, b) => hash32(a) - hash32(b) || a.localeCompare(b));
		for (const g of ordered.slice(0, cap)) keep.add(`${key}\t${g}`);
	}
	return rows.filter((r) => keep.has(`${r.player}\t${r.tc}\t${r.gameId}`));
}

/** FNV-1a. */
export function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}
