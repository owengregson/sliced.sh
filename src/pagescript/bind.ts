// src/pagescript/bind.ts
/**
 * `defineProgram` and `bind` (§5.4). `emit` prints every `$$param:x` slot as
 * the quoted placeholder literal `"$$param:x"`; `bindCode` replaces each
 * placeholder — quotes included — with `JSON.stringify(args.x)`, so string
 * parameters land as JS string literals, `json` parameters as object/array
 * literals, and `number` / `boolean` parameters as bare literals.
 *
 * The generator (`scripts/gen-pagescript.ts`) inlines an equivalent of
 * `bindCode` into each generated module so shipped code never imports this
 * file. Build/test-time only: nothing under `src/pagescript/` is imported by a
 * runtime entry bundle (§5.4).
 */

import { emit } from "./emit";
import {
	isBindingName,
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
	let out = code;
	for (const spec of params) {
		if (!(spec.name in args)) throw new TypeError(`bind: missing argument "${spec.name}"`);
		const encoded = encode(spec, args[spec.name]);
		out = out.replaceAll(paramPlaceholder(spec.name), () => encoded);
	}
	return out;
}

export function defineProgram<P extends ParamMap>(def: ProgramDef<P>): PageProgram<P> {
	if (!isBindingName(def.name.replaceAll("-", "_"))) {
		throw new PagescriptError(`defineProgram: invalid program name "${def.name}"`);
	}
	for (const name of Object.keys(def.params)) {
		if (!isBindingName(name)) {
			throw new PagescriptError(`defineProgram "${def.name}": invalid parameter name "${name}"`);
		}
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
