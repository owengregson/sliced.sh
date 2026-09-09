/**
 * Per-move telemetry (§13.2, §13.6). One `MoveWindow` per move: opened when the
 * position arrives, fed every `FocusGate` edge, closed with the execution
 * result. It produces the `MoveTelemetryRecord` the `GameSession` attaches to
 * that move's `TimingLogEntry`, which is what
 * `tools/telemetry-conformance/report.py` reads.
 *
 * The field-by-field sources are the table on `MoveTelemetryRecord`
 * (`src/types/telemetry.ts`); this module is the writer for the `ac` half:
 * `EventTrusted` is `true` because the hand's only input path is CDP,
 * `DidSelectMultiplePieces` counts the distinct `preview` phases of the
 * execution timeline, `MoveHoldTime` is the realised hold and `PointerOffset`
 * the path the hand dispatched inside the window.
 */

import type { ExecutionResult } from "@typedefs/game";
import type { AcBlob, LichessBlurBit, MoveTelemetryRecord } from "@typedefs/telemetry";

/** Timeline phase the hand records for one preview selection (§9.3a). */
export const PREVIEW_PHASE = "preview";

/**
 * §13.2 `DidSelectMultiplePieces`: the page sees "more than one piece selected" when the hand
 * pressed a square other than the one it finally moved — a preview selection (§9.3a) or the
 * deselect click that resolves it. The committed press is always one of the selections, so a
 * single distinct extra square is already "multiple".
 */
export function selectedMultiplePieces(
	result: Pick<ExecutionResult, "previewedSquares" | "timeline">,
	committedFrom: string
): boolean {
	const squares = result.previewedSquares;
	if (squares === undefined) return previewSelections(result) > 1;
	const distinct = new Set<string>([committedFrom, ...squares]);
	return distinct.size > 1;
}

export interface MoveWindowClose {
	/** Realised hold (`ExecutionResult.elapsedMs`). */
	elapsedMs: number;
	/** `ExecutionResult.pointerOffsetPx` — path length the hand dispatched. */
	pointerOffsetPx: number;
	/** The page saw more than one piece selected in this window (§13.2). */
	multiplePieces: boolean;
	orientationMs: number;
	multiSelectEligible: boolean;
	nReasonable: number;
	top1: boolean;
	cpLoss: number;
	/** Epoch ms of the drop. */
	at: number;
}

interface Edge {
	hasFocus: boolean;
	at: number;
}

/** The `preview` phases of an execution timeline (how many pieces the hand pressed to look at). */
export function previewSelections(result: Pick<ExecutionResult, "timeline">): number {
	return result.timeline.filter((p) => p.phase === PREVIEW_PHASE).length;
}

export class MoveWindow {
	private startedAt: number | null = null;
	private ownTurn = true;
	private readonly edges: Edge[] = [];

	/** A new position for this tab opens a fresh window (`FocusGate.positionArrived`). */
	open(at: number, ownTurn: boolean): void {
		this.startedAt = at;
		this.ownTurn = ownTurn;
		this.edges.length = 0;
	}

	isOpen(): boolean {
		return this.startedAt !== null;
	}

	/** Every window `focus` / `blur` edge the content script reported. */
	edge(hasFocus: boolean, at: number): void {
		if (this.startedAt === null) return;
		this.edges.push({ hasFocus, at: Math.max(at, this.startedAt) });
	}

	/** Blur edges seen since the window opened (the panel's `blurSeenThisMove` mirror). */
	blurCount(): number {
		return this.edges.filter((e) => !e.hasFocus).length;
	}

	/**
	 * Build the record for the move that just landed and close the window.
	 * `null` when no window was open (nothing was submitted for this position).
	 */
	close(c: MoveWindowClose): MoveTelemetryRecord | null {
		const start = this.startedAt;
		if (start === null) return null;
		const end = Math.max(c.at, start);
		const blurs = this.edges.filter((e) => !e.hasFocus);
		const focuses = this.edges.filter((e) => e.hasFocus);

		// Time spent blurred: each blur runs until the next focus edge, else to the drop.
		let blurTime = 0;
		let blurredSince: number | null = null;
		for (const e of this.edges) {
			if (!e.hasFocus && blurredSince === null) blurredSince = e.at;
			else if (e.hasFocus && blurredSince !== null) {
				blurTime += Math.max(0, e.at - blurredSince);
				blurredSince = null;
			}
		}
		if (blurredSince !== null) blurTime += Math.max(0, end - blurredSince);

		const ac: AcBlob = {
			BlurCount: blurs.length,
			DidBlurOnOpponentTurn: !this.ownTurn && blurs.length > 0,
			DidBlurOnOwnTurn: this.ownTurn && blurs.length > 0,
			DidFocusOnOpponentTurn: !this.ownTurn && focuses.length > 0,
			DidFocusOnOwnTurn: this.ownTurn && focuses.length > 0,
			DidSelectMultiplePieces: c.multiplePieces,
			DidToggle: blurs.length > 0 && focuses.length > 0,
			// The hand's only input path is `Input.dispatchMouseEvent`, which the page sees as trusted.
			EventTrusted: true,
			MoveHoldTime: c.elapsedMs,
			PointerOffset: c.pointerOffsetPx,
			TotalBlurTime: blurTime,
			TotalFocusTime: Math.max(0, end - start - blurTime),
		};
		const lastFocus = focuses[focuses.length - 1];
		if (lastFocus) ac.LastFocusToMoveTime = Math.max(0, end - lastFocus.at);
		const firstBlur = blurs[0];
		if (firstBlur) ac.MoveToFirstBlurTime = Math.max(0, firstBlur.at - start);

		this.startedAt = null;
		this.edges.length = 0;
		const lichessBlur: LichessBlurBit = blurs.length > 0 ? 1 : 0;
		return {
			ac,
			lichessBlur,
			orientationMs: c.orientationMs,
			multiSelectEligible: c.multiSelectEligible,
			nReasonable: c.nReasonable,
			top1: c.top1,
			cpLoss: c.cpLoss,
		};
	}

	/** Drop the window without producing a record (the move was skipped / the position moved on). */
	discard(): void {
		this.startedAt = null;
		this.edges.length = 0;
	}
}
