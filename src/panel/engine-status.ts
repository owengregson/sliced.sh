/**
 * The engine status pill, projected from a snapshot — shared by the shell's top bar and the Engine
 * view. The two differ only in how an idle, ready engine reads: the top bar keeps it neutral
 * (`idle`), the Engine view marks it healthy (`ok`).
 */

import type { PanelSnapshot } from "@core/constants/messages";
import type { IconName } from "@design/icons";
import type { PillVariant } from "./components/pill";
import { COPY } from "./copy";

export interface EnginePillState {
	variant: PillVariant;
	text: string;
}

export function enginePill(snapshot: PanelSnapshot, readyVariant: "idle" | "ok"): EnginePillState {
	switch (snapshot.engine.state) {
		case "searching":
			return { variant: "thinking", text: COPY.engine.thinking(snapshot.recommendation?.depth ?? 0) };
		case "ready":
			return { variant: readyVariant, text: COPY.engine.idle };
		case "crashed":
			return { variant: "danger", text: COPY.engine.stopped };
		default:
			return { variant: "idle", text: COPY.engine.loading };
	}
}

/** The status icon a pill variant carries (a crashed engine shows the detached glyph). */
export function statusIcon(variant: PillVariant): IconName {
	switch (variant) {
		case "thinking":
			return "status.thinking";
		case "danger":
			return "status.detached";
		case "ok":
			return "status.ok";
		default:
			return "status.idle";
	}
}
