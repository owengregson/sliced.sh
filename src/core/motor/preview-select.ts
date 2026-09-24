/**
 * Preview selections (§9.3a, V2.1): the rate model `p_preview` and the
 * planner that turns a candidate piece into a complete, always-resolvable
 * selection (click or drag style, hover over one of its destinations, then
 * switch to the committed piece or deselect first). No press ever lands on a
 * legal destination of the piece selected at that moment — neither of the
 * previewed piece nor of a piece still selected from an earlier preview —
 * unless it is the committed move; drag previews always release on the
 * origin square.
 *
 * The parts live under `./preview-select/`: `rate` (the probability), `plan` (the gesture) and
 * `deselect` (the safe square that clears a selection).
 */

export { type PreviewPlanInput, planPreview, selectedAfter } from "./preview-select/plan";
export { type PreviewContext, previewProbability, thinkRamp } from "./preview-select/rate";
