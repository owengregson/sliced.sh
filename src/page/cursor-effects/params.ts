// src/page/cursor-effects/params.ts
/** The feedback layer's public routine names and bind-time inputs. */

import type { Expression } from "@pagescript";

export const CURSOR_FEEDBACK = { update: "curFxUpdate", clear: "curFxClear" } as const;

export interface CursorEffectParams {
	cls: Expression;
	accent: Expression;
	zIndex: number;
	sizePx: number;
	hotX: number;
	hotY: number;
}
