// src/offscreen/stockfish-loader/relaxed-simd.ts
/** The relaxed-SIMD capability check: only relaxed-simd engine builds ship, so it gates the boot. */

/** Status error when the runtime rejects relaxed SIMD: the only engine builds shipped need it. */
export const RELAXED_SIMD_ERROR = "relaxed SIMD unsupported (Chrome 114 or newer is required)";

/**
 * Smallest module exercising a relaxed-simd instruction: one function
 * `() -> v128` computing `i8x16.relaxed_swizzle(v128.const 0, v128.const 0)`.
 * `WebAssembly.validate` accepts it only where the relaxed-simd proposal is
 * implemented (Chrome ≥ 114).
 */
export const RELAXED_SIMD_PROBE: Uint8Array = Uint8Array.of(
	0x00,
	0x61,
	0x73,
	0x6d, // magic
	0x01,
	0x00,
	0x00,
	0x00, // version
	0x01,
	0x05,
	0x01,
	0x60,
	0x00,
	0x01,
	0x7b, // type: () -> v128
	0x03,
	0x02,
	0x01,
	0x00, // function 0 has type 0
	0x0a,
	0x2b,
	0x01,
	0x29,
	0x00, // code section, one body, no locals
	0xfd,
	0x0c,
	...new Array<number>(16).fill(0), // v128.const 0
	0xfd,
	0x0c,
	...new Array<number>(16).fill(0), // v128.const 0
	0xfd,
	0x80,
	0x02, // i8x16.relaxed_swizzle (0xfd 0x100)
	0x0b // end
);

export function supportsRelaxedSimd(validate: (bytes: Uint8Array) => boolean): boolean {
	try {
		return validate(RELAXED_SIMD_PROBE);
	} catch {
		return false;
	}
}
