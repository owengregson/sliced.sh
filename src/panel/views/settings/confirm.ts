/** The destructive-action confirm popover (sign out, reset all): Cancel, then the danger action. */

import { createButton } from "../../components/button";
import { openPopover, type PopoverHandle } from "../../components/popover";
import { COPY } from "../../copy";
import { instantiate, part } from "../../template";
import confirmHtml from "../templates/settings/confirm.html?raw";

export type Confirm = (
	anchor: HTMLElement,
	text: string,
	confirmLabel: string,
	onConfirm: () => void
) => void;

/** A confirm that refuses to open while `locked()` (a confirm must not act mid-game, §13.4). */
export function createConfirm(locked: () => boolean): Confirm {
	return (anchor, text, confirmLabel, onConfirm) => {
		if (locked()) return;
		const el = instantiate(confirmHtml);
		part(el, ".sl-settings-confirm__text").textContent = text;
		const actions = part(el, ".sl-settings-confirm__actions");
		let handle: PopoverHandle | null = null;
		const cancel = createButton(actions, {
			label: COPY.account.cancel,
			variant: "ghost",
			size: "sm",
			onClick: () => handle?.close(),
		});
		cancel.el.classList.add("sl-settings-confirm__cancel");
		const ok = createButton(actions, {
			label: confirmLabel,
			variant: "danger",
			size: "sm",
			onClick: () => {
				handle?.close();
				onConfirm();
			},
		});
		ok.el.classList.add("sl-settings-confirm__confirm");
		handle = openPopover(anchor, el, {
			onClose: () => {
				cancel.dispose();
				ok.dispose();
			},
		});
	};
}
