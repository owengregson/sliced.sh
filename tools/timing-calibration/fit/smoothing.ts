/**
 * tools/timing-calibration/fit/smoothing.ts — the pure smoothers the table is fitted with:
 * penalised weighted least squares across rating knots, pool-adjacent-violators for a
 * non-decreasing fit, and a Viterbi pass over per-knot objective curves.
 */

/** Weighted least squares with a first-difference penalty λ: (W + λDᵀD) v = W·y (tridiagonal). */
export function smoothWeighted(
	y: readonly number[],
	w: readonly number[],
	lambda: number,
	fallback = 0
): number[] {
	const n = y.length;
	if (w.every((x) => x <= 0)) return y.map(() => fallback);
	const a = new Array<number>(n).fill(0);
	const b = new Array<number>(n).fill(0);
	const c = new Array<number>(n).fill(0);
	const d = new Array<number>(n).fill(0);
	for (let i = 0; i < n; i++) {
		b[i] = (w[i] ?? 0) + lambda * ((i > 0 ? 1 : 0) + (i < n - 1 ? 1 : 0));
		if (i > 0) a[i] = -lambda;
		if (i < n - 1) c[i] = -lambda;
		d[i] = (w[i] ?? 0) * (y[i] ?? 0);
	}
	// Thomas algorithm (a tiny ridge keeps an all-λ system non-singular).
	for (let i = 0; i < n; i++) b[i] = (b[i] ?? 0) + 1e-9;
	for (let i = 1; i < n; i++) {
		const m = (a[i] ?? 0) / (b[i - 1] ?? 1);
		b[i] = (b[i] ?? 0) - m * (c[i - 1] ?? 0);
		d[i] = (d[i] ?? 0) - m * (d[i - 1] ?? 0);
	}
	const v = new Array<number>(n).fill(0);
	v[n - 1] = (d[n - 1] ?? 0) / (b[n - 1] ?? 1);
	for (let i = n - 2; i >= 0; i--)
		v[i] = ((d[i] ?? 0) - (c[i] ?? 0) * (v[i + 1] ?? 0)) / (b[i] ?? 1);
	return v;
}

/** Pool-adjacent-violators: the weighted non-decreasing fit. */
export function isotonic(y: readonly number[], w: readonly number[]): number[] {
	const blocks: Array<{ v: number; w: number; n: number }> = [];
	for (let i = 0; i < y.length; i++) {
		blocks.push({ v: y[i] ?? 0, w: Math.max(1e-9, w[i] ?? 0), n: 1 });
		while (blocks.length >= 2) {
			const b2 = blocks[blocks.length - 1] as { v: number; w: number; n: number };
			const b1 = blocks[blocks.length - 2] as { v: number; w: number; n: number };
			if (b1.v <= b2.v) break;
			blocks.splice(blocks.length - 2, 2, {
				v: (b1.v * b1.w + b2.v * b2.w) / (b1.w + b2.w),
				w: b1.w + b2.w,
				n: b1.n + b2.n,
			});
		}
	}
	return blocks.flatMap((b) => new Array<number>(b.n).fill(b.v));
}

/** Viterbi over knots: per-knot objective curves on `grid` + λ(v_k − v_{k−1})². */
export function viterbi(
	grid: readonly number[],
	cost: readonly (readonly number[])[],
	lambda: number
): number[] {
	const K = cost.length;
	const G = grid.length;
	let prev = cost[0]?.slice() ?? [];
	const back: number[][] = [];
	for (let k = 1; k < K; k++) {
		const cur = new Array<number>(G).fill(Number.POSITIVE_INFINITY);
		const arg = new Array<number>(G).fill(0);
		for (let j = 0; j < G; j++) {
			for (let i = 0; i < G; i++) {
				const v = (prev[i] ?? 0) + lambda * ((grid[j] ?? 0) - (grid[i] ?? 0)) ** 2;
				if (v < (cur[j] ?? 0)) {
					cur[j] = v;
					arg[j] = i;
				}
			}
			cur[j] = (cur[j] ?? 0) + (cost[k]?.[j] ?? 0);
		}
		back.push(arg);
		prev = cur;
	}
	let best = 0;
	for (let j = 1; j < G; j++) if ((prev[j] ?? 0) < (prev[best] ?? 0)) best = j;
	const path = [best];
	for (let k = K - 2; k >= 0; k--) path.unshift(back[k]?.[path[0] ?? 0] ?? 0);
	return path.map((j) => grid[j] ?? 0);
}
