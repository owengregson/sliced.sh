// src/page/arrow-shape/geometry.ts
/** The arrow silhouette's dimensions, baked into the emitted routines at build time. */

/** The silhouette at scale 1, in board units (1 = one square). `shadowOpacity` is not a length. */
const A = {
	shaftHalfWidth: 0.105,
	headHalfWidth: 0.3,
	headLength: 0.43,
	cornerRadius: 0.04,
	startInset: 0.25,
	tailRadius: 0.1,
	tipRadius: 0.055,
	shadowOffset: 0.026,
	shadowBlur: 0.018,
	shadowOpacity: 0.18,
	fadeLength: 0.9,
} as const;

export type ArrowGeometry = Record<Exclude<keyof typeof A, "shadowOpacity">, number>;

/**
 * Every length of the silhouette multiplied by `scale`, rounded to six decimals so the emitted
 * numbers stay short. At scale 1 every value is exactly `A`'s.
 */
export function arrowGeometry(scale = 1): ArrowGeometry {
	const at = (v: number): number => Number((v * scale).toFixed(6));
	return {
		shaftHalfWidth: at(A.shaftHalfWidth),
		headHalfWidth: at(A.headHalfWidth),
		headLength: at(A.headLength),
		cornerRadius: at(A.cornerRadius),
		startInset: at(A.startInset),
		tailRadius: at(A.tailRadius),
		tipRadius: at(A.tipRadius),
		shadowOffset: at(A.shadowOffset),
		shadowBlur: at(A.shadowBlur),
		fadeLength: at(A.fadeLength),
	};
}

/** The stub the draw animation grows from: the head, the tail cap and one corner, at `scale`. */
export function arrowStubLength(scale = 1): number {
	const g = arrowGeometry(scale);
	return g.headLength + g.tailRadius + g.cornerRadius;
}

/** The shadow's opacity: not a length, so it does not scale. */
export const ARROW_SHADOW_OPACITY = A.shadowOpacity;
