// src/page/effects-overlay/names.ts
/** The board-effect layer's public routine names and bind-time inputs. */

import type { Expression } from "@pagescript";

export const EFFECTS = {
	draw: "efDraw",
	clear: "efClear",
} as const;

export interface EffectsParams {
	/** Selector ladder (json array) locating the host element. */
	hosts: Expression;
	/** The per-build class name of the layer's `<svg>`. */
	cls: Expression;
	/** `{ mine, theirs, edge }` — one colour per side, and the arrow shadow's tint. */
	palette: Expression;
	/** `BOARD_EFFECT_STYLES` as a json table, keyed by the wire letter. */
	styles: Expression;
	/** `MOVE_QUALITY_ICONS` as a json array, indexed by the wire index. */
	icons: Expression;
}
