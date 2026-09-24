/**
 * A keybind row: captures a new key, and on a conflict with another action offers the swap
 * (Enter) — both bindings are written at once and the `onChange` that follows does not write again.
 */

import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import type { Keybind } from "@typedefs/settings";
import { createKeybindCapture, formatKeybind } from "../../components/keybind";
import { showToast } from "../../components/toast";
import { COPY } from "../../copy";
import type { RowControl, RowHost, RowShell } from "./row-control";
import type { KeybindAction, RowSpec } from "./rows";

const KEYBIND_ACTIONS: readonly KeybindAction[] = [
	"playMove",
	"toggleAutoMove",
	"disable",
	"speakMove",
];

function sameKeybind(a: Keybind, b: Keybind): boolean {
	return (
		a.key === b.key &&
		a.altKey === b.altKey &&
		a.ctrlKey === b.ctrlKey &&
		a.metaKey === b.metaKey &&
		a.shiftKey === b.shiftKey
	);
}

export function buildKeybind(
	spec: Extract<RowSpec, { kind: "keybind" }>,
	row: RowShell,
	host: RowHost
): RowControl {
	row.el.classList.add("sl-settings-row--keybind");
	const label = COPY.keybind.actions[spec.action];
	const otherActions = KEYBIND_ACTIONS.filter((a) => a !== spec.action);
	/** `onSwap` writes both bindings; the `onChange` that follows it must not write again. */
	let swapped = false;
	/** The action found by the last `conflicts` check — `onSwap` uses it, not the label. */
	let conflictAction: KeybindAction | null = null;
	const handle = createKeybindCapture(row.control, {
		label,
		value: host.settings().keybinds[spec.action],
		global: host.settings().keybinds.global,
		conflicts: (kb) => {
			conflictAction = otherActions.find((a) => sameKeybind(host.settings().keybinds[a], kb)) ?? null;
			return conflictAction ? COPY.keybind.actions[conflictAction] : null;
		},
		onSwap: (kb) => {
			const other = conflictAction;
			conflictAction = null;
			if (!other) return;
			swapped = true;
			host.write({
				keybinds: { [spec.action]: kb, [other]: host.settings().keybinds[spec.action] },
			});
		},
		onChange: (kb) => {
			if (kb) showToast("success", COPY.toast.keybind(label, formatKeybind(kb)));
			if (swapped) {
				swapped = false;
				return;
			}
			host.write({ keybinds: { [spec.action]: kb ?? DEFAULT_SETTINGS.keybinds[spec.action] } });
		},
	});
	return {
		el: row.el,
		setValue: (s) => handle.update({ value: s.keybinds[spec.action], global: s.keybinds.global }),
		setDisabled: (d) => handle.update({ disabled: d }),
		dispose: () => handle.dispose(),
	};
}
