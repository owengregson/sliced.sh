/**
 * tools/lib/engine/uci.ts — the UCI plumbing every tool-side Stockfish runner shares: the output
 * lines fanned out to whoever waits on them, and the `position` / `go` commands of a search.
 */

import type { UciScore } from "@core/engine/uci-parser";
import type { EvalLine } from "@typedefs/engine";

export type LineListener = (line: string) => void;

/**
 * The engine's output lines, handed to every current listener. It behaves as the `Set` of
 * listeners the runners used to hold (`add` / `delete`), plus `waitFor`.
 */
export class LineHub {
	private readonly listeners = new Set<LineListener>();

	/** Every line to the listeners present when it arrived (one may remove itself meanwhile). */
	readonly dispatch = (line: string): void => {
		for (const listener of [...this.listeners]) listener(line);
	};

	add(listener: LineListener): void {
		this.listeners.add(listener);
	}

	delete(listener: LineListener): void {
		this.listeners.delete(listener);
	}

	/** The first line `predicate` accepts; rejects with `timeoutError()` after `timeoutMs`. */
	waitFor(
		predicate: (line: string) => boolean,
		timeoutMs: number,
		timeoutError: () => Error
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(timeoutError());
			}, timeoutMs);
			const listener = (line: string): void => {
				if (!predicate(line)) return;
				clearTimeout(timer);
				this.listeners.delete(listener);
				resolve(line);
			};
			this.listeners.add(listener);
		});
	}
}

/** A parsed UCI score as an `EvalLine` score (`mate` or `cp`, from the mover's side). */
export function evalScoreOf(score: UciScore): EvalLine["score"] {
	return score.type === "mate" ? { mate: score.value } : { cp: score.value };
}

/** `position fen <fen>[ moves …]` — the moves are applied so repetitions are seen. */
export function positionCommand(fen: string, moves?: readonly string[]): string {
	return `position fen ${fen}${moves?.length ? ` moves ${moves.join(" ")}` : ""}`;
}

/** `go movetime <ms>[ depth <d>][ searchmoves …]`, the depth whenever one is given. */
export function goCommand(limit: {
	movetimeMs: number;
	depth?: number;
	searchmoves?: readonly string[];
}): string {
	const parts = [`go movetime ${limit.movetimeMs}`];
	if (limit.depth !== undefined) parts.push(`depth ${limit.depth}`);
	if (limit.searchmoves?.length) parts.push(`searchmoves ${limit.searchmoves.join(" ")}`);
	return parts.join(" ");
}
