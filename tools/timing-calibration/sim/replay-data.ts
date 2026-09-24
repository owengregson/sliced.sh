/**
 * tools/timing-calibration/sim/replay-data.ts — what the replay reads: the selected game-sides
 * (`select.json`) of `select-games.jsonl`, each own move with its frame lines, the ponder's
 * prediction, the cached head distribution and the deterministic per-row facts (the premove arm
 * and the fast-reply recapture rule). The facts are cached in `replay-facts.jsonl`, keyed by the
 * rules they depend on; a change of those constants recomputes them.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { PREMOVE } from "@core/constants";
import { TABLEBASE } from "@core/constants/tablebase";
import { pieceCount } from "@core/tablebase/probe";
import { isObviousRecapture } from "@core/timing/calibration";
import type { EvalLine } from "@typedefs/engine";
import { type CorpusGame, DATA_DIR, PATHS, readJsonl, rowsOf, type TimingRow } from "../common";
import { loadFrames } from "../frames";
import { type HeadResult, headsPath } from "../heads";
import { SELECT_PATH, type Selection } from "../select";
import { compact, type PremoveFacts, premoveFacts } from "./premove-facts";

export interface ReplayRow {
	row: TimingRow;
	lines: EvalLine[];
	/** The ponder's expected reply after our previous move (best line of the opponent's position). */
	predicted: string | null;
	/** Our answer in that best line (where the idle hand anticipates). */
	pondered: string | null;
	premove: PremoveFacts | null;
	/** The same under the calibrated trade gate (`PREMOVE.tradeReplyMinProb`). */
	premoveRelaxed: PremoveFacts | null;
	/** The fast-reply rule's recapture case holds (see `isFastReply`). */
	recaptureDecided: boolean;
	oppThinks: number[];
	head: HeadResult | null;
	/** `ownMoveBudget`'s movetime per chain (the persona's `tau` is fixed per chain key), filled lazily. */
	movetime: number[];
}

export interface ReplaySide {
	key: string;
	game: CorpusGame;
	color: "w" | "b";
	split: string;
	rows: ReplayRow[];
}

export interface ReplayData {
	sides: ReplaySide[];
}

/** Load the selection, frames and heads, and precompute the deterministic per-row facts. */
export async function loadReplay(
	options: { headsTag?: string; limitSides?: number } = {}
): Promise<ReplayData> {
	const selection = (await Bun.file(SELECT_PATH).json()) as Selection;
	const frames = await loadFrames();
	const heads = new Map<string, HeadResult>();
	// `SL_HEADS_TAG` selects a candidate band set's cached outputs (`heads.<tag>.jsonl`) for every tool.
	const headsFile = headsPath(options.headsTag ?? process.env.SL_HEADS_TAG ?? "");
	if (existsSync(headsFile))
		for await (const h of readJsonl<HeadResult>(headsFile, true)) heads.set(h.id, h);
	const wanted = new Map<string, Array<{ color: "w" | "b"; split: string }>>();
	for (const s of selection.sides) {
		const list = wanted.get(s.gameId) ?? [];
		list.push({ color: s.color, split: s.split });
		wanted.set(s.gameId, list);
	}
	// The engine-dependent facts are cached per row (`replay-facts.jsonl`), keyed by the rules
	// they depend on; a change of those constants recomputes them.
	const version = JSON.stringify({ PREMOVE, maxPieces: TABLEBASE.maxPieces, v: 2 });
	const factsFile = path.join(DATA_DIR, "replay-facts.jsonl");
	const cached = new Map<string, RowFacts>();
	if (existsSync(factsFile)) {
		let first = true;
		for await (const rec of readJsonl<RowFacts & { version?: string }>(factsFile, true)) {
			if (first) {
				first = false;
				if (rec.version !== version) break;
				continue;
			}
			cached.set(rec.id, rec);
		}
	}
	const fresh: RowFacts[] = [];
	const sides: ReplaySide[] = [];
	for await (const g of readJsonl<CorpusGame>(PATHS.selectGames)) {
		const want = wanted.get(g.gameId);
		const f = frames.get(g.gameId);
		if (!want || !f) continue;
		const all = rowsOf(g);
		const byPly = new Map(all.map((r) => [r.ply, r]));
		for (const { color, split } of want) {
			const rows: ReplayRow[] = [];
			const oppThinks: number[] = [];
			for (let ply = 0; ply < g.ucis.length; ply++) {
				const r = byPly.get(ply);
				const own = ply % 2 === (color === "w" ? 0 : 1);
				if (!own) {
					if (r) oppThinks.push(r.thinkMs);
					continue;
				}
				if (!r || r.first) continue;
				const oppFrame = compact(f.plies[ply - 1], f.depth);
				const lastMove = g.ucis[ply - 1];
				const predicted = oppFrame[0]?.pvUci[0] ?? null;
				const pondered = oppFrame[0]?.pvUci[1] ?? null;
				let facts = cached.get(r.id);
				if (!facts) {
					facts = {
						id: r.id,
						// The fast-reply rule's recapture: the opponent's-turn analysis predicted this reply
						// and rated an obvious recapture our best answer (`ponderedAnswer`); not in
						// tablebase range.
						recaptureDecided:
							lastMove !== undefined &&
							predicted === lastMove &&
							pondered !== null &&
							(pieceCount(r.fen) ?? 0) > TABLEBASE.maxPieces &&
							isObviousRecapture(g.fens[ply - 1], lastMove, r.fen, pondered),
						premove: await premoveFacts(g, f.plies, f.depth, r, false),
						premoveRelaxed: await premoveFacts(g, f.plies, f.depth, r, true),
					};
					fresh.push(facts);
				}
				rows.push({
					row: r,
					lines: compact(f.plies[ply], f.depth),
					predicted,
					pondered,
					premove: facts.premove,
					premoveRelaxed: facts.premoveRelaxed,
					recaptureDecided: facts.recaptureDecided,
					oppThinks: [...oppThinks],
					head: heads.get(r.id) ?? null,
					movetime: [],
				});
			}
			if (rows.length > 0) sides.push({ key: `${g.gameId}:${color}`, game: g, color, split, rows });
			if (options.limitSides && sides.length >= options.limitSides) return { sides };
		}
	}
	if (fresh.length > 0) {
		const lines = [
			JSON.stringify({ version }),
			...[...cached.values(), ...fresh].map((f) => JSON.stringify(f)),
		];
		await Bun.write(factsFile, `${lines.join("\n")}\n`);
	}
	return { sides };
}

/** The engine-dependent facts of a row, cached across runs. */
interface RowFacts {
	id: string;
	recaptureDecided: boolean;
	premove: PremoveFacts | null;
	premoveRelaxed: PremoveFacts | null;
}
