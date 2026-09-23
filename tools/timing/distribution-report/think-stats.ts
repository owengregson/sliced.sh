/** tools/timing/distribution-report/think-stats.ts — the shape of a set of think times (seconds). */

export function thinkStats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))] ?? 0;
	return {
		n: values.length,
		meanS: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length),
		p10S: q(0.1),
		p50S: q(0.5),
		p90S: q(0.9),
		p95S: q(0.95),
		under1: values.filter((v) => v < 1).length / Math.max(1, values.length),
		over10: values.filter((v) => v > 10).length / Math.max(1, values.length),
	};
}
