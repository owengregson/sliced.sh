// src/pagescript/index.ts
/**
 * pagescript — the typed page-realm AST (C2, §5). Page programs are authored
 * as trees with `js` / `std`, wrapped by `defineProgram`, compiled by `emit`
 * and parameterised by `bind`.
 *
 * Build/test-time only: nothing under `src/pagescript/` is imported by a
 * runtime entry bundle (§5.4). The runtime consumes only the generated
 * strings + `bind` functions in `src/page/generated/`.
 */

export {
	type AnyPageProgram,
	bindCode,
	defineProgram,
	type EntryArgs,
	type EntryEnv,
	type PageProgram,
	type ParamArgs,
	type ParamMap,
	type ParamSlots,
	type ProgramDef,
	paramPlaceholder,
	placeholderPattern,
} from "./bind";
export { js } from "./builders";
export { type EmitOptions, type Emitted, emit } from "./emit";
export type {
	Arg,
	Expression,
	JsonValue,
	Literal,
	Node,
	Param,
	ParamSpec,
	ParamType,
	ParamValue,
	Statement,
	StructuralNode,
} from "./nodes";
export { PagescriptError } from "./nodes";
export { DEV_SPOOF_SEED, deriveToken, resolveSpoofSeed } from "./spoof";
export { std } from "./std";
