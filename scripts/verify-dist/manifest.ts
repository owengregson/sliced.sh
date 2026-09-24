// scripts/verify-dist/manifest.ts — rules 1–2: every path the stamped manifest declares exists,
// and the manifest exposes nothing to the page.

import { asArray, asString, isRecord } from "../lib/json";
import { FORBIDDEN_MANIFEST_KEYS } from "./policy";

export interface DeclaredPath {
	/** Extension-relative path exactly as the manifest spells it. */
	path: string;
	/** Where it came from, for the error message. */
	where: string;
	/** `web_accessible_resources` entries may be patterns; they must match ≥ 1 file. */
	glob: boolean;
}

/** Every extension-relative path the manifest declares. */
export function manifestPaths(manifest: unknown): DeclaredPath[] {
	const out: DeclaredPath[] = [];
	if (!isRecord(manifest)) return out;
	const push = (raw: unknown, where: string): void => {
		const p = asString(raw);
		if (p === null || p === "") return;
		out.push({ path: p, where, glob: p.includes("*") });
	};

	const icons = manifest.icons;
	if (isRecord(icons)) for (const [size, v] of Object.entries(icons)) push(v, `icons.${size}`);

	const action = manifest.action;
	if (isRecord(action)) {
		const icon = action.default_icon;
		if (isRecord(icon))
			for (const [size, v] of Object.entries(icon)) push(v, `action.default_icon.${size}`);
		else push(icon, "action.default_icon");
		push(action.default_popup, "action.default_popup");
	}

	const sidePanel = manifest.side_panel;
	if (isRecord(sidePanel)) push(sidePanel.default_path, "side_panel.default_path");

	const background = manifest.background;
	if (isRecord(background)) push(background.service_worker, "background.service_worker");

	const scripts = asArray(manifest.content_scripts);
	for (let i = 0; i < scripts.length; i += 1) {
		const entry = scripts[i];
		if (!isRecord(entry)) continue;
		const js = asArray(entry.js);
		for (let k = 0; k < js.length; k += 1) push(js[k], `content_scripts[${i}].js[${k}]`);
		const css = asArray(entry.css);
		for (let k = 0; k < css.length; k += 1) push(css[k], `content_scripts[${i}].css[${k}]`);
	}

	const war = asArray(manifest.web_accessible_resources);
	for (let i = 0; i < war.length; i += 1) {
		const entry = war[i];
		if (!isRecord(entry)) continue;
		const resources = asArray(entry.resources);
		for (let k = 0; k < resources.length; k += 1)
			push(resources[k], `web_accessible_resources[${i}].resources[${k}]`);
	}

	return out;
}

/**
 * Chrome's extension-resource patterns, where `*` spans path separators
 * (`assets/engine/*` covers a nested file just as it covers a flat one).
 */
export function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`);
}

/** Manifest-level problems: missing paths, a wrong version stamp, a resurrected `update_url`. */
export function checkManifest(
	manifest: unknown,
	files: readonly string[],
	expectedVersion: string | undefined
): string[] {
	const problems: string[] = [];
	if (!isRecord(manifest)) return ["manifest.json is not an object"];
	const present = new Set(files);

	if (manifest.manifest_version !== 3)
		problems.push(`manifest_version is ${String(manifest.manifest_version)}, expected 3`);
	if (expectedVersion !== undefined && manifest.version !== expectedVersion)
		problems.push(`manifest version is ${String(manifest.version)}, expected ${expectedVersion}`);
	if (asString(manifest.key) === null)
		problems.push("manifest has no `key` — the extension ID would not be stable (§12.2)");
	for (const key of FORBIDDEN_MANIFEST_KEYS)
		if (key in manifest) problems.push(`manifest declares \`${key}\` — dropped in v2 (§12.2)`);
	problems.push(...checkWebAccessibleResources(manifest));

	for (const declared of manifestPaths(manifest)) {
		if (declared.glob) {
			const re = globToRegExp(declared.path);
			if (!files.some((f) => re.test(f)))
				problems.push(`${declared.where}: "${declared.path}" matches no file in dist/`);
		} else if (!present.has(declared.path)) {
			problems.push(`${declared.where}: "${declared.path}" is missing from dist/`);
		}
	}
	return problems;
}

/**
 * §13.3: the manifest pins `key`, so the extension id is fixed and any script on a matched site
 * can probe `fetch("chrome-extension://<id>/<path>")` for a web-accessible resource; a success is
 * a definitive presence signal. v2 declares none — the engine assets are loaded by the offscreen
 * document and the sounds by the side panel, both of which are extension pages that need no
 * declaration (`grep -r "runtime.getURL" src/content src/page` is empty). If the block ever
 * returns, every entry must carry `use_dynamic_url: true`, which rotates the URL token per
 * session and makes the probe useless.
 */
export function checkWebAccessibleResources(manifest: unknown): string[] {
	if (!isRecord(manifest)) return [];
	const declared = manifest.web_accessible_resources;
	if (declared === undefined) return [];
	const entries = asArray(declared);
	// A present-but-unreadable declaration is not a pass. Chrome rejects such a manifest at load,
	// but this rule must not be the thing that waved it through.
	if (entries.length === 0)
		return [
			"web_accessible_resources is present but is not a non-empty array — it must be absent, or an array whose every entry sets `use_dynamic_url: true` (§13.3)",
		];
	const problems: string[] = [];
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		const resources = isRecord(entry) ? asArray(entry.resources).join(", ") : String(entry);
		if (!isRecord(entry) || entry.use_dynamic_url !== true)
			problems.push(
				`web_accessible_resources[${i}] (${resources}) has no \`use_dynamic_url: true\` — a fixed extension id plus a web-accessible path is a presence probe from any matched site (§13.3)`
			);
	}
	return problems;
}

/** The stamped `manifest.json`'s problems, from its text (`null` when the file is missing). */
export function checkManifestText(
	text: string | null,
	files: readonly string[],
	expectedVersion: string | undefined
): string[] {
	if (text === null) return ["manifest.json is missing from dist/ (the stamp step did not run)"];
	let manifest: unknown;
	try {
		manifest = JSON.parse(text);
	} catch (error) {
		return [`manifest.json is not valid JSON: ${String(error)}`];
	}
	return manifest === null ? [] : checkManifest(manifest, files, expectedVersion);
}
