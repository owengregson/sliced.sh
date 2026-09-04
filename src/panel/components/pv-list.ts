/**
 * PV line rows (Appendix F §5.7): stripe (colour by index) · score (mono, 6ch) · moves (mono,
 * right-edge fade) · depth (≥420 px). Row height `control.sm`. Hover previews the line on the
 * board; click pins (`aria-pressed`). Empty → "No lines yet".
 */

import type { EvalLine } from "@typedefs/engine";
import { COPY } from "../copy";
import { instantiate, part } from "../template";
import html from "../views/templates/components/pv-list.html?raw";
import rowHtml from "../views/templates/components/pv-row.html?raw";
import { formatScore } from "./eval-bar";

export interface PvListOptions {
	/** Rows shown (1–5); the caller collapses per §8.2. */
	max?: number;
	onHover?: (multipv: number | null) => void;
	onPin?: (multipv: number | null) => void;
}

export interface PvListState {
	/** Lines with scores from White's point of view. */
	lines: EvalLine[];
	stale?: boolean;
	max?: number;
	showDepth?: boolean;
}

export interface PvListHandle {
	readonly el: HTMLElement;
	readonly pinned: number | null;
	update(state: PvListState): void;
	dispose(): void;
}

const DEFAULT_MAX = 3;
const MAX_ROWS = 5;

export function createPvList(host: HTMLElement | null, options: PvListOptions = {}): PvListHandle {
	const el = instantiate(html);
	const rows = part(el, ".sl-pv-list__rows");
	const empty = part(el, ".sl-pv-list__empty");
	empty.textContent = COPY.lines.empty;
	let max = Math.min(MAX_ROWS, options.max ?? DEFAULT_MAX);
	let pinned: number | null = null;
	let hovered: number | null = null;

	const rowOf = (target: EventTarget | null): HTMLElement | null =>
		(target as Element | null)?.closest<HTMLElement>(".sl-pv") ?? null;

	const onOver = (event: Event): void => {
		const row = rowOf(event.target);
		if (!row) return;
		const n = Number(row.dataset.multipv);
		if (hovered === n) return;
		hovered = n;
		options.onHover?.(n);
	};
	const onOut = (event: Event): void => {
		const row = rowOf(event.target);
		if (!row) return;
		hovered = null;
		options.onHover?.(null);
	};
	const onClick = (event: MouseEvent): void => {
		const row = rowOf(event.target);
		if (!row) return;
		event.preventDefault();
		const n = Number(row.dataset.multipv);
		pinned = pinned === n ? null : n;
		renderPins();
		options.onPin?.(pinned);
	};
	rows.addEventListener("pointerover", onOver);
	rows.addEventListener("pointerout", onOut);
	rows.addEventListener("click", onClick);

	function renderPins(): void {
		for (const row of rows.querySelectorAll<HTMLElement>(".sl-pv")) {
			const on = Number(row.dataset.multipv) === pinned;
			row.setAttribute("aria-pressed", on ? "true" : "false");
			row.classList.toggle("is-pinned", on);
		}
	}

	function update(state: PvListState): void {
		if (state.max !== undefined) max = Math.min(MAX_ROWS, Math.max(1, state.max));
		const lines = [...state.lines].sort((a, b) => a.multipv - b.multipv).slice(0, max);
		rows.replaceChildren();
		for (const line of lines) {
			const row = instantiate<HTMLButtonElement>(rowHtml);
			row.dataset.multipv = String(line.multipv);
			row.dataset.index = String(Math.min(line.multipv, MAX_ROWS));
			part(row, ".sl-pv__score").textContent = formatScore(line.score);
			part(row, ".sl-pv__moves").textContent = line.pvSan.join(" ");
			const depth = part(row, ".sl-pv__depth");
			depth.textContent = COPY.lines.depth(line.depth);
			depth.hidden = state.showDepth === false;
			row.setAttribute(
				"aria-label",
				`${formatScore(line.score)} ${line.pvSan.join(" ")} ${COPY.lines.depth(line.depth)}`
			);
			rows.append(row);
		}
		if (pinned !== null && !lines.some((l) => l.multipv === pinned)) pinned = null;
		renderPins();
		el.classList.toggle("sl-pv-list--stale", state.stale === true);
		empty.hidden = lines.length > 0;
	}

	update({ lines: [] });
	host?.append(el);
	return {
		el,
		get pinned() {
			return pinned;
		},
		update,
		dispose() {
			rows.removeEventListener("pointerover", onOver);
			rows.removeEventListener("pointerout", onOut);
			rows.removeEventListener("click", onClick);
			el.remove();
		},
	};
}
