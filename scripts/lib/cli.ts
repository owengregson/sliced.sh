// scripts/lib/cli.ts — argv parsing for the scripts' thin command-line entry points.

/** The bare `--flag`s of an argv (every token; flags are matched by exact name). */
export function cliFlags(argv: readonly string[] = process.argv.slice(2)): ReadonlySet<string> {
	return new Set(argv);
}

/**
 * The value following `flag`, or `undefined` when the flag is absent. A flag with no value
 * (last token, or followed by another `--flag`) is an error attributed to `tool`.
 */
export function flagValue(argv: readonly string[], flag: string, tool: string): string | undefined {
	const i = argv.indexOf(flag);
	if (i < 0) return undefined;
	const value = argv[i + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`${tool}: ${flag} requires a value`);
	}
	return value;
}
