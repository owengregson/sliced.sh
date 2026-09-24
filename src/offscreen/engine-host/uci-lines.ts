// src/offscreen/engine-host/uci-lines.ts
/** Reading the engine's UCI traffic: the few facts the host takes from lines it relays. */

import type StockfishWeb from "@lichess-org/stockfish-web";

const MULTIPV_RE = /\bmultipv (\d+)/;
const NPS_RE = /\bnps (\d+)/;
const THREADS_OPTION_RE = /^setoption name Threads value (\d+)\s*$/;
const ID_NAME_PREFIX = "id name ";
/** stderr prefix the engine wrapper uses for a rejected network: evict the cached copy. */
const BAD_NNUE_PREFIX = "BAD_NNUE";
const NOOP = (): void => {};

/** The thread count a `setoption name Threads value N` command sets, else `undefined`. */
export function threadsOption(line: string): number | undefined {
	const threads = THREADS_OPTION_RE.exec(line);
	return threads ? Number(threads[1]) : undefined;
}

/** The `multipv` index an `info` line reports (1 when it names none). */
export function multipvOf(line: string): number {
	const multipv = MULTIPV_RE.exec(line);
	return multipv ? Number(multipv[1]) : 1;
}

/** The `nps` an `info` line reports, else `undefined`. */
export function npsOf(line: string): number | undefined {
	const nps = NPS_RE.exec(line);
	return nps ? Number(nps[1]) : undefined;
}

/** The engine's `id name`, else `undefined`. */
export function idName(line: string): string | undefined {
	return line.startsWith(ID_NAME_PREFIX) ? line.slice(ID_NAME_PREFIX.length).trim() : undefined;
}

/** True for the stderr message of a network the engine rejected. */
export function isBadNnue(message: string): boolean {
	return message.startsWith(BAD_NNUE_PREFIX);
}

/** Detach and ask the instance to exit (the pthread worker terminates on `quit`). */
export function quit(sf: StockfishWeb): void {
	sf.listen = NOOP;
	sf.onError = NOOP;
	try {
		sf.uci("quit");
	} catch {
		// already gone
	}
}
