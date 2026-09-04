/**
 * Base64 ⇄ bytes for payloads that must cross a `chrome.runtime` port.
 * Ports JSON-serialise their messages (no structured clone — crbug.com/248548),
 * so binary data such as NNUE chunks travels as base64 text. `btoa` needs a
 * binary string; it is built in bounded slices because
 * `String.fromCharCode(...bigArray)` spreads every byte onto the call stack.
 */

const SLICE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += SLICE) {
		const slice = bytes.subarray(i, i + SLICE);
		binary += String.fromCharCode.apply(null, slice as unknown as number[]);
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}
