// scripts/vendor-engine/notice/models.ts — the ChessMimic timing-model section (Task 34).

import type { ModelsNotice } from "../manifests";
import type { ModelsRegistry } from "../registry";
import { count, fileRow, probDiff } from "./table";

export function renderModelsSection(registry: ModelsRegistry, m: ModelsNotice): string {
	const up = registry.CHESSMIMIC_UPSTREAM;
	const bandRow = (band: string) => {
		const b = m.manifest.bands[band];
		if (!b) return "";
		const diff = probDiff(b.maxAbsProbDiffOnnxVsTorch);
		return `| ${band.replace("_", "–")} | \`${b.file}\` | \`${b.checkpoint.lfsOid.slice(0, 12)}\` | ${count(b.bytes)} | ${diff} |`;
	};
	return `## ChessMimic timing model — \`${registry.MODELS_DIR}\`

sliced.sh's human move-timing head is the clock model of **${up.name}** (Thomas Johnson, 2026;
the engine behind ${up.site}), exported from the checkpoints published at ${up.repo} (commit
\`${up.commit}\`). Required Notice: ${up.copyright}. The source code **and the trained weights** are licensed
under the **${up.licenseName}** (${up.licenseUrl}; SPDX \`${up.license}\`) — the weights may
only be used for non-commercial purposes, which is what sliced.sh is. The ONNX files below are
derived works of those weights (same parameters, stored as float16, opset ${m.manifest.export.opset}) and are
distributed under the same licence; the PolyForm text is reproduced in the upstream \`LICENSE\`.
The searchless_chess FEN tokeniser ChessMimic builds on is Apache-2.0 (google-deepmind); the
extension's TypeScript transcription of it lives in \`src/core/timing/chessmimic-tokeniser.ts\`.

Export: \`${m.manifest.export.script}\` (torch ${m.manifest.export.torch}, onnx ${m.manifest.export.onnx},
onnxruntime ${m.manifest.export.onnxruntime}; details, latency and the reference fixture in \`docs/models.md\`).

| Band (Elo) | File | Checkpoint (LFS oid) | Bytes | max \\|Δprob\\| vs torch fp32 |
|---|---|---|---|---|
${[...registry.CHESSMIMIC_BANDS].map(bandRow).filter(Boolean).join("\n")}

Bands that are registered but not bundled would download from \`${registry.chessmimicBandBase}\` and
are verified against the SHA-256 in \`src/core/constants/models.ts\` before use.

| File | Bytes | SHA-256 |
|---|---|---|
${[...m.bands, ...m.sideFiles].map(fileRow).join("\n")}`;
}
