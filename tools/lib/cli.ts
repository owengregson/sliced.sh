/**
 * tools/lib/cli.ts — the argument conventions the tools' command lines share.
 *
 * Two shapes exist, and each tool keeps the one it was written with (their edge cases differ, and a
 * command line that worked before must mean the same thing now):
 *
 *   - **lookup** (`flagValue` / `flagOr` / `flagValues` / `hasFlag`): flags are looked up by name
 *     anywhere in `argv`; the token after a flag is its value, whatever it looks like; unknown
 *     flags are ignored. `flagValue` and `flagOr` read the **first** occurrence, `flagValues` every
 *     one.
 *   - **strict** (`parseFlags`): `argv` is walked left to right against a declared table; an
 *     undeclared token throws `unknown argument <token>`; a value flag always consumes the next
 *     token; a repeated flag keeps its **last** value. A value flag at the end of `argv` either
 *     throws `<flag> needs a value` or records `undefined`, per `missingValue`.
 */

/**
 * The token after the first `--<name>`, or `fallback` when the flag is absent. A flag present with
 * nothing after it reads as `undefined`, not as the fallback.
 */
export function flagValue(
	argv: readonly string[],
	name: string,
	fallback?: string
): string | undefined {
	const at = argv.indexOf(`--${name}`);
	return at >= 0 ? argv[at + 1] : fallback;
}

/**
 * The token after the first `--<name>`, or `fallback` when the flag is absent **or** has nothing
 * after it (unlike `flagValue`, a trailing flag reads as the fallback).
 */
export function flagOr(argv: readonly string[], name: string, fallback: string): string {
	return flagValue(argv, name) ?? fallback;
}

/** The token after every `--<name>` that has one, in order. */
export function flagValues(argv: readonly string[], name: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < argv.length; i++)
		if (argv[i] === `--${name}` && argv[i + 1] !== undefined) values.push(argv[i + 1] as string);
	return values;
}

/** Whether the bare token `--<name>` appears. */
export function hasFlag(argv: readonly string[], name: string): boolean {
	return argv.includes(`--${name}`);
}

export type FlagKind = "value" | "switch";

export interface ParseFlagsOptions {
	/** A value flag with no token after it: throw `<flag> needs a value`, or record `undefined`. */
	missingValue: "throw" | "undefined";
}

/**
 * The strict walk. Returns every flag seen (`switch` flags as `true`), keyed by the flag token
 * itself (`"--out"`); read defaults with `has` / `get` at the call site.
 */
export function parseFlags(
	argv: readonly string[],
	flags: Readonly<Record<string, FlagKind>>,
	options: ParseFlagsOptions
): Map<string, string | true | undefined> {
	const seen = new Map<string, string | true | undefined>();
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i] as string;
		const kind = Object.hasOwn(flags, flag) ? flags[flag] : undefined;
		if (kind === undefined) throw new Error(`unknown argument ${argv[i]}`);
		if (kind === "switch") {
			seen.set(flag, true);
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined && options.missingValue === "throw")
			throw new Error(`${flag} needs a value`);
		seen.set(flag, value);
		i++;
	}
	return seen;
}

/** A value flag's string from a `parseFlags` result (`undefined` when absent or valueless). */
export function flagText(
	seen: ReadonlyMap<string, string | true | undefined>,
	flag: string
): string | undefined {
	const value = seen.get(flag);
	return value === true ? undefined : value;
}
