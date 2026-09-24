/**
 * Native page focus/visibility emulation per attached tab (`CDP.focusEmulation`). An arm intent
 * reserves a number first, so asynchronous attach/cleanup work that a newer intent overtook can
 * tell it is stale; updates for one tab are serialised so a late disable cannot undo a newer
 * activation. A tab counts as focus-maintained only after Chrome acknowledged the command.
 */

import { CDP } from "@core/constants/cdp";

export interface FocusEmulationHost {
	isAttached(tabId: number): boolean;
	send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export class FocusEmulation {
	private readonly focused = new Set<number>();
	private readonly updates = new Map<number, Promise<void>>();
	private readonly reservations = new Map<number, number>();
	private nextReservation = 0;

	constructor(private readonly host: FocusEmulationHost) {}

	/** Acknowledged by Chrome (the caller also checks the tab is still attached). */
	isFocused(tabId: number): boolean {
		return this.focused.has(tabId);
	}

	reserve(tabId: number): number {
		const reservation = ++this.nextReservation;
		this.reservations.set(tabId, reservation);
		return reservation;
	}

	hasReservation(tabId: number, reservation: number): boolean {
		return this.reservations.get(tabId) === reservation;
	}

	set(tabId: number, enabled: boolean, reservation?: number): Promise<void> {
		const prior = this.updates.get(tabId) ?? Promise.resolve();
		const next = prior
			.catch(() => {})
			.then(async () => {
				if (reservation !== undefined && !this.hasReservation(tabId, reservation)) return;
				if (!this.host.isAttached(tabId)) {
					this.focused.delete(tabId);
					return;
				}
				await this.host.send(tabId, CDP.focusEmulation, { enabled });
				if (reservation !== undefined && !this.hasReservation(tabId, reservation)) return;
				if (enabled && this.host.isAttached(tabId)) this.focused.add(tabId);
				else this.focused.delete(tabId);
			});
		this.updates.set(tabId, next);
		void next
			.finally(() => {
				if (this.updates.get(tabId) === next) this.updates.delete(tabId);
			})
			.catch(() => {});
		return next;
	}

	/** The tab detached: its emulation and its reservation are gone with it. */
	forget(tabId: number): void {
		this.focused.delete(tabId);
		this.reservations.delete(tabId);
	}

	clear(): void {
		this.focused.clear();
		this.reservations.clear();
	}
}
