// scripts/lib/report.ts — how the build scripts print findings and fail.

const KIB = 1024;

/** `12.3 KiB` / `4.5 MiB`, as the size reports print them. */
export function formatBytes(bytes: number): string {
	if (bytes >= KIB * KIB) return `${(bytes / (KIB * KIB)).toFixed(1)} MiB`;
	return `${(bytes / KIB).toFixed(1)} KiB`;
}

/** `\n  - a\n  - b`: the indented list a multi-problem error message ends with. */
export function bulletList(items: readonly string[]): string {
	return `\n  - ${items.join("\n  - ")}`;
}

/**
 * The lints' failure shape: every finding on its own stderr line, then one error whose message
 * is the count. Returns normally when there is nothing to report.
 */
export function failOnFindings<T>(
	findings: readonly T[],
	format: (finding: T) => string,
	summary: (count: number) => string
): void {
	if (findings.length === 0) return;
	for (const finding of findings) console.error(format(finding));
	throw new Error(summary(findings.length));
}
