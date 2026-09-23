/**
 * The engine options as applied, in application order — the order a restart replays them in.
 * `apply` is diffed: it sends only when the value differs, and a changed option moves to the
 * end of the replay order.
 */

import { formatSetOption } from "../options";
import type { EngineOptions, EngineOptionValue } from "../types";

export class AppliedOptions {
	private readonly applied = new Map<string, EngineOptionValue>();

	constructor(private readonly send: (line: string) => void) {}

	get(name: string): EngineOptionValue | undefined {
		return this.applied.get(name);
	}

	/** Diffed: sends only when `value` differs from the last applied value; records replay order. */
	apply(name: string, value: EngineOptionValue): void {
		if (this.applied.get(name) === value) return;
		this.applied.delete(name);
		this.applied.set(name, value);
		this.send(formatSetOption(name, value));
	}

	/** The options in `opts` that differ from what is applied (`undefined` values skipped). */
	changes(opts: Partial<EngineOptions>): Array<[string, EngineOptionValue]> {
		return Object.entries(opts).filter(
			(entry): entry is [string, EngineOptionValue] =>
				entry[1] !== undefined && this.applied.get(entry[0]) !== entry[1]
		);
	}

	/**
	 * Record `options` as applied without sending them — the next handshake replays them. An
	 * option already present keeps its place in the replay order.
	 */
	record(options: EngineOptions): void {
		for (const [name, value] of Object.entries(options)) this.applied.set(name, value);
	}

	/** Send every applied option in application order (a handshake's replay). */
	replay(): void {
		for (const [name, value] of this.applied) this.send(formatSetOption(name, value));
	}

	/**
	 * A request's strength: `elo` turns the Elo limiter on at that rating; no `elo` turns a
	 * limiter left on by an earlier request off again (full strength).
	 */
	applyStrength(elo: number | undefined): void {
		if (elo !== undefined) {
			this.apply("UCI_LimitStrength", true);
			this.apply("UCI_Elo", elo);
		} else if (this.applied.get("UCI_LimitStrength") === true) {
			this.apply("UCI_LimitStrength", false);
		}
	}
}
