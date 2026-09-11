/** Capture physical page input while preserving the separately admitted browser pointer stream. */
import { POINTER_CONTROL, type PreparedPointer } from "@core/constants/cdp";

export const POINTER_EVENT_TYPES = [
	"pointermove",
	"pointerdown",
	"pointerup",
	"pointerover",
	"pointerout",
	"pointerenter",
	"pointerleave",
	"pointercancel",
	"gotpointercapture",
	"lostpointercapture",
	"mousemove",
	"mousedown",
	"mouseup",
	"mouseover",
	"mouseout",
	"mouseenter",
	"mouseleave",
	"click",
	"dblclick",
	"auxclick",
	"contextmenu",
	"wheel",
] as const;

const BOUNDARIES = new Set([
	"pointerover",
	"pointerout",
	"pointerenter",
	"pointerleave",
	"mouseover",
	"mouseout",
	"mouseenter",
	"mouseleave",
	"gotpointercapture",
	"lostpointercapture",
]);
const MAIN_TYPES = {
	mouseMoved: ["pointermove", "mousemove"],
	mousePressed: ["pointerdown", "mousedown"],
	mouseReleased: ["pointerup", "mouseup", "click"],
} as const;

export interface PointerControl {
	setActive(active: boolean): void;
	prepare(pointer: PreparedPointer): void;
	delivered(pointer: PreparedPointer): boolean;
	/** true means an admitted virtual event; physical events are stopped while active. */
	filter(event: Event): boolean;
}

export function createPointerControl(win: Window, now: () => number): PointerControl {
	let active = false;
	let prepared: PreparedPointer | null = null;
	let expiresAt = 0;
	let preparedEventAt = 0;
	let remaining = new Map<string, number>();

	return {
		setActive(value) {
			active = value;
			if (!value) {
				prepared = null;
				remaining.clear();
			}
		},
		prepare(pointer) {
			prepared = { ...pointer };
			const wallNow = now();
			expiresAt = wallNow + POINTER_CONTROL.expiresMs;
			// CDP maps epoch timestamps onto Chrome's monotonic event clock. Rebase
			// each admission: timeOrigin + timeStamp can drift after sleep/clock sync.
			preparedEventAt = win.performance.now() + pointer.timestampMs - wallNow;
			remaining = new Map(MAIN_TYPES[pointer.type].map((type) => [type, 1]));
			for (const type of BOUNDARIES) remaining.set(type, POINTER_CONTROL.boundaryEventsPerType);
		},
		delivered(pointer) {
			return (
				prepared?.timestampMs === pointer.timestampMs &&
				prepared.type === pointer.type &&
				MAIN_TYPES[pointer.type].some((type) => remaining.get(type) === 0)
			);
		},
		filter(event) {
			const mouse = event as MouseEvent;
			// Keyboard and accessibility activation has no pointing device; keep page shortcuts usable.
			if (
				event.isTrusted &&
				event.type === "click" &&
				mouse.detail === 0 &&
				!(event as PointerEvent).pointerType
			)
				return false;
			const count = remaining.get(event.type) ?? 0;
			if (
				event.isTrusted &&
				prepared &&
				now() <= expiresAt &&
				count > 0 &&
				Math.abs(mouse.clientX - prepared.x) <= POINTER_CONTROL.coordinateTolerancePx &&
				Math.abs(mouse.clientY - prepared.y) <= POINTER_CONTROL.coordinateTolerancePx &&
				mouse.buttons === prepared.buttons &&
				(prepared.type === "mouseMoved" || BOUNDARIES.has(event.type) || mouse.button === 0) &&
				Math.abs(event.timeStamp - preparedEventAt) <= POINTER_CONTROL.timestampToleranceMs
			) {
				remaining.set(event.type, count - 1);
				return true;
			}
			// Delivery accounting also applies before the first mirrored point and
			// when its display is off. Only unmatched input depends on isolation.
			if (!active) return false;
			event.preventDefault();
			event.stopImmediatePropagation();
			return false;
		},
	};
}
