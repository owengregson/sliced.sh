import type { GamePortCommand } from "@core/constants/messages";

/**
 * Which tabs show the mirrored cursor, and a version per tab that every `cursorTo` /
 * `cursorHide` bumps — so cleanup from an older gesture can tell that a newer owner has drawn
 * since.
 */
export class PointerState {
	private readonly controlled = new Set<number>();
	private readonly versions = new Map<number, number>();
	private seq = 0;

	/** Record a command about to be posted to `tabId`. */
	note(tabId: number, cmd: GamePortCommand): void {
		if (cmd.kind === "cursorTo") this.controlled.add(tabId);
		else if (cmd.kind === "cursorHide") this.controlled.delete(tabId);
		if (cmd.kind === "cursorTo" || cmd.kind === "cursorHide") this.versions.set(tabId, ++this.seq);
	}

	version(tabId: number): number {
		return this.versions.get(tabId) ?? 0;
	}

	isControlled(tabId: number): boolean {
		return this.controlled.has(tabId);
	}

	forget(tabId: number): void {
		this.controlled.delete(tabId);
		this.versions.delete(tabId);
	}

	clear(): void {
		this.controlled.clear();
		this.versions.clear();
	}
}
