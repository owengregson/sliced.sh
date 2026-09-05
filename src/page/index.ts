// src/page/index.ts
/**
 * Page program registry (§5.5). `scripts/gen-pagescript.ts` compiles every
 * program listed here to `src/page/generated/<name>.ts` and, for `entry`
 * programs, to `dist/js/page/<name>.js` (the manifest's MAIN-world scripts).
 *
 * Every bind-time value comes from a registry (C1): selectors from
 * `SELECTORS`, colours from `TOKENS`, timings from `TIMINGS`, hostnames from
 * `URLS`, and the direction tokens / overlay class from `deriveToken(seed,
 * SPOOF_PURPOSES.*)` — the same derivation `src/content/page-bridge-client.ts`
 * performs at runtime with `__SL_SPOOF_SEED__`.
 *
 * Build/test-time only: this module imports `@pagescript` and must never be
 * reached from a runtime bundle.
 */

import { SELECTORS } from "@content/adapters/selectors";
import { hostOfMatchPattern } from "@content/site-detect";
import { SPOOF_PURPOSES } from "@core/constants/spoof";
import { TIMINGS } from "@core/constants/timings";
import { URLS } from "@core/constants/urls";
import { deriveToken } from "@core/spoof";
import { TOKENS } from "@design/tokens.generated";
import type { AnyPageProgram, EntryEnv } from "@pagescript";
import { chesscomBridge } from "./chesscom-bridge";
import { cursorProbe } from "./cursor-probe";
import { focusProbe } from "./focus-probe";
import { highlightOverlay } from "./highlight-overlay";
import { lichessBridge } from "./lichess-bridge";
import { verifyMoveProbe } from "./verify-move-probe";

/** Overlay fallback colours (the adapter sends the themed ones in every `draw`). */
export const OVERLAY_COLORS = {
	from: TOKENS.color.dark.hlFrom,
	to: TOKENS.color.dark.hlTo,
	arrow: TOKENS.color.dark.hlArrow,
} as const;

/** The two seed-derived direction tokens plus the overlay class (§13.3 rules 3, 5). */
export function bridgeTokens(env: EntryEnv): {
	token: string;
	peer: string;
	overlayClass: string;
} {
	return {
		token: deriveToken(env.seed, SPOOF_PURPOSES.pageToken),
		peer: deriveToken(env.seed, SPOOF_PURPOSES.contentToken),
		overlayClass: deriveToken(env.seed, SPOOF_PURPOSES.overlayClass),
	};
}

export const chesscomEntryArgs = (env: EntryEnv) => ({
	...bridgeTokens(env),
	boardTag: SELECTORS.chesscom.boardTag,
	boardSelectors: [...SELECTORS.chesscom.board],
	colors: OVERLAY_COLORS,
	retryMs: TIMINGS.bridgeRetryMs,
	retryMaxMs: TIMINGS.bridgeRetryMaxMs,
});

export const lichessEntryArgs = (env: EntryEnv) => ({
	...bridgeTokens(env),
	host: hostOfMatchPattern(URLS.lichessMatch) ?? "",
	hosts: [SELECTORS.lichess.container],
	colors: OVERLAY_COLORS,
	retryMs: TIMINGS.bridgeRetryMs,
	retryMaxMs: TIMINGS.bridgeRetryMaxMs,
	apiWaitMs: TIMINGS.bridgeApiWaitMs,
});

export const programs: readonly AnyPageProgram[] = [
	{ ...chesscomBridge, entryArgs: chesscomEntryArgs },
	{ ...lichessBridge, entryArgs: lichessEntryArgs },
	highlightOverlay,
	cursorProbe,
	focusProbe,
	verifyMoveProbe,
];
