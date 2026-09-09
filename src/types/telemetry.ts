/**
 * Per-move telemetry shapes (Part I §13.2, Appendix I `fps` plugin). `AcBlob`
 * is the chess.com `ac` object exactly as the shipped client computes it
 * (field names verbatim); the simulator's `ac` shadow (`test/sim/telemetry/`)
 * produces it from the simulated page, and the service worker records its own
 * equivalent per move in `TimingLogEntry.telemetry` (Task 30) so the offline
 * conformance report (`tools/telemetry-conformance/report.py`) can read it.
 */

/**
 * The chess.com per-move `ac` blob. Times are milliseconds. `LastFocusToMoveTime`
 * and `MoveToFirstBlurTime` are absent (not `0`) when the window saw no
 * focus/blur event — the desired state.
 */
export interface AcBlob {
	BlurCount: number;
	DidBlurOnOpponentTurn: boolean;
	DidBlurOnOwnTurn: boolean;
	DidFocusOnOpponentTurn: boolean;
	DidFocusOnOwnTurn: boolean;
	DidSelectMultiplePieces: boolean;
	DidToggle: boolean;
	EventTrusted: boolean;
	LastFocusToMoveTime?: number;
	MoveHoldTime: number;
	MoveToFirstBlurTime?: number;
	PointerOffset: number;
	TotalBlurTime: number;
	TotalFocusTime: number;
}

/** Lichess `ui/round/src/blur.ts`: one bit per move, set when the window blurred during the move. */
export type LichessBlurBit = 0 | 1;

/**
 * The extension's own per-move telemetry record (§13.2 + §13.6), written by the
 * `GameSession` (Task 30) into `TimingLogEntry.telemetry` once the execution
 * result is in. Every field, and where Task 30 gets it:
 *
 * | field | source in the `GameSession` |
 * |-------|-----------------------------|
 * | `ac` | the move window (position arrival → drop): `BlurCount`/`DidToggle`/`DidBlurOn…`/`DidFocusOn…`/`TotalBlurTime`/`TotalFocusTime`/`LastFocusToMoveTime`/`MoveToFirstBlurTime` from the `FocusGate` edges since `positionArrived`; `EventTrusted` is `true` for every CDP dispatch (the executor never dispatches otherwise); `DidSelectMultiplePieces` from the hand's preview-selection log (`ExecutionResult.timeline` `preview` phases); `MoveHoldTime` = `ExecutionResult.elapsedMs`; `PointerOffset` = the hand's path length over the window (`HandOwnership`). |
 * | `lichessBlur` | `1` when any blur fell in the window, else `0` (lila `blur.ts`). |
 * | `orientationMs` | `TimingPlan.orientationMs` (§8.4b item 2). |
 * | `multiSelectEligible` | the move is "non-trivial" for the §13.2 preview band: `plan.mode` is `normal`/`long`, `plan.thinkMs ≥ PREVIEW.gZeroMs` and the clock is at least `PREVIEW.clockFloorMs` (`isNonTrivial` in `tools/telemetry-conformance/ac-model.ts`). |
 * | `nReasonable` | `n_reasonable` of the position (`TimingContext` / `MoveContext`): the offline report's complexity axis, which the timing columns alone do not carry. |
 * | `top1` | the played move was the engine's first line. `ChosenMove.rankInLines` is **1-based** (`selectMove` sets `1` for the best line; `0` means the move was not among the lines at all, which is what the book and a premove report), so this is `rankInLines === 1`. |
 * | `cpLoss` | `Recommendation.chosen.cpLoss` — the §13.6 ACPL input. |
 *
 * `test/sim/telemetry/harness.ts` (`telemetryRecordOf`, `timingLogOf`) builds exactly
 * this record from the simulated game, so Task 30's writer can be diffed against it.
 */
export interface MoveTelemetryRecord {
	ac: AcBlob;
	lichessBlur: LichessBlurBit;
	orientationMs: number;
	multiSelectEligible: boolean;
	nReasonable: number;
	top1: boolean;
	cpLoss: number;
}
