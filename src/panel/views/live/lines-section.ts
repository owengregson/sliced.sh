/**
 * Lines section (Appendix F §4.4 item 6, §5.7): header with a count chip that opens the 1–5
 * stepper (`display.pvCount` via `setSettings`), and the PV rows. Row count = the setting,
 * capped by the collapse state (§8.2 step 2) and by 2 at the compact breakpoint (§4.5).
 * Hover previews the line's first move on the board (`PANEL_PREVIEW_LINE {tabId, multipv}`,
 * `null` on leave); click pins the preview until another click or the position changes.
 * Scores come from the side to move and are shown from White's point of view.
 */

import { sideToMove } from "@core/chess/fen";
import type { PanelSnapshot } from "@core/constants/messages";
import { toWhitePov } from "@core/engine/snapshot";
import { log } from "@core/logger";
import { setSettings } from "@core/storage/settings-storage";
import type { EvalLine } from "@typedefs/engine";
import type { Color } from "@typedefs/game";
import { type ChipGroupHandle, createChipGroup } from "../../components/chip";
import { openPopover, type PopoverHandle } from "../../components/popover";
import { createPvList, type PvListHandle } from "../../components/pv-list";
import { COPY, COPY_LIVE } from "../../copy";
import { part } from "../../template";

/** §8.1: compact shows at most two rows. */
const COMPACT_PV_MAX = 2;
const PV_COUNT_MIN = 1;
const PV_COUNT_MAX = 5;

export interface LinesSectionOptions {
	root: HTMLElement;
	onPreview: (multipv: number | null) => void;
}

export interface LinesSectionState {
	snapshot: PanelSnapshot;
	/** From the collapse state (`pvMax`). */
	pvMax: number;
	compact: boolean;
	showDepth: boolean;
	handsOff: boolean;
}

export interface LinesSectionHandle {
	readonly list: PvListHandle;
	update(state: LinesSectionState): void;
	dispose(): void;
}

/** Lines from the recommendation, scores flipped to White's point of view. */
export function whiteLines(rec: PanelSnapshot["recommendation"]): EvalLine[] {
	if (!rec) return [];
	const stm: Color = sideToMove(rec.fen) ?? "w";
	return rec.lines.map((line) => ({ ...line, score: toWhitePov(line.score, stm) }));
}

export function createLinesSection(options: LinesSectionOptions): LinesSectionHandle {
	const { root } = options;
	part(root, ".sl-live__lines-title").textContent = COPY.lines.header;
	const count = part<HTMLButtonElement>(root, ".sl-live__count");
	count.setAttribute("aria-label", COPY_LIVE.lines.countLabel);
	let handsOff = false;
	let pinned: number | null = null;
	let fen: string | null = null;
	let popover: PopoverHandle | null = null;
	let chips: ChipGroupHandle<string> | null = null;

	const list = createPvList(part(root, ".sl-live__pv"), {
		onHover: (multipv) => {
			if (handsOff) return;
			// A pinned row owns the preview; hovering elsewhere does not disturb it.
			if (pinned !== null) return;
			options.onPreview(multipv);
		},
		onPin: (multipv) => {
			if (handsOff) return;
			pinned = multipv;
			options.onPreview(multipv);
		},
	});

	function closeStepper(): void {
		popover?.close();
		popover = null;
		chips?.dispose();
		chips = null;
	}

	const onCount = (event: MouseEvent): void => {
		event.preventDefault();
		if (handsOff) return;
		if (popover?.open) {
			closeStepper();
			return;
		}
		const host = document.createElement("div");
		const current = count.dataset.count ?? "";
		chips = createChipGroup<string>(host, {
			items: Array.from({ length: PV_COUNT_MAX - PV_COUNT_MIN + 1 }, (_, i) => {
				const n = PV_COUNT_MIN + i;
				return { id: String(n), label: COPY_LIVE.lines.count(n) };
			}),
			value: current,
			onChange: (value) => {
				if (value === null) return;
				setSettings({ display: { pvCount: Number(value) } }).catch((error: unknown) =>
					log.warn("live: pvCount write failed", error)
				);
				closeStepper();
			},
		});
		popover = openPopover(count, host, {
			title: COPY.lines.header,
			onClose: () => {
				chips?.dispose();
				chips = null;
				popover = null;
			},
		});
	};
	count.addEventListener("click", onCount);

	function update(state: LinesSectionState): void {
		handsOff = state.handsOff;
		const snap = state.snapshot;
		const setting = Math.min(PV_COUNT_MAX, Math.max(PV_COUNT_MIN, snap.settings.display.pvCount));
		count.textContent = COPY_LIVE.lines.count(setting);
		count.dataset.count = String(setting);
		const max = Math.min(setting, state.pvMax, state.compact ? COMPACT_PV_MAX : PV_COUNT_MAX);
		const rec = snap.recommendation;
		// The position changed: the pin is released (§4.4 item 6).
		const nextFen = rec?.fen ?? null;
		if (nextFen !== fen) {
			fen = nextFen;
			if (pinned !== null) {
				pinned = null;
				options.onPreview(null);
			}
		}
		list.update({
			lines: whiteLines(rec),
			max,
			showDepth: state.showDepth,
			stale: snap.engine.state !== "searching" && snap.engine.state !== "ready",
		});
		if (pinned !== null && list.pinned !== pinned) {
			pinned = null;
			options.onPreview(null);
		}
		if (handsOff) closeStepper();
	}

	return {
		list,
		update,
		dispose() {
			closeStepper();
			count.removeEventListener("click", onCount);
			list.dispose();
		},
	};
}
