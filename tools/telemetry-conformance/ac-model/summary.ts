/**
 * tools/telemetry-conformance/ac-model/summary.ts — the statistics of a batch of `ac` blobs:
 * counts, the preview rate, the hold-time distribution, its complexity correlation and its
 * time-pressure compression.
 */

import { TELEMETRY_BANDS } from "../../../src/core/constants/telemetry";
import type { AcBlob } from "../../../src/types/telemetry";
import { type AcMoveMeta, isNonTrivial } from "./meta";

export interface HoldStats {
	n: number;
	mean: number;
	sd: number;
	cv: number;
	min: number;
	max: number;
	q10: number;
	q50: number;
	q90: number;
}

export interface AcSummary {
	n: number;
	blurCount: number;
	toggles: number;
	untrusted: number;
	/** Blobs with any `DidBlur…` / `DidFocus…` flag or focus timing set. */
	focusFieldsSet: number;
	multiSelect: { count: number; eligible: number; rate: number | null };
	hold: HoldStats;
	/** Hold statistics of the normal/long moves only (premove/instant excluded). */
	holdNormal: HoldStats;
	/** Pearson correlation of ln(hold time) with ln(`n_reasonable`) — the model's log scale (Appendix D §3a). */
	holdVsComplexity: number | null;
	compression: {
		pressure: HoldStats;
		comfortable: HoldStats;
		ratio: number | null;
	};
	pointerOffset: { mean: number; max: number };
}

function stats(xs: readonly number[]): HoldStats {
	const n = xs.length;
	if (n === 0) return { n, mean: 0, sd: 0, cv: 0, min: 0, max: 0, q10: 0, q50: 0, q90: 0 };
	const sorted = [...xs].sort((a, b) => a - b);
	let mean = 0;
	for (const x of xs) mean += x;
	mean /= n;
	let v = 0;
	for (const x of xs) v += (x - mean) ** 2;
	const sd = Math.sqrt(v / n);
	const q = (p: number): number => sorted[Math.min(n - 1, Math.floor(p * n))] ?? 0;
	return {
		n,
		mean,
		sd,
		cv: mean > 0 ? sd / mean : 0,
		min: sorted[0] ?? 0,
		max: sorted[n - 1] ?? 0,
		q10: q(0.1),
		q50: q(0.5),
		q90: q(0.9),
	};
}

function pearson(a: readonly number[], b: readonly number[]): number | null {
	const n = Math.min(a.length, b.length);
	if (n < 2) return null;
	let ma = 0;
	let mb = 0;
	for (let i = 0; i < n; i++) {
		ma += a[i] ?? 0;
		mb += b[i] ?? 0;
	}
	ma /= n;
	mb /= n;
	let sab = 0;
	let saa = 0;
	let sbb = 0;
	for (let i = 0; i < n; i++) {
		const da = (a[i] ?? 0) - ma;
		const db = (b[i] ?? 0) - mb;
		sab += da * db;
		saa += da * da;
		sbb += db * db;
	}
	if (saa === 0 || sbb === 0) return null;
	return sab / Math.sqrt(saa * sbb);
}

const hasFocusFields = (ac: AcBlob): boolean =>
	ac.DidBlurOnOpponentTurn ||
	ac.DidBlurOnOwnTurn ||
	ac.DidFocusOnOpponentTurn ||
	ac.DidFocusOnOwnTurn ||
	ac.LastFocusToMoveTime !== undefined ||
	ac.MoveToFirstBlurTime !== undefined;

export function summarizeAc(acs: readonly AcBlob[], moves?: readonly AcMoveMeta[]): AcSummary {
	const meta = (i: number): AcMoveMeta | undefined => moves?.[i];
	const holds = acs.map((a) => a.MoveHoldTime);
	const normal: number[] = [];
	const withN: Array<[number, number]> = [];
	const pressure: number[] = [];
	const comfortable: number[] = [];
	let eligible = 0;
	let multi = 0;
	acs.forEach((ac, i) => {
		const m = meta(i);
		const isNormal = m === undefined || m.mode === "normal" || m.mode === "long";
		if (isNormal) normal.push(ac.MoveHoldTime);
		if (m?.nReasonable !== undefined && isNormal) withN.push([ac.MoveHoldTime, m.nReasonable]);
		if (m && isNormal) {
			if (m.clockMs < TELEMETRY_BANDS.compression.pressureClockMs) pressure.push(ac.MoveHoldTime);
			else if (m.clockMs >= TELEMETRY_BANDS.compression.comfortableClockMs)
				comfortable.push(ac.MoveHoldTime);
		}
		if (m && isNonTrivial(m)) {
			eligible += 1;
			if (ac.DidSelectMultiplePieces) multi += 1;
		}
	});
	const p = stats(pressure);
	const c = stats(comfortable);
	let offsetMean = 0;
	let offsetMax = 0;
	for (const a of acs) {
		offsetMean += a.PointerOffset;
		offsetMax = Math.max(offsetMax, a.PointerOffset);
	}
	return {
		n: acs.length,
		blurCount: acs.reduce((s, a) => s + a.BlurCount, 0),
		toggles: acs.filter((a) => a.DidToggle).length,
		untrusted: acs.filter((a) => !a.EventTrusted).length,
		focusFieldsSet: acs.filter(hasFocusFields).length,
		multiSelect: { count: multi, eligible, rate: eligible > 0 ? multi / eligible : null },
		hold: stats(holds),
		holdNormal: stats(normal),
		holdVsComplexity: pearson(
			withN.map(([h]) => Math.log(Math.max(1, h))),
			withN.map(([, n]) => Math.log(Math.max(1, n)))
		),
		compression: {
			pressure: p,
			comfortable: c,
			ratio: p.n > 0 && c.n > 0 && c.mean > 0 ? p.mean / c.mean : null,
		},
		pointerOffset: { mean: acs.length ? offsetMean / acs.length : 0, max: offsetMax },
	};
}
