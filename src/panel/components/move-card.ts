/**
 * Move card (Appendix F §5.6, §6.2, §6.3, §7.4): header · SAN hero · from→to · note · plan line
 * (+ ring) · play button. States: your-move / opponent / thinking / disabled / engine-stopped;
 * transient new-move (SAN exits up, enters with the spring) and played (border flash). The
 * armed play button carries the countdown ("Auto-playing in 4.2s", tenths above 1 s) and an
 * `aria-label` updated per whole second.
 */

import { UI_TIMINGS } from "@core/constants/ui";
import { TOKENS } from "@design/tokens.generated";
import { sanToSpeech } from "../a11y";
import { ANIM } from "../animation-manager";
import { COPY } from "../copy";
import { registerEscape } from "../keys";
import { instantiate, part } from "../template";
import html from "../views/templates/components/move-card.html?raw";
import { type ButtonHandle, createButton } from "./button";
import { type CountdownRingHandle, createCountdownRing } from "./countdown-ring";

export type MoveCardState = "your-move" | "opponent" | "thinking" | "disabled" | "engine-stopped";

export interface MoveCardData {
	state: MoveCardState;
	/** "white" / "black" for the header. */
	color?: "w" | "b" | null;
	san?: string | null;
	/** "g1→f3" style from→to. */
	uci?: string | null;
	note?: string | null;
	/** Plan line text ("thinking 4.2s · drag") — visible only while armed. */
	plan?: { text: string; totalMs: number } | null;
	armed?: boolean;
	compact?: boolean;
	/** Keyboard hint shown on the play button (e.g. "Space"). */
	kbd?: string | null;
	/** Hands-off (§13.4): the play button shows its keybind only. */
	handsOff?: boolean;
}

export interface MoveCardOptions {
	onPlay?: () => void;
	onCancel?: () => void;
}

export interface MoveCardHandle {
	readonly el: HTMLElement;
	readonly button: ButtonHandle;
	readonly ring: CountdownRingHandle;
	update(data: MoveCardData): void;
	/** Drive the countdown (called by the view on its own tick). */
	countdown(remainingMs: number, totalMs: number): void;
	/** Execution has started ("Playing…"). */
	executing(): void;
	/** §6.3 "played": border flash. */
	played(): void;
	dispose(): void;
}

const MS = 1000;

/** Countdown label: tenths above 1 s, whole seconds below (§6.2). */
export function formatCountdown(remainingMs: number): string {
	const s = Math.max(0, remainingMs) / MS;
	return remainingMs > UI_TIMINGS.countdownTenthsAboveMs ? s.toFixed(1) : String(Math.ceil(s));
}

export function createMoveCard(
	host: HTMLElement | null,
	options: MoveCardOptions = {}
): MoveCardHandle {
	const el = instantiate(html);
	const header = part(el, ".sl-move__header");
	const san = part(el, ".sl-move__san");
	const uci = part(el, ".sl-move__uci");
	const note = part(el, ".sl-move__note");
	const plan = part(el, ".sl-move__plan");
	const planText = part(el, ".sl-move__plan-text");
	const planRingHost = part(el, ".sl-move__plan-ring");
	const live = part(el, ".sl-move__live");
	const actionHost = part(el, ".sl-move__action");
	const ring = createCountdownRing(planRingHost, { size: "sm" });
	let data: MoveCardData = { state: "thinking" };
	let counting = false;
	let hovering = false;
	let lastSpokenSecond = -1;
	let lastSan: string | null = null;
	let flashTimer: ReturnType<typeof setTimeout> | null = null;
	let unregisterEscape: (() => void) | null = null;

	const button = createButton(actionHost, {
		label: COPY.move.play,
		variant: "primary",
		size: "lg",
		block: true,
		icon: "action.play",
		onClick: () => {
			if (counting) options.onCancel?.();
			else options.onPlay?.();
		},
	});

	const onEnter = (): void => {
		hovering = true;
		if (counting) {
			button.update({ label: COPY.move.cancel, icon: "action.cancel" });
			button.ring.pause();
			ring.pause();
		}
	};
	const onLeave = (): void => {
		hovering = false;
		if (counting) {
			button.update({ icon: "action.play" });
			button.ring.resume();
			ring.resume();
		}
	};
	button.el.addEventListener("pointerenter", onEnter);
	button.el.addEventListener("pointerleave", onLeave);

	function stopCounting(): void {
		counting = false;
		lastSpokenSecond = -1;
		unregisterEscape?.();
		unregisterEscape = null;
		button.ring.resume();
		ring.resume();
	}

	function renderButton(): void {
		const armed = data.armed === true && data.state === "your-move";
		if (!armed) stopCounting();
		button.update({
			armed,
			kbd: data.kbd ?? null,
			disabled: data.handsOff === true || data.state !== "your-move",
			icon: counting && hovering ? "action.cancel" : "action.play",
			// A running countdown owns the label and the spoken aria-label (§6.2).
			...(counting
				? {}
				: { label: data.compact ? COPY.move.playShort : COPY.move.play, ariaLabel: null }),
		});
	}

	function update(next: MoveCardData): void {
		const prev = data;
		data = next;
		el.dataset.state = next.state;
		el.classList.toggle("sl-move--compact", next.compact === true);
		el.classList.toggle("sl-move--armed", next.armed === true && next.state === "your-move");
		el.classList.toggle("sl-move--disabled", next.state === "disabled");
		el.classList.toggle("sl-move--opponent", next.state === "opponent");
		el.classList.toggle("sl-move--thinking", next.state === "thinking");
		header.textContent =
			next.state === "disabled"
				? COPY.move.disabled
				: next.state === "engine-stopped"
					? COPY.move.engineStopped
					: next.state === "thinking"
						? COPY.move.thinking
						: next.state === "opponent"
							? COPY.move.headerTheirs
							: COPY.move.headerYours(next.color === "b" ? COPY.move.black : COPY.move.white);
		const showSan = next.state !== "thinking" && next.state !== "engine-stopped" && next.san;
		const sanText = showSan ? (next.san ?? "") : "";
		if (sanText !== (san.textContent ?? "")) {
			if (lastSan && sanText && prev.state !== "thinking") {
				void ANIM.exitUp(san).then(() => {
					san.textContent = sanText;
					void ANIM.spring(san);
				});
			} else san.textContent = sanText;
		}
		lastSan = sanText || null;
		uci.textContent = showSan ? (next.uci ?? "") : "";
		note.textContent = next.note ?? "";
		note.hidden = !next.note;
		const planVisible = next.armed === true && next.state === "your-move" && Boolean(next.plan);
		plan.hidden = !planVisible;
		planText.textContent = next.plan?.text ?? "";
		if (showSan && next.san && next.state === "your-move")
			live.textContent = COPY.move.ariaRecommended(sanToSpeech(next.san), next.uci ?? "");
		else live.textContent = "";
		renderButton();
	}

	function countdown(remainingMs: number, totalMs: number): void {
		if (!(data.armed && data.state === "your-move")) return;
		if (!counting) {
			counting = true;
			unregisterEscape = registerEscape("countdown", () => options.onCancel?.());
		}
		ring.update(remainingMs, totalMs);
		button.ring.update(remainingMs, totalMs);
		const seconds = Math.ceil(Math.max(0, remainingMs) / MS);
		if (!hovering) button.update({ label: COPY.move.armed(formatCountdown(remainingMs)) });
		if (seconds !== lastSpokenSecond) {
			lastSpokenSecond = seconds;
			button.update({ ariaLabel: COPY.move.ariaArmed(sanToSpeech(data.san ?? ""), seconds) });
		}
	}

	host?.append(el);
	update(data);

	return {
		el,
		button,
		ring,
		update,
		countdown,
		executing() {
			stopCounting();
			button.update({ loading: COPY.move.executing, icon: null, ariaLabel: null });
		},
		played() {
			stopCounting();
			button.update({ loading: null });
			el.classList.add("sl-move--played");
			if (flashTimer !== null) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => {
				el.classList.remove("sl-move--played");
				flashTimer = null;
			}, TOKENS.motion.durationMs[4]);
		},
		dispose() {
			stopCounting();
			if (flashTimer !== null) clearTimeout(flashTimer);
			button.el.removeEventListener("pointerenter", onEnter);
			button.el.removeEventListener("pointerleave", onLeave);
			button.dispose();
			ring.dispose();
			el.remove();
		},
	};
}
