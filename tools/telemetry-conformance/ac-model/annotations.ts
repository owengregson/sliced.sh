/** tools/telemetry-conformance/ac-model/annotations.ts — the line-preview arrows of a game. */

import { TELEMETRY_BANDS } from "../../../src/core/constants/telemetry";
import type { AcMoveMeta } from "./meta";
import { AcConformanceError } from "./rules";

/**
 * Right-button drags per move — the arrows of a line preview (`LINE_PREVIEW`, Task 2026-09-12).
 * They are classified as **annotations**: never a selection (`DidSelectMultiplePieces`), never a
 * move, never a hold-time sample. What a game must look like (`TELEMETRY_BANDS.annotation`): an
 * arrow only on a `normal` / `long` move planned at least `minThinkMs`, at most `maxPerMove` on
 * one move, and on at most `maxPerGame` moves of the game. `arrowsPerMove` is aligned with `moves`
 * (one entry per move, `0` for a move that drew nothing).
 */
export function annotationViolations(
	arrowsPerMove: readonly number[],
	moves: readonly AcMoveMeta[]
): string[] {
	const B = TELEMETRY_BANDS.annotation;
	const out: string[] = [];
	if (arrowsPerMove.length !== moves.length)
		return [`arrows per move length ${arrowsPerMove.length} ≠ moves ${moves.length}`];
	let annotated = 0;
	arrowsPerMove.forEach((arrows, i) => {
		if (arrows <= 0) return;
		annotated += 1;
		const m = moves[i];
		const at = `move ${i}`;
		if (!m) return;
		if (m.mode !== "normal" && m.mode !== "long")
			out.push(`${at}: ${arrows} arrow(s) on a ${m.mode} move`);
		if (m.thinkMs < B.minThinkMs)
			out.push(`${at}: ${arrows} arrow(s) on a ${m.thinkMs.toFixed(0)} ms think < ${B.minThinkMs}`);
		if (arrows > B.maxPerMove) out.push(`${at}: ${arrows} arrows > ${B.maxPerMove} per move`);
	});
	if (annotated > B.maxPerGame) out.push(`${annotated} annotated moves > ${B.maxPerGame} per game`);
	return out;
}

/** `annotationViolations` as an assertion over one game. */
export function assertHumanShapedAnnotations(
	arrowsPerMove: readonly number[],
	moves: readonly AcMoveMeta[]
): void {
	const violations = annotationViolations(arrowsPerMove, moves);
	if (violations.length) throw new AcConformanceError(violations);
}
