/**
 * The advantage bar (owner's request, 2026-09-11): "how close you are to winning the game from
 * the current state" as a practical blend, not the engine's win probability. Three terms, each
 * squashed on its own scale and summed with these weights to a White-relative index in [−1, 1]:
 *
 *   - **material** — `tanh(diff / materialScale)`: a pawn up ≈ +0.2, a piece ≈ +0.54, a rook ≈ +0.76;
 *   - **engine** — `tanh(cp / engineScaleCp)`: gentler than the WDL rail, so +1.00 reads ≈ +0.24
 *     instead of pinning the bar; a mate score pins the index at ±1;
 *   - **clock** — `(w − b) / (w + b)`, weighted by how short the *shorter* clock is
 *     (`1 − min(shorterMs / clockScaleMs, 1)`): irrelevant with minutes left, most of the story
 *     with seconds left.
 */
export const ADVANTAGE = {
	materialWeight: 0.45,
	engineWeight: 0.35,
	clockWeight: 0.2,
	materialScale: 5,
	engineScaleCp: 400,
	clockScaleMs: 60_000,
} as const;
