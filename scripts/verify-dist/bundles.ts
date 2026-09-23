// scripts/verify-dist/bundles.ts — rules 4–6 over the shipped scripts: size budgets, no stray
// `console.` in a production bundle, and host ownership.
//
// `@core/logger` is the only sanctioned console use and reaches it through a computed member,
// `console[level]`, so a literal `console.` in a shipped bundle is always a stray call. Every
// host that appears in the constants registry may appear only in the bundles `HOST_OWNERS`
// names, and a host that is not in that table fails the build — so adding a URL forces a
// decision about which realms may see it, instead of a bundler quietly inlining an object
// literal into `content.js` (§13.3 rule 2).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/paths";
import { formatBytes } from "../lib/report";
import { BUNDLE_BUDGETS, HOST_OWNERS, REGISTRY_DIR } from "./policy";

export interface SizeRow {
	file: string;
	bytes: number;
	budget: number | null;
}

/** The size report's rows: every shipped script with its §11.2 budget, if it has one. */
export function sizeRows(scripts: readonly string[], sizeOf: (file: string) => number): SizeRow[] {
	return scripts.map((file) => ({
		file,
		bytes: sizeOf(file),
		budget: BUNDLE_BUDGETS[file] ?? null,
	}));
}

/**
 * Budget problems: a budgeted bundle over its cap (release builds only) or not built at all.
 *
 * §11.2 budgets the bytes that **ship**, so they are enforced on the release build and reported
 * only on a `--dev` one. A dev bundle is not minified — the panel is 246.5 KiB released and
 * 430.9 KiB dev, a fixed ~1.75× — so a 400 KiB cap applied to it is really a 229 KiB cap on the
 * shipped bundle, a number nobody chose. The same reasoning already excludes source maps from
 * the rows, and `dev` already relaxes the `console.` scan and the source-map check.
 * Enforcing it here instead made `bun run build --dev` fail outright, which is the build the
 * extension is loaded unpacked from (`CLAUDE.md` § Commands).
 */
export function checkBudgets(
	sizes: readonly SizeRow[],
	present: ReadonlySet<string>,
	dev: boolean
): string[] {
	const problems: string[] = [];
	if (!dev)
		for (const row of sizes)
			if (row.budget !== null && row.bytes > row.budget)
				problems.push(
					`${row.file} is ${formatBytes(row.bytes)}, over its ${formatBytes(row.budget)} budget (§11.2)`
				);
	for (const budgeted of Object.keys(BUNDLE_BUDGETS))
		if (!present.has(budgeted)) problems.push(`${budgeted} was not built`);
	return problems;
}

/** Host of the licence endpoint, or `null` when `licenseUrl` is not an absolute URL. */
export function licenseHost(licenseUrl: string): string | null {
	try {
		return new URL(licenseUrl).hostname;
	} catch {
		return null;
	}
}

const URL_LITERAL_RE = /https?:\/\/([A-Za-z0-9.-]+)/g;

/**
 * Every distinct host mentioned by an absolute URL in the registry sources, plus the licence
 * endpoint's. Sorted, so the failure message is stable.
 */
export function registryHosts(
	sources: Record<string, string>,
	licenseUrl: string | null
): string[] {
	const hosts = new Set<string>();
	for (const text of Object.values(sources))
		for (const m of text.matchAll(URL_LITERAL_RE)) if (m[1]) hosts.add(m[1]);
	const licence = licenseUrl === null ? null : licenseHost(licenseUrl);
	if (licence !== null) hosts.add(licence);
	return [...hosts].sort();
}

/** The constants registry's sources, keyed by file name. */
export function readRegistry(dir = path.join(ROOT, REGISTRY_DIR)): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of readdirSync(dir))
		if (entry.endsWith(".ts")) out[entry] = readFileSync(path.join(dir, entry), "utf8");
	return out;
}

/**
 * A host is looked for as `//<host>`, not bare: `*://*.chess.com/*` is a match pattern, not a
 * URL, and the content script legitimately carries the site pattern. Only a real absolute URL
 * literal has the `//` in front of the host.
 */
export function hostNeedle(host: string): string {
	return `//${host}`;
}

/** Hosts derived from the registry that `HOST_OWNERS` does not classify. */
export function unclassifiedHosts(hosts: readonly string[]): string[] {
	return hosts.filter((h) => HOST_OWNERS[h] === undefined);
}

/** Line number (1-based) of the first occurrence of `needle`, or 0. */
function firstLine(text: string, needle: string): number {
	const at = text.indexOf(needle);
	return at < 0 ? 0 : text.slice(0, at).split("\n").length;
}

export interface ScanOptions {
	dev: boolean;
	/** Hosts derived from the constants registry; each is looked up in `HOST_OWNERS`. */
	hosts: readonly string[];
}

/** Content rules for one shipped bundle (§11.2 step 10). */
export function scanBundle(file: string, text: string, options: ScanOptions): string[] {
	const problems: string[] = [];
	if (!options.dev) {
		const hits = text.match(/console\./g)?.length ?? 0;
		if (hits > 0)
			problems.push(
				`${file}: ${hits} \`console.\` call(s) in a production bundle (first at line ${firstLine(text, "console.")})`
			);
	}
	for (const host of options.hosts) {
		const needle = hostNeedle(host);
		if (!text.includes(needle)) continue;
		const owners = HOST_OWNERS[host];
		if (owners === undefined) continue; // reported once, by `unclassifiedHosts`
		if (!owners.includes(file))
			problems.push(
				`${file}: contains the registry host "${host}" — HOST_OWNERS allows it only in ${
					owners.length === 0 ? "no bundle" : owners.join(", ")
				} (§13.3)`
			);
	}
	return problems;
}

/**
 * A host the registry introduced but `HOST_OWNERS` does not classify is reported once, before
 * the per-bundle scans: the fix is to classify it, not to move it.
 */
export function checkBundleContent(
	scripts: readonly string[],
	read: (file: string) => string | null,
	options: ScanOptions
): string[] {
	const problems: string[] = [];
	for (const host of unclassifiedHosts(options.hosts))
		problems.push(
			`registry host "${host}" is not in HOST_OWNERS — add it to scripts/verify-dist.ts and say which bundles may carry it (§13.3)`
		);
	for (const file of scripts) {
		const text = read(file);
		if (text !== null) problems.push(...scanBundle(file, text, options));
	}
	return problems;
}
