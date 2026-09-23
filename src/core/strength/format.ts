/** Rationale number formatting shared by the selection layer. */

/** `n` rounded to `digits` decimals with trailing zeros dropped (`0.250` → `"0.25"`). */
export function fmt(n: number, digits = 3): string {
	return Number(n.toFixed(digits)).toString();
}
