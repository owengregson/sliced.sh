/**
 * The update banner: shown once an update is available and the full-screen interrupt was
 * dismissed, never during a live game (the extension reload is deferred until it ends), and
 * suspended while hands-off.
 */

import type { PanelSnapshot } from "@core/constants/messages";
import { type BannerHandle, showBanner } from "../components/banner";
import { COPY } from "../copy";
import { isLiveGame } from "../router";
import type { PanelUiState } from "../view";

export interface UpdateBannerDeps {
	ui: Readonly<PanelUiState>;
	snapshot(): PanelSnapshot | null;
	version: string;
	onUpdate?: (() => void) | undefined;
}

export interface UpdateBanner {
	/** Show or hide the banner to match the UI state and the snapshot. */
	apply(): void;
	/** Take the banner down regardless (hands-off outranks it); `apply` may bring it back. */
	suspend(): void;
}

export function createUpdateBanner(deps: UpdateBannerDeps): UpdateBanner {
	let banner: BannerHandle | null = null;
	const live = (): boolean => {
		const snapshot = deps.snapshot();
		return snapshot !== null && isLiveGame(snapshot);
	};
	return {
		apply() {
			const { ui } = deps;
			const wanted = ui.updateAvailable && ui.updateDismissed && !live();
			if (wanted && !banner) {
				banner = showBanner(
					"info",
					COPY.banner.update(deps.version),
					[
						{
							label: COPY.banner.updateAction,
							onClick: () => {
								if (live()) return; // Defer extension reload until the game ends.
								deps.onUpdate?.();
							},
							keepOpen: true,
						},
					],
					{ key: "update" }
				);
			} else if (!wanted && banner) {
				banner.dismiss();
				banner = null;
			}
		},
		suspend() {
			banner?.dismiss();
			banner = null;
		},
	};
}
