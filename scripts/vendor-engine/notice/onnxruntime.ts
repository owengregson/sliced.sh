// scripts/vendor-engine/notice/onnxruntime.ts — the ONNX Runtime Web section (Task 34, MIT).

import type { VendoredFile } from "../../lib/fs";
import type { ModelsRegistry } from "../registry";
import { fileRow } from "./table";

export function renderOnnxRuntimeSection(
	registry: ModelsRegistry,
	files: readonly VendoredFile[]
): string {
	return `## ONNX Runtime Web — \`${registry.ORT_PACKAGE}\` ${registry.ORT_VERSION}

The timing model runs through Microsoft's ONNX Runtime (${registry.onnxruntimeRepo}), MIT
licensed (Copyright (c) Microsoft Corporation); the licence text ships as
\`${registry.ORT_DIR}${registry.ORT_FILES.license}\`. The files under \`${registry.ORT_DIR}\` are unmodified copies of
the npm package's \`dist/\` files (WebAssembly backend, SIMD + threads; loaded from the extension
package, never from a CDN).

| File | Bytes | SHA-256 |
|---|---|---|
${files.map(fileRow).join("\n")}`;
}
