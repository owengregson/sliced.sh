/**
 * tools/human-match/maia.ts — the shipped Maia-3 ONNX models under Bun, answering the way the
 * offscreen host does: `encodeMaiaInputs` → `session.run` → `decodeMaiaOutputs`. The vendored
 * onnxruntime-web wasm backend on one thread (`test/integration/maia-onnx.test.ts` is the parity
 * proof for this exact path). Nothing here runs in the extension.
 */

import "./defines";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	MAIA_DIR,
	MAIA_FILES,
	MAIA_INPUT,
	MAIA_MODEL_FILES,
	type MaiaSize,
} from "@core/constants/maia";
import { encodeMaiaInputs } from "@core/policy/maia-encoder";
import { decodeMaiaOutputs } from "@core/policy/maia-policy";
import type { PolicyResult } from "@core/policy/types";
import { createOrtRuntime, type OrtRuntime, type OrtSession } from "@offscreen/ort-loader";

const ROOT = path.resolve(import.meta.dir, "../..");

export interface MaiaRunner {
	/** `historyFens` oldest → newest, the last equal to the position to move in. */
	query(
		size: MaiaSize,
		historyFens: readonly string[],
		selfElo: number,
		oppoElo: number
	): Promise<PolicyResult>;
	dispose(): Promise<void>;
}

/** The model bytes as the build ships them: whole, or the repository's parts joined. */
export async function maiaModelBytes(size: MaiaSize): Promise<Uint8Array | null> {
	const spec = MAIA_MODEL_FILES[size];
	const base = path.join(ROOT, MAIA_DIR, spec.file);
	if (spec.parts <= 1) {
		const file = Bun.file(base);
		return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : null;
	}
	const parts: ArrayBuffer[] = [];
	for (let i = 0; i < spec.parts; i++) {
		const file = Bun.file(`${base}${MAIA_FILES.partSuffix}${i}`);
		if (!(await file.exists())) return null;
		parts.push(await file.arrayBuffer());
	}
	const joined = new Uint8Array(parts.reduce((n, b) => n + b.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(new Uint8Array(part), offset);
		offset += part.byteLength;
	}
	return joined;
}

export async function createMaiaRunner(threads = 1): Promise<MaiaRunner> {
	const runtime: OrtRuntime = await createOrtRuntime({
		importModule: (url) => import(url),
		getUrl: (p) => pathToFileURL(path.join(ROOT, p)).href,
		threads,
	});
	const sessions = new Map<MaiaSize, OrtSession>();
	const sessionFor = async (size: MaiaSize): Promise<OrtSession> => {
		const open = sessions.get(size);
		if (open) return open;
		const bytes = await maiaModelBytes(size);
		if (!bytes) throw new Error(`${MAIA_DIR}${MAIA_MODEL_FILES[size].file} is not in the checkout`);
		const session = await runtime.createSession(bytes);
		sessions.set(size, session);
		return session;
	};
	return {
		async query(size, historyFens, selfElo, oppoElo) {
			const session = await sessionFor(size);
			const encoded = encodeMaiaInputs(historyFens);
			const feeds = {
				[MAIA_INPUT.inputs.tokens]: runtime.tensor("float32", encoded.tokens, [
					1,
					MAIA_INPUT.squares,
					MAIA_INPUT.tokenDim,
				]),
				[MAIA_INPUT.inputs.selfElo]: runtime.tensor("float32", Float32Array.of(selfElo), [1]),
				[MAIA_INPUT.inputs.oppoElo]: runtime.tensor("float32", Float32Array.of(oppoElo), [1]),
			};
			const start = performance.now();
			const out = await session.run(feeds);
			const ms = performance.now() - start;
			const moveLogits = out[MAIA_INPUT.outputs.move]?.data;
			const valueLogits = out[MAIA_INPUT.outputs.value]?.data;
			if (!moveLogits || !valueLogits) throw new Error(`maia ${size}: missing outputs`);
			const decoded = decodeMaiaOutputs(moveLogits, valueLogits, encoded);
			return { moves: decoded.moves, wdl: decoded.wdl, size, ms };
		},
		async dispose() {
			for (const session of sessions.values()) await session.release();
			sessions.clear();
		},
	};
}
