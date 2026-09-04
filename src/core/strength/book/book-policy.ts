/**
 * Opening-book policy (Task 15, §7.3, Appendix E §2.3): while `ply ≤ 30` and
 * `Settings.strength.useOpeningBook`, try the Lichess explorer, then the
 * bundled Polyglot book for the rating band (`gm2600` from E ≥ 1800, `club`
 * below), else `null` so §7.2 engine selection takes over. From E ≥ 1800 a
 * book move that loses ≥ 0.15 win-fraction against the engine's best line is
 * refused (the "known trap" check); the engine lines are optional input.
 */

import { legalMoves, parseUci, uciToSan } from "@core/chess/san";
import { runtimeGetURL } from "@core/chrome/runtime";
import { BOOKS, type BookName, EXPLORER } from "@core/constants/books";
import { log } from "@core/logger";
import type { Rng } from "@core/rng";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove, TimeControl } from "@typedefs/game";
import { cpEffective, winProb } from "../elo-map";
import {
	type ExplorerQuery,
	gamesOf,
	gammaFor,
	sampleBookMove,
	sampleByFrequency,
} from "./explorer";
import { type BookMove, loadBook, type PolyglotBook } from "./polyglot";

export interface BookContext {
	fen: string;
	ply: number;
	/** Effective Elo `E` (§7.2 step 1). */
	targetElo: number;
	timeControl?: TimeControl | undefined;
	/** `Settings.strength.useOpeningBook`. */
	useOpeningBook: boolean;
	rng: Rng;
	/** The engine's current MultiPV lines (side-to-move POV), when available, for the trap check. */
	lines?: readonly EvalLine[] | undefined;
}

export interface BookPolicyDeps {
	/** `null` disables the online source (privacy toggle / no host permission). */
	explorer?: ExplorerQuery | null;
	/** Bytes of the bundled book `name`; defaults to `fetch(runtimeGetURL(BOOKS.dir + name))`. */
	loadBook?: (name: string) => Promise<Uint8Array | null>;
}

export interface BookPolicy {
	bookMove(ctx: BookContext): Promise<ChosenMove | null>;
	dispose(): void;
}

async function fetchBundledBook(name: string): Promise<Uint8Array | null> {
	try {
		const res = await fetch(runtimeGetURL(BOOKS.dir + name));
		if (!res.ok) return null;
		return new Uint8Array(await res.arrayBuffer());
	} catch (err) {
		log.warn("book: failed to load", name, err);
		return null;
	}
}

/** `gm2600` from `EXPLORER.gmBookElo`, `club` below. */
export function bookNameFor(E: number): BookName {
	return E >= EXPLORER.gmBookElo ? "gm2600" : "club";
}

interface LineFacts {
	rank: number;
	cpLoss: number;
	/** Win-fraction loss vs the best line; `null` when the move is not among the lines. */
	loss: number | null;
}

/** Rank, cp loss and win-fraction loss of `uci` relative to the best of `lines`. */
export function lineFacts(uci: string, lines: readonly EvalLine[] | undefined): LineFacts {
	if (!lines || lines.length === 0) return { rank: 0, cpLoss: 0, loss: null };
	let bestCp = Number.NEGATIVE_INFINITY;
	for (const line of lines) bestCp = Math.max(bestCp, cpEffective(line.score));
	const index = lines.findIndex((line) => line.pvUci[0] === uci);
	if (index < 0) return { rank: 0, cpLoss: 0, loss: null };
	const cp = cpEffective(lines[index]?.score ?? {});
	return {
		rank: index + 1,
		cpLoss: Math.max(0, bestCp - cp),
		loss: Math.max(0, winProb(bestCp) - winProb(cp)),
	};
}

/** §7.3: from E ≥ 1800 a book move losing ≥ 0.15 win-fraction vs the engine's best is a trap. */
export function isTrap(E: number, facts: LineFacts): boolean {
	return E >= EXPLORER.trapCheckElo && facts.loss !== null && facts.loss >= EXPLORER.trapLoss;
}

function fmt(n: number): string {
	return Number(n.toFixed(3)).toString();
}

export function createBookPolicy(deps: BookPolicyDeps = {}): BookPolicy {
	const explorer = deps.explorer === undefined ? null : deps.explorer;
	const load = deps.loadBook ?? fetchBundledBook;
	/** Loaded books (or `null` after a failed load, so it is not retried every move). */
	const books = new Map<BookName, Promise<PolyglotBook | null>>();
	let disposed = false;

	function bookFor(name: BookName): Promise<PolyglotBook | null> {
		let pending = books.get(name);
		if (!pending) {
			pending = load(BOOKS[name])
				.then((bytes) => (bytes ? loadBook(bytes) : null))
				.catch((err: unknown) => {
					log.warn("book: load failed", name, err);
					return null;
				});
			books.set(name, pending);
		}
		return pending;
	}

	function finish(
		uci: string,
		ctx: BookContext,
		facts: LineFacts,
		rationale: string[]
	): ChosenMove | null {
		const parts = parseUci(uci);
		if (!parts || !legalMoves(ctx.fen).includes(uci)) {
			log.warn("book: illegal move from book", uci);
			return null;
		}
		const chosen: ChosenMove = {
			uci,
			san: uciToSan(ctx.fen, uci) ?? uci,
			from: parts.from,
			to: parts.to,
			source: "book",
			rankInLines: facts.rank,
			cpLoss: facts.cpLoss,
			rationale,
		};
		if (parts.promotion !== undefined) chosen.promotion = parts.promotion;
		return chosen;
	}

	async function fromExplorer(ctx: BookContext, rationale: string[]): Promise<ChosenMove | null> {
		if (!explorer) return null;
		const res = await explorer.query(ctx.fen, ctx.targetElo, ctx.timeControl);
		if (!res || disposed) return null;
		const total = res.moves.reduce((sum, m) => sum + gamesOf(m), 0);
		if (total < EXPLORER.minPositionGames) {
			rationale.push(`explorer: N=${total} < ${EXPLORER.minPositionGames}`);
			return null;
		}
		const pick = sampleBookMove(res.moves, ctx.targetElo, ctx.rng);
		if (!pick) return null;
		const facts = lineFacts(pick.uci, ctx.lines);
		const share = fmt(gamesOf(pick) / total);
		if (isTrap(ctx.targetElo, facts)) {
			rationale.push(`explorer: ${pick.san} (${share}) is a trap, loss ${fmt(facts.loss ?? 0)}`);
			return null;
		}
		rationale.push(
			`explorer: ${pick.san} played in ${gamesOf(pick)}/${total} games (${share}), γ=${fmt(gammaFor(ctx.targetElo))}`
		);
		return finish(pick.uci, ctx, facts, rationale);
	}

	async function fromPolyglot(ctx: BookContext, rationale: string[]): Promise<ChosenMove | null> {
		const E = ctx.targetElo;
		if (E < EXPLORER.polyglotWeakElo && ctx.rng.chance(EXPLORER.polyglotWeakLeaveProb)) {
			rationale.push("polyglot: left book early (weak target)");
			return null;
		}
		const name = bookNameFor(E);
		const book = await bookFor(name);
		if (!book || disposed) return null;
		const entries = book.lookup(ctx.fen);
		if (entries.length === 0) return null;
		const pick = sampleByFrequency<BookMove>(
			entries,
			(m) => m.weight,
			(w, total) => w >= EXPLORER.polyglotMinWeightShare * total,
			E,
			ctx.rng
		);
		if (!pick) return null;
		const facts = lineFacts(pick.uci, ctx.lines);
		if (isTrap(E, facts)) {
			rationale.push(`polyglot: ${pick.uci} is a trap, loss ${fmt(facts.loss ?? 0)}`);
			return null;
		}
		const total = entries.reduce((sum, m) => sum + m.weight, 0);
		rationale.push(`polyglot ${BOOKS[name]}: weight ${pick.weight}/${total}`);
		return finish(pick.uci, ctx, facts, rationale);
	}

	return {
		async bookMove(ctx) {
			if (disposed || !ctx.useOpeningBook || ctx.ply > EXPLORER.maxPly) return null;
			const rationale: string[] = [];
			const online = await fromExplorer(ctx, rationale);
			if (online) return online;
			return fromPolyglot(ctx, rationale);
		},
		dispose() {
			disposed = true;
			books.clear();
		},
	};
}
