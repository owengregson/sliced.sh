// src/page/cursor-probe.ts
/**
 * `cursor-probe` (§5.5) — CDP `Runtime.evaluate` fallback only.
 *
 * The canonical path for "the last known pointer position captured by a
 * capture-phase listener installed once" is the MAIN-world bridge: each
 * bridge keeps that position in its closure and answers the `cursor`
 * command, which the content script relays on the game port as
 * `cursorProbe` → `cursorProbeResult` (see `src/page/index.ts`). §13.3 rule 3
 * forbids a `window` marker, so a fresh CDP evaluation has nothing it can
 * read synchronously: this expression returns `null` immediately and never
 * waits, and installs no listener. A single IIFE expression, no top-level
 * `return`, `returnByValue` friendly.
 */

import { defineProgram, js } from "@pagescript";

export const cursorProbe = defineProgram({
	name: "cursor-probe",
	params: {},
	build: () => js.program([js.expr(js.iife([js.ret(js.nil())]))]),
});
