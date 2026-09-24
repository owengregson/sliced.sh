// src/offscreen/asset-store/hash.ts
/** SHA-256 over asset bytes, as lowercase hex: what every registry hash is compared against. */

export type Digest = (data: Uint8Array) => Promise<ArrayBuffer>;

export const defaultDigest: Digest = (data) =>
	crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);

export async function sha256Hex(data: Uint8Array, digest: Digest = defaultDigest): Promise<string> {
	const hash = new Uint8Array(await digest(data));
	let hex = "";
	for (const b of hash) hex += b.toString(16).padStart(2, "0");
	return hex;
}
