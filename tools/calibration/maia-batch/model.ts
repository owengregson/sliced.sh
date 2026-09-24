/**
 * tools/calibration/maia-batch/model.ts — the joined Maia-3 79M model the native workers load:
 * built once from the checkout's parts under `data/calibration/cache/` (never under `assets/`),
 * checked against `MAIA_MODEL_FILES`.
 */

import { mkdirSync } from "node:fs";
import { rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAIA_MODEL_FILES } from "@core/constants/maia";
import { maiaModelBytes } from "../../lib/maia";
import { ROOT } from "../../lib/paths";

const CACHE_DIR = path.join(ROOT, "data/calibration/cache");

/** The joined 79M model under `data/calibration/cache/` (never under `assets/`), built once. */
export async function ensureJoinedModel(): Promise<string> {
	const spec = MAIA_MODEL_FILES["79m"];
	const target = path.join(CACHE_DIR, spec.file);
	const existing = await stat(target).catch(() => null);
	if (existing?.size === spec.bytes) return target;
	const bytes = await maiaModelBytes("79m");
	if (!bytes) throw new Error("maia-batch: the 79M model parts are not in the checkout");
	const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	if (bytes.byteLength !== spec.bytes || hash !== spec.sha256)
		throw new Error(`maia-batch: joined model does not match MAIA_MODEL_FILES (sha ${hash})`);
	mkdirSync(CACHE_DIR, { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	await writeFile(tmp, bytes);
	await rename(tmp, target);
	return target;
}
