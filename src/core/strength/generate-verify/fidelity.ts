/** How far a verified draw moved from Maia among the survivors. */

/**
 * `KL(q ‖ p)` in nats over `q`'s support: `p` is renormalised over the same keys so the number
 * says how far the draw moved from Maia *among the survivors*. 0 when the wrapper changed
 * nothing; `Infinity` when `q` draws a move Maia gives no mass.
 */
export function gvKl(q: ReadonlyMap<string, number>, p: ReadonlyMap<string, number>): number {
	let qTotal = 0;
	let pTotal = 0;
	for (const [uci, mass] of q) {
		if (mass <= 0) continue;
		qTotal += mass;
		pTotal += p.get(uci) ?? 0;
	}
	if (qTotal <= 0) return 0;
	let kl = 0;
	for (const [uci, mass] of q) {
		if (mass <= 0) continue;
		const qm = mass / qTotal;
		const pm = pTotal > 0 ? (p.get(uci) ?? 0) / pTotal : 0;
		if (pm <= 0) return Number.POSITIVE_INFINITY;
		kl += qm * Math.log(qm / pm);
	}
	return Math.max(0, kl);
}
