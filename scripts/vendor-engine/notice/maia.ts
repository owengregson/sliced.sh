// scripts/vendor-engine/notice/maia.ts — the Maia-3 policy-model section (AGPL-3.0-or-later).

import type { MaiaNotice } from "../manifests";
import type { MaiaRegistry } from "../registry";
import { count, fileRow, probDiff } from "./table";

export function renderMaiaSection(registry: MaiaRegistry, m: MaiaNotice, website: string): string {
	const up = registry.MAIA_UPSTREAM;
	const dir = registry.MAIA_DIR;
	const sizeRow = (size: string) => {
		const reg = registry.MAIA_MODEL_FILES[size];
		const man = m.manifest.models[size];
		if (!reg || !man) return "";
		const diff = probDiff(man.maxAbsProbDiffOnnxVsTorch);
		return `| ${size.toUpperCase()} | \`${reg.file}\` | ${count(reg.params)} | \`${reg.upstream.repo}\` | \`${reg.upstream.revision.slice(0, 12)}\` | \`${reg.upstream.checkpoint}\` (${count(reg.upstream.bytes)} B) | \`${reg.upstream.sha256}\` | ${diff} |`;
	};
	const split = registry.MAIA_SIZES.filter((s) => (registry.MAIA_MODEL_FILES[s]?.parts ?? 1) > 1);
	const splitNote = split
		.map((s) => {
			const reg = registry.MAIA_MODEL_FILES[s];
			if (!reg) return "";
			return `\`${reg.file}\` (${count(reg.bytes)} B) is over the Git host's 100 MB per-file cap, so the repository stores it as ${reg.parts} consecutive slices — \`${reg.file}${registry.MAIA_FILES.partSuffix}<i>\`, each but the last exactly ${count(registry.MAIA_FILES.partBytes)} bytes. The build (\`scripts/maia-assets.ts\`) joins them, checks the joined bytes against the registry and ships one whole file; \`verify-dist\` fails the build if a slice ships.`;
		})
		.join(" ");
	return `## Maia-3 human move-policy models — \`${dir}\`

sliced.sh's move *selection* below the Elite band draws on **${up.name}** (CSSLab, University of
Toronto; Monroe, Eilender, Chalmers, Tang and Anderson, *${up.paperTitle}*, ${up.paper}), the
human move-prediction transformer published at ${up.repo} (code commit
\`${m.manifest.upstream.commit}\`) with its checkpoints on the Hugging Face hub (${up.hub}).
Required notice: ${up.copyright}. The repository is licensed under the **${up.licenseName}**
(${up.licenseUrl}; SPDX \`${up.license}\`); the model cards state no separate weight licence and
point to the repository for it, so the weights are distributed under the same licence by that
pointer. The ONNX files below are derived works of those weights (the same parameters, stored as
float16 behind \`Cast\`, opset ${m.manifest.export.opset}, exported by \`${m.manifest.export.script}\`) and are
distributed under the same licence; the AGPL text ships with the extension as \`${dir}${registry.MAIA_FILES.license}\`.
Nothing in sliced.sh's own source is derived from the Maia-3 code: the model runs through
onnxruntime-web, and the extension's input encoder is written from the paper's description.
AGPL §13 (network interaction) does not arise — the model runs on the user's machine and serves
nobody over a network.

Export: \`${m.manifest.export.script}\` (torch ${m.manifest.export.torch}, onnx ${m.manifest.export.onnx},
onnxruntime ${m.manifest.export.onnxruntime}; the input layout, parity and latency are in \`docs/models.md\`).
Each size is one checkpoint, pinned by Hugging Face revision and SHA-256:

| Size | File | Params | HF repo | Revision | Checkpoint | Checkpoint SHA-256 | max \\|Δprob\\| vs torch fp32 |
|---|---|---|---|---|---|---|---|
${registry.MAIA_SIZES.map(sizeRow).filter(Boolean).join("\n")}

### Source offer

The complete corresponding source of these models is the Maia-3 repository at
${up.repo}/commit/${m.manifest.upstream.commit} together with the checkpoints at the Hugging Face
revisions in the table above; the export tool that produced the ONNX files is in this repository.
The written offer in the Stockfish section (a durable medium on request, as AGPL-3.0 §6
requires; contact details at ${website}) covers them as well.

### Repository layout

${splitNote}

Shipped in the extension (whole files, as the build writes them):

| File | Bytes | SHA-256 |
|---|---|---|
${m.models.map(fileRow).join("\n")}

Stored in the repository:

| File | Bytes | SHA-256 |
|---|---|---|
${[...m.sources, ...m.sideFiles].map(fileRow).join("\n")}`;
}
