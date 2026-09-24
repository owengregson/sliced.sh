// scripts/lib/hash.ts — the one SHA-256 helper the asset scripts share.

import { createHash } from "node:crypto";

export function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}
