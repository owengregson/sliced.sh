/**
 * Game-phase classification by non-pawn material (Task 5).
 *   ≥ 62 → "opening" while ply < 20, else "middlegame"
 *   ≤ 26 → "endgame"
 *   otherwise "middlegame"
 */

import { parseFen, plyOf } from "./fen";
import { nonPawnMaterial } from "./material";

export type Phase = "opening" | "middlegame" | "endgame";

const OPENING_MATERIAL = 62;
const OPENING_MAX_PLY = 20;
const ENDGAME_MATERIAL = 26;

/** `ply` defaults to the ply implied by the FEN's fullmove number and side to move. */
export function phase(fen: string, ply?: number): Phase | null {
	const parts = parseFen(fen);
	const npm = nonPawnMaterial(fen);
	if (!parts || npm === null) return null;
	const p = ply ?? plyOf(parts);
	if (npm >= OPENING_MATERIAL) return p < OPENING_MAX_PLY ? "opening" : "middlegame";
	if (npm <= ENDGAME_MATERIAL) return "endgame";
	return "middlegame";
}
