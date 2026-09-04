// test/fakes/stockfish.ts
/**
 * A scripted `StockfishWeb` (the `@lichess-org/stockfish-web` module surface)
 * for the offscreen host tests: records `uci` commands and `setNnueBuffer`
 * calls, answers `getRecommendedNnue` from a list, and lets a test emit output
 * lines (`emit`) or a stderr message (`fail`).
 */

import { LIMITS } from "@core/constants/limits";
import type StockfishWeb from "@lichess-org/stockfish-web";

export class FakeStockfishWeb implements StockfishWeb {
	readonly commands: string[] = [];
	readonly nets: Array<{ bytes: Uint8Array; index: number }> = [];
	listen: (data: string) => void = () => {};
	onError: (msg: string) => void = () => {};

	constructor(readonly recommended: readonly string[] = [LIMITS.nnueSmallName]) {}

	uci(command: string): void {
		this.commands.push(command);
	}

	setNnueBuffer(data: Uint8Array, index = 0): void {
		this.nets.push({ bytes: data, index });
	}

	getRecommendedNnue(index = 0): string | undefined {
		return this.recommended[index];
	}

	/** Engine output, as `listen` would deliver it. */
	emit(...lines: string[]): void {
		for (const line of lines) this.listen(line);
	}

	/** Engine stderr, as `onError` would deliver it. */
	fail(msg: string): void {
		this.onError(msg);
	}
}
