/**
 * The detached banner (§4.4, §9.7): once the debugger has been attached this game (or the hand
 * reports it detached) and it is detached now, offer Reattach / Dismiss. Reattaching clears as
 * soon as a snapshot says the debugger is back; a dismissal lasts until then.
 */

import type { PanelSnapshot } from "@core/constants/messages";
import { type BannerHandle, showBanner } from "../../components/banner";
import { COPY } from "../../copy";

export interface DetachedBanner {
	apply(snapshot: PanelSnapshot, state: { wasAttached: boolean; handsOff: boolean }): void;
	dispose(): void;
}

export function createDetachedBanner(onReattach: () => void): DetachedBanner {
	let dismissed = false;
	let banner: BannerHandle | null = null;
	return {
		apply(snap, { wasAttached, handsOff }) {
			if (snap.executor.debuggerAttached) {
				dismissed = false;
				banner?.dismiss();
				banner = null;
				return;
			}
			const detached = wasAttached || snap.session.hand === "detached";
			const wanted = detached && !handsOff && !dismissed;
			if (wanted && !banner) {
				banner = showBanner(
					"warn",
					COPY.banner.detached,
					[
						{
							label: COPY.banner.reattach,
							onClick: () => {
								dismissed = true;
								onReattach();
							},
						},
						{
							label: COPY.banner.dismiss,
							onClick: () => {
								dismissed = true;
							},
						},
					],
					{ key: "detached" }
				);
			} else if (!wanted && banner) {
				banner.dismiss();
				banner = null;
			}
		},
		dispose() {
			banner?.dismiss();
			banner = null;
		},
	};
}
