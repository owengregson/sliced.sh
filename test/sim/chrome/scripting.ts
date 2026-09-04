// test/sim/chrome/scripting.ts
/**
 * `chrome.scripting.executeScript` stub: records every injection and answers
 * `[{ frameId: 0, result: undefined }]` unless a test installs a responder
 * with `respond(fn)`. The manifest does not request `scripting` (Task 10);
 * the stub exists so code probing for the API sees Chrome's shape.
 */

import type { Bus } from "@test/sim/contexts/bus";

export type ScriptInjection = chrome.scripting.ScriptInjection<unknown[], unknown>;
export type InjectionResponder = (
	injection: ScriptInjection
) =>
	| chrome.scripting.InjectionResult<unknown>[]
	| Promise<chrome.scripting.InjectionResult<unknown>[]>;

export function createScriptingSubsystem(bus: Bus) {
	const injections: ScriptInjection[] = [];
	let responder: InjectionResponder = () => [
		{ frameId: 0, documentId: "sim-doc", result: undefined },
	];

	const api = {
		executeScript(injection: ScriptInjection, callback?: unknown) {
			injections.push(injection);
			return bus.settleAsync(
				callback,
				Promise.resolve().then(() => responder(injection))
			);
		},
	};

	return {
		api,
		injections,
		respond(fn: InjectionResponder): void {
			responder = fn;
		},
	};
}

export type ScriptingSubsystem = ReturnType<typeof createScriptingSubsystem>;
