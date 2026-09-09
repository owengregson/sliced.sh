// tools/telemetry-conformance/ac-model.ts
/**
 * The human-shape model of a move's `ac` blob (Part I §13.2, §9.6a, §8.4a,
 * §13.6): what every simulated or recorded move must look like. Thresholds
 * come from `TELEMETRY_BANDS` (once, C1). `assertHumanShapedAc` is the
 * assertion every behavioural executor test runs on the shadow's blobs, and
 * the conformance test runs on a batch of simulated games; `summarizeAc`
 * and `formatConformanceReport` produce the report `report.py` prints for
 * recorded games. Framework-free: violations are thrown as one `Error`.
 */

import { TELEMETRY_BANDS } from "../../src/core/constants/telemetry";
import type { AcBlob } from "../../src/types/telemetry";
import type { TimingMode } from "../../src/types/timing";

/** What the harness / session knows about a move that the blob does not carry. */
export interface AcMoveMeta {
	mode: TimingMode;
	thinkMs: number;
	clockMs: number;
	nReasonable?: number;
}

/** `AcMoveMeta` of a harness move (`SimulatedMove` or a Task 30 record with the same fields). */
export function moveMetaOf(m: {
	plan: { mode: TimingMode; thinkMs: number };
	nReasonable: number;
	myClockMs: number;
}): AcMoveMeta {
	return {
		mode: m.plan.mode,
		thinkMs: m.plan.thinkMs,
		clockMs: m.myClockMs,
		nReasonable: m.nReasonable,
	};
}

/** §13.2 / §9.3a: a preview-eligible ("non-trivial") move. */
export function isNonTrivial(meta: AcMoveMeta): boolean {
	const b = TELEMETRY_BANDS.multiSelect;
	return (
		(meta.mode === "normal" || meta.mode === "long") &&
		meta.thinkMs >= b.minThinkMs &&
		meta.clockMs >= b.minClockMs
	);
}

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

export interface AcExpectations {
	/** Per-move context, aligned with `acs`; without it only the blob-level rules are checked. */
	moves?: readonly AcMoveMeta[];
}

export class AcConformanceError extends Error {
	constructor(readonly violations: string[]) {
		super(`ac conformance: ${violations.length} violation(s)\n  - ${violations.join("\n  - ")}`);
	}
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

/**
 * Every §13.2 / §9.6a / §8.4a rule on a batch of blobs — one game's or a pooled
 * population's. Blob-level rules always apply; the hold-time floor skips
 * premove/instant moves when `moves` says so; the distribution bands (CV,
 * preview rate, complexity correlation, compression) apply once the sample is
 * large enough per `TELEMETRY_BANDS` — below that only the sample-size-free
 * invariants (hard preview cap, never 0 %, never 100 %) hold. Returns the
 * summary; throws `AcConformanceError` listing every violation.
 */
export function assertHumanShapedAc(
	acs: readonly AcBlob[],
	expectations: AcExpectations = {}
): AcSummary {
	const B = TELEMETRY_BANDS;
	const moves = expectations.moves;
	if (moves && moves.length !== acs.length)
		throw new AcConformanceError([`moves meta length ${moves.length} ≠ blobs ${acs.length}`]);
	const violations: string[] = [];
	acs.forEach((ac, i) => {
		const at = `move ${i}`;
		if (ac.BlurCount > B.blurCountMax) violations.push(`${at}: BlurCount ${ac.BlurCount}`);
		if (ac.DidToggle) violations.push(`${at}: DidToggle`);
		if (!ac.EventTrusted) violations.push(`${at}: EventTrusted false`);
		if (ac.DidBlurOnOwnTurn || ac.DidBlurOnOpponentTurn) violations.push(`${at}: DidBlur… set`);
		if (ac.DidFocusOnOwnTurn || ac.DidFocusOnOpponentTurn) violations.push(`${at}: DidFocus… set`);
		if (ac.LastFocusToMoveTime !== undefined) violations.push(`${at}: LastFocusToMoveTime set`);
		if (ac.MoveToFirstBlurTime !== undefined) violations.push(`${at}: MoveToFirstBlurTime set`);
		if (ac.TotalBlurTime !== 0) violations.push(`${at}: TotalBlurTime ${ac.TotalBlurTime}`);
		if (!(ac.TotalFocusTime >= ac.MoveHoldTime))
			violations.push(`${at}: TotalFocusTime < MoveHoldTime`);
		if (!Number.isFinite(ac.PointerOffset) || ac.PointerOffset < 0)
			violations.push(`${at}: PointerOffset ${ac.PointerOffset}`);
		const m = moves?.[i];
		const instantLike = m !== undefined && (m.mode === "premove" || m.mode === "instant");
		if (!instantLike && ac.MoveHoldTime < B.holdTime.minMs)
			violations.push(`${at}: MoveHoldTime ${ac.MoveHoldTime.toFixed(0)} ms < ${B.holdTime.minMs}`);
	});
	const s = summarizeAc(acs, moves);
	if (s.holdNormal.n >= B.holdTime.cvAfterMoves && s.holdNormal.cv < B.holdTime.cvMin)
		violations.push(
			`hold-time CV ${s.holdNormal.cv.toFixed(2)} < ${B.holdTime.cvMin} over ${s.holdNormal.n} moves`
		);
	// The preview rate is a population statistic (§13.2): a single game only has to be
	// neither 0 % nor 100 % and to stay under the hard cap; the 4–12 % band is asserted
	// once the pooled sample reaches `minMovesForBand` non-trivial moves.
	if (s.multiSelect.eligible > 0 && s.multiSelect.rate !== null) {
		const { count, eligible, rate } = s.multiSelect;
		if (rate > B.multiSelect.hardMax)
			violations.push(
				`multi-select rate ${(rate * 100).toFixed(1)} % > ${B.multiSelect.hardMax * 100} %`
			);
		if (eligible >= B.multiSelect.minMovesForNonZero) {
			if (count === 0) violations.push(`multi-select rate 0 % over ${eligible} non-trivial moves`);
			else if (count === eligible)
				violations.push(`multi-select rate 100 % over ${eligible} non-trivial moves`);
		}
		if (eligible >= B.multiSelect.minMovesForBand) {
			const [lo, hi] = B.multiSelect.rate;
			if (rate < lo || rate > hi)
				violations.push(
					`multi-select rate ${(rate * 100).toFixed(1)} % (${count}/${eligible}) outside ${lo * 100}–${hi * 100} % over ${eligible} non-trivial moves`
				);
		}
	}
	if (
		s.holdVsComplexity !== null &&
		s.holdNormal.n >= B.holdTime.cvAfterMoves &&
		s.holdVsComplexity < B.holdTime.complexityCorrMin
	)
		violations.push(
			`hold-time vs n_reasonable correlation ${s.holdVsComplexity.toFixed(2)} < ${B.holdTime.complexityCorrMin}`
		);
	const c = s.compression;
	if (
		c.ratio !== null &&
		c.pressure.n >= B.compression.minMovesPerSide &&
		c.comfortable.n >= B.compression.minMovesPerSide &&
		c.ratio > B.compression.maxMeanRatio
	)
		violations.push(`time-pressure hold ratio ${c.ratio.toFixed(2)} > ${B.compression.maxMeanRatio}`);
	if (violations.length) throw new AcConformanceError(violations);
	return s;
}

const ms = (x: number): string => `${x.toFixed(0)} ms`;
const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)} %`);

/** The per-game summary the conformance test and `report.py` print. */
export function formatConformanceReport(s: AcSummary, title = "ac conformance"): string {
	const B = TELEMETRY_BANDS;
	const h = s.holdNormal;
	return [
		`${title}: ${s.n} moves`,
		`  blur events ${s.blurCount} (max ${B.blurCountMax}) · toggles ${s.toggles} · untrusted ${s.untrusted} · focus fields set ${s.focusFieldsSet}`,
		`  multi-select ${pct(s.multiSelect.rate)} (${s.multiSelect.count}/${s.multiSelect.eligible} non-trivial; band ${pct(B.multiSelect.rate[0])}–${pct(B.multiSelect.rate[1])} from n≥${B.multiSelect.minMovesForBand}, hard max ${pct(B.multiSelect.hardMax)})`,
		`  hold time (normal/long, n=${h.n}): mean ${ms(h.mean)} sd ${ms(h.sd)} cv ${h.cv.toFixed(2)} (min ${B.holdTime.cvMin}) · min ${ms(h.min)} (floor ${ms(B.holdTime.minMs)}) · q10/q50/q90 ${ms(h.q10)} / ${ms(h.q50)} / ${ms(h.q90)}`,
		`  hold vs n_reasonable r=${s.holdVsComplexity === null ? "n/a" : s.holdVsComplexity.toFixed(2)} (min ${B.holdTime.complexityCorrMin})`,
		`  time pressure: mean ${ms(s.compression.pressure.mean)} (n=${s.compression.pressure.n}) vs comfortable ${ms(s.compression.comfortable.mean)} (n=${s.compression.comfortable.n}) · ratio ${s.compression.ratio === null ? "n/a" : s.compression.ratio.toFixed(2)} (max ${B.compression.maxMeanRatio})`,
		`  pointer offset mean ${s.pointerOffset.mean.toFixed(0)} px · max ${s.pointerOffset.max.toFixed(0)} px`,
	].join("\n");
}
