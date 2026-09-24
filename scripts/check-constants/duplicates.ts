// scripts/check-constants/duplicates.ts — rules (a) and (b): a namespaced literal defined in a
// registry and re-declared elsewhere, and a `// const: <Name>` number outside a registry.

import { isRegistryFile, REGISTRY_DIRS } from "./scope";

const LITERAL_RE = /(["'`])((?:sl::|sl:|sl-|__sl_)[A-Za-z0-9:_\-.]+)\1/g;
const CONST_MARKER_RE = /\/\/\s*const:\s*([A-Za-z_$][\w$.]*)?/;
const NUMBER_RE = /(?<![\w$.])\d[\d_]*(?:\.\d+)?(?![\w$])/g;

export interface Duplicate {
	file: string;
	literal: string;
	definedIn: string;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Registry file that mentions the marker's name (last dotted segment), else the registry dir. */
function registryFor(name: string | undefined, registries: Array<[string, string]>): string {
	const fallback = REGISTRY_DIRS[0] ?? "";
	if (!name) return fallback;
	const leaf = name.split(".").pop();
	if (!leaf) return fallback;
	const re = new RegExp(`\\b${escapeRe(leaf)}\\b`);
	const hit = registries.find(([, src]) => re.test(src));
	return hit ? hit[0] : fallback;
}

function markedNumbers(
	file: string,
	src: string,
	registries: Array<[string, string]>,
	out: Duplicate[]
): void {
	for (const line of src.split("\n")) {
		const marker = CONST_MARKER_RE.exec(line);
		if (!marker) continue;
		const code = line.slice(0, marker.index);
		const definedIn = registryFor(marker[1], registries);
		for (const m of code.matchAll(NUMBER_RE)) out.push({ file, literal: m[0], definedIn });
	}
}

export function findDuplicateLiterals(files: Record<string, string>): Duplicate[] {
	const entries = Object.entries(files);
	const registries = entries.filter(([f]) => isRegistryFile(f));
	const defined = new Map<string, string>();
	for (const [f, src] of registries)
		for (const m of src.matchAll(LITERAL_RE)) {
			const literal = m[2];
			if (literal !== undefined && !defined.has(literal)) defined.set(literal, f);
		}
	const out: Duplicate[] = [];
	for (const [f, src] of entries) {
		if (isRegistryFile(f)) continue;
		for (const m of src.matchAll(LITERAL_RE)) {
			const literal = m[2];
			if (literal === undefined) continue;
			const def = defined.get(literal);
			if (def) out.push({ file: f, literal, definedIn: def });
		}
		markedNumbers(f, src, registries, out);
	}
	return out;
}
