/**
 * The recommendation mark: highlights and arrows drawn — only when asked, the adapter never draws
 * on its own (§13.3) — through the bridge's page side, and the keys of what it drew so a later
 * clear can name them. No DOM insertion from this world.
 */

import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import type { HighlightStyle, Site, Square } from "@typedefs/game";
import { BRIDGE_KINDS, type PageBridge } from "../bridge-protocol";
import type { ArrowLine, DrawOptions } from "../contract";

const BRIDGE_CALL_TIMEOUT_MS = TIMINGS.adapterBridgeTimeoutMs;

export interface HighlightColors {
	hlFrom: string;
	hlTo: string;
	hlArrow: string;
	hlArrow2: string;
	hlArrow3: string;
}

export type SquareMark = { square: Square; color: string };
export type ArrowMark = { from: Square; to: Square; color: string };

export interface MarkingsHost {
	readonly site: Site;
	/** The bridge, only once its page side has answered ready. */
	readyBridge(): PageBridge | null;
	colors(): HighlightColors;
	/** The site's wire shape for a draw. */
	drawPayload(highlights: SquareMark[], arrows: ArrowMark[], options: DrawOptions): unknown;
	/** The site's wire shape for a clear (it may name `keys`). */
	clearPayload(): unknown;
}

export class Markings {
	/** Keys the page side reported for what it drew (and has not been told to clear). */
	keys: string[] = [];

	constructor(private readonly host: MarkingsHost) {}

	highlight(from: Square, to: Square, style: HighlightStyle, options: DrawOptions = {}): void {
		const colors = this.host.colors();
		const highlights =
			style === "arrows"
				? []
				: [
						{ square: from, color: colors.hlFrom },
						{ square: to, color: colors.hlTo },
					];
		const arrows = style === "squares" ? [] : [{ from, to, color: colors.hlArrow }];
		this.draw(highlights, arrows, options);
	}

	arrows(lines: ArrowLine[], options: DrawOptions = {}): void {
		const colors = this.host.colors();
		const palette = [colors.hlArrow, colors.hlArrow2, colors.hlArrow3];
		const ordered = [...lines].sort((a, b) => b.weight - a.weight);
		this.draw(
			[],
			ordered.map((l, i) => ({
				from: l.from,
				to: l.to,
				color: palette[Math.min(i, palette.length - 1)] ?? colors.hlArrow,
			})),
			options
		);
	}

	clear(): Promise<void> {
		const bridge = this.host.readyBridge();
		if (!bridge) return Promise.resolve();
		const payload = this.host.clearPayload();
		this.keys = [];
		return bridge
			.call(BRIDGE_KINDS.clear, payload, BRIDGE_CALL_TIMEOUT_MS)
			.then(() => undefined)
			.catch((e: unknown) => {
				log.debug("adapter.clear failed", this.host.site, e);
			});
	}

	private draw(highlights: SquareMark[], arrows: ArrowMark[], options: DrawOptions = {}): void {
		const bridge = this.host.readyBridge();
		if (!bridge) return; // no DOM insertion from the adapter (§13.3)
		// A forced-overlay draw removes our native markings on the page itself (one call, no
		// unmarked frame), so the keys it replaces are gone and this side must forget them too. A
		// later `clear` with no keys then means "everything of ours", which is self-healing if the
		// call above never arrived.
		if (options.forceOverlay === true) this.keys = [];
		bridge
			.call<{ keys?: string[] } | undefined>(
				BRIDGE_KINDS.draw,
				this.host.drawPayload(highlights, arrows, options),
				BRIDGE_CALL_TIMEOUT_MS
			)
			.then((res) => {
				if (res && Array.isArray(res.keys)) this.keys.push(...res.keys);
			})
			.catch((e: unknown) => {
				log.debug("adapter.draw failed", this.host.site, e);
			});
	}
}
