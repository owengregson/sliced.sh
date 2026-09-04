// src/pagescript/bind.ts
/**
 * `defineProgram` and `bind` (§5.4). `emit` prints every `$$param:x` slot as
 * the quoted placeholder literal `"$$param:x"`; `bindCode` replaces each
 * placeholder — quotes included — with `(JSON.stringify(args.x))`, so string
 * parameters land as JS string literals, `json` parameters as object/array
 * literals, and `number` / `boolean` parameters as bare literals. The
 * parentheses keep every substitution an expression (`() => ({...})`,
 * `(-3) ** 2`); substitution is a single regex pass with a lookup, so a value
 * that itself contains placeholder text can never be re-substituted.
 *
 * Encoding note: `JSON.stringify` output may contain U+2028/U+2029 or
 * `</script>`; both are legal inside JS string literals on Chrome >= 128 and
 * irrelevant for our delivery paths (script files and CDP evaluate).
 *
 * The generator (`scripts/gen-pagescript.ts`) inlines an equivalent of
 * `bindCode` into each generated module so shipped code never imports this
 * file. Build/test-time only: nothing under `src/pagescript/` is imported by a
 * runtime entry bundle (§5.4).
 */

import { emit } from "./emit";
import {
	isBindingName,
	isParamBindingName,
	PARAM_PREFIX,
	PagescriptError,
	type Param,
	type ParamSpec,
	type ParamType,
	type ParamValue,
	type Program,
} from "./nodes";
import { resolveSpoofSeed } from "./spoof";

export type ParamMap = Record<string, ParamType>;

/** Bind-time argument object for a parameter map. */
export type ParamArgs<P extends ParamMap> = { [K in keyof P]: ParamValue<P[K]> };

/** Typed slots handed to `build(p)`. */
export type ParamSlots<P extends ParamMap> = { [K in keyof P]: Param<ParamValue<P[K]>> };

export interface ProgramDef<P extends ParamMap> {
	name: string;
	params: P;
	build: (p: ParamSlots<P>) => Program;
	/** Bundled to `dist/js/page/<name>.js` (MAIN-world content script) by the generator. */
	entry?: boolean;
	/** Bind-time constants for an `entry` program with parameters. */
	entryArgs?: ParamArgs<P>;
}

export interface PageProgram<P extends ParamMap> {
	readonly name: string;
	readonly params: P;
	readonly entry: boolean;
	readonly entryArgs: ParamArgs<P> | undefined;
	build(p: ParamSlots<P>): Program;
	/** Emit with the build seed and substitute `args` into the parameter slots. */
	bind(args: ParamArgs<P>): string;
}

/** Registry element type: any program regardless of its parameter map. */
export type AnyPageProgram = PageProgram<ParamMap>;

/** The exact text `emit` prints for a parameter slot (quotes included). */
export function paramPlaceholder(name: string): string {
	return JSON.stringify(PARAM_PREFIX + name);
}

/**
 * A fresh pattern matching one printed placeholder; group 1 is the parameter
 * name. Deliberately wider than `isParamBindingName` (it accepts `$`) so the
 * validator and the pattern can never disagree; a new object per call, so no
 * `lastIndex` state leaks between callers.
 */
export function placeholderPattern(): RegExp {
	return /"\$\$param:([A-Za-z_$][\w$]*)"/g;
}

function encode(spec: ParamSpec, value: unknown): string {
	const fail = (): never => {
		throw new TypeError(
			`bind: parameter "${spec.name}" expects ${spec.type}, got ${value === null ? "null" : typeof value}`
		);
	};
	switch (spec.type) {
		case "string":
			return typeof value === "string" ? JSON.stringify(value) : fail();
		case "number":
			return typeof value === "number" && Number.isFinite(value) ? String(value) : fail();
		case "boolean":
			return typeof value === "boolean" ? String(value) : fail();
		case "json": {
			const encoded = value === undefined ? undefined : JSON.stringify(value);
			return typeof encoded === "string" ? encoded : fail();
		}
	}
}

/** Pure substitution used by `PageProgram.bind` (and mirrored by the generator). */
export function bindCode(
	code: string,
	params: readonly ParamSpec[],
	args: Readonly<Record<string, unknown>>
): string {
	const encoded = new Map<string, string>();
	for (const spec of params) {
		if (!(spec.name in args)) throw new TypeError(`bind: missing argument "${spec.name}"`);
		encoded.set(spec.name, `(${encode(spec, args[spec.name])})`);
	}
	return code.replace(placeholderPattern(), (match, name: string) => {
		const value = encoded.get(name);
		if (value === undefined) throw new TypeError(`bind: undeclared placeholder ${match}`);
		return value;
	});
}

export function defineProgram<P extends ParamMap>(def: ProgramDef<P>): PageProgram<P> {
	if (!isBindingName(def.name.replaceAll("-", "_"))) {
		throw new PagescriptError(`defineProgram: invalid program name "${def.name}"`);
	}
	for (const name of Object.keys(def.params)) {
		if (!isParamBindingName(name)) {
			throw new PagescriptError(
				`defineProgram "${def.name}": invalid parameter name "${name}" (identifier without "$")`
			);
		}
	}
	if (def.entryArgs !== undefined && def.entry !== true) {
		throw new PagescriptError(`defineProgram "${def.name}": entryArgs requires entry: true`);
	}
	const specs: ParamSpec[] = Object.entries(def.params).map(([name, type]) => ({ name, type }));
	const program: PageProgram<P> = {
		name: def.name,
		params: def.params,
		entry: def.entry === true,
		entryArgs: def.entryArgs,
		build: def.build,
		bind(args) {
			const { code } = emit(program, { seed: resolveSpoofSeed() });
			return bindCode(code, specs, args);
		},
	};
	return program;
}
