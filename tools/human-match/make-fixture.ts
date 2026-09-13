/**
 * tools/human-match/make-fixture.ts — writes `test/fixtures/strength/maia-draw.json`, the Maia
 * fixed-pool replay fixture (§8.2 of `docs/research/human-move-selection-ideas-2026-09-13.md`).
 *
 * For every position of the 60-position parity set (`test/fixtures/maia3/positions.json`):
 *   - the full legal-move distribution of every shipped model (`--sizes`; the 79M model alone
 *     since 2026-09-13 — the checked-in fixture predates that and holds the 5M and 23M answers) at
 *     the position's own
 *     `selfElo` / `oppoElo`, decoded by the real `encodeMaiaInputs` → `decodeMaiaOutputs` under the
 *     vendored onnxruntime-web (the parity test proves this path reproduces torch fp32), so the
 *     fixture is bit-faithful to what the offscreen host answers;
 *   - one real Stockfish 18 smallnet MultiPV frame at full strength (the referee) over exactly the
 *     union of each size's top-`--top` moves via `go searchmoves`, `movetime 600 depth 18`, one
 *     thread, 32 MB hash — the last complete cycle, as the other `stockfish18-*.json` fixtures.
 *
 * The engine scores are real but a fixed sample, not a calibration; the fixture exists so the whole
 * Maia draw (rails, temperature/offset, meters) is testable with no engine and no model.
 *
 *     bun tools/human-match/make-fixture.ts [--out FILE] [--movetime 600] [--depth 18]
 *                                           [--sizes 79m] [--top 8] [--limit N]
 *
 * Takes ≈ 1 min (the engine dominates). Never run inside `bun run check`.
 */

import "./defines";
import path from "node:path";
import { parseFen, plyOf } from "@core/chess/fen";
import { MAIA, MAIA_SIZES, type MaiaSize } from "@core/constants/maia";
import { maiaIndexToUci, maiaMoveIndex } from "@core/policy/maia-encoder";
import { cpEffective, winProb } from "@core/strength/elo-map";
import { lossCapFor } from "@core/strength/maia-select";
import { hangsPiece } from "@core/strength/move-selector";
import { rankedLines } from "@core/strength/quality";
import type { EvalLine } from "@typedefs/engine";
import { createRefereeEngine, ROOT } from "./engine";
import { createMaiaRunner } from "./maia";

export interface FixturePolicy {
	moves: Array<[string, number]>;
	wdl: [number, number, number];
}

export interface FixturePosition {
	index: number;
	fen: string;
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
	ply: number;
	policy: Partial<Record<MaiaSize, FixturePolicy>>;
	engine: {
		searchmoves: string[];
		bestmove: string | null;
		depth: number;
		complete: boolean;
	};
	lines: EvalLine[];
}

export interface MaiaDrawFixture {
	provenance: {
		source: string;
		generator: string;
		engine: string;
		models: string[];
		command: string;
		threads: number;
		hashMb: number;
		collection: string;
		capturedOn: string;
		note: string;
	};
	positions: FixturePosition[];
}

interface Args {
	out: string;
	movetime: number;
	depth: number;
	sizes: MaiaSize[];
	top: number;
	limit: number;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		out: path.join(ROOT, "test/fixtures/strength/maia-draw.json"),
		movetime: 600,
		depth: 18,
		sizes: [...MAIA_SIZES],
		top: 8,
		limit: 0,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
			case "--out":
				args.out = value ?? args.out;
				i++;
				break;
			case "--movetime":
				args.movetime = Number(value);
				i++;
				break;
			case "--depth":
				args.depth = Number(value);
				i++;
				break;
			case "--sizes":
				args.sizes = (value ?? "")
					.split(",")
					.filter((s): s is MaiaSize => (MAIA_SIZES as readonly string[]).includes(s));
				i++;
				break;
			case "--top":
				args.top = Number(value);
				i++;
				break;
			case "--limit":
				args.limit = Number(value);
				i++;
				break;
			default:
				throw new Error(`unknown argument ${flag}`);
		}
	}
	return args;
}

interface ParityPosition {
	fen: string;
	historyFens: string[];
	selfElo: number;
	oppoElo: number;
}
interface ExpectedFixture {
	positions: Array<{ top: Array<[string, number]> }>;
}

/** Σ Maia mass the current rails would exclude at `E` — printed so the tests' ceilings have a basis. */
function railedMassAt(p: FixturePosition, size: MaiaSize, E: number): number {
	const policy = p.policy[size];
	if (!policy) return 0;
	const prob = new Map(policy.moves);
	const ranked = rankedLines(p.lines);
	const top = ranked[0];
	if (!top) return 0;
	const winTop = winProb(cpEffective(top.score));
	const cap = lossCapFor(E);
	const alternative = ranked.some((l) => (l.score.mate ?? 0) >= 0);
	let mass = 0;
	for (const line of ranked) {
		const uci = line.pvUci[0] ?? "";
		const lossRaw = winTop - winProb(cpEffective(line.score));
		const mated = alternative && (line.score.mate ?? 0) < 0;
		if (mated || hangsPiece(line, lossRaw, p.fen) || lossRaw > cap) mass += prob.get(uci) ?? 0;
	}
	return mass;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const parity = (await Bun.file(path.join(ROOT, "test/fixtures/maia3/positions.json")).json()) as {
		positions: ParityPosition[];
	};
	const source = args.limit > 0 ? parity.positions.slice(0, args.limit) : parity.positions;

	console.log(`maia: loading ${args.sizes.join(", ")} …`);
	const maia = await createMaiaRunner(1);
	const positions: FixturePosition[] = [];
	const argmaxAgree = new Map<MaiaSize, number>();
	for (const [index, p] of source.entries()) {
		const parts = parseFen(p.fen);
		if (!parts) throw new Error(`position ${index}: unreadable FEN`);
		const policy: FixturePosition["policy"] = {};
		for (const size of args.sizes) {
			const answer = await maia.query(size, p.historyFens, p.selfElo, p.oppoElo);
			policy[size] = { moves: answer.moves, wdl: answer.wdl };
		}
		positions.push({
			index,
			fen: p.fen,
			historyFens: p.historyFens,
			selfElo: p.selfElo,
			oppoElo: p.oppoElo,
			ply: plyOf(parts),
			policy,
			engine: { searchmoves: [], bestmove: null, depth: 0, complete: false },
			lines: [],
		});
	}
	// Sanity against the torch reference: the argmax must agree for every position.
	for (const size of args.sizes) {
		const file = Bun.file(path.join(ROOT, `test/fixtures/maia3/expected-${size}.json`));
		if (!(await file.exists())) continue;
		const expected = (await file.json()) as ExpectedFixture;
		let agree = 0;
		for (const p of positions) {
			const want = expected.positions[p.index]?.top[0]?.[0];
			const mirrored = p.fen.split(" ")[1] === "b";
			const wantBoard =
				want === undefined ? undefined : maiaIndexToUci(maiaMoveIndex(want, false), mirrored);
			if (wantBoard !== undefined && p.policy[size]?.moves[0]?.[0] === wantBoard) agree++;
		}
		argmaxAgree.set(size, agree);
		console.log(`maia ${size}: argmax agrees with torch on ${agree}/${positions.length}`);
		if (agree !== positions.length) throw new Error(`maia ${size}: parity mismatch, aborting`);
	}
	await maia.dispose();

	console.log("engine: booting the vendored Stockfish 18 smallnet …");
	const engine = await createRefereeEngine({ threads: 1, hashMb: 32 });
	const started = performance.now();
	for (const p of positions) {
		const roots = new Set<string>();
		for (const size of args.sizes)
			for (const [uci] of (p.policy[size]?.moves ?? []).slice(0, args.top)) roots.add(uci);
		const searchmoves = [...roots];
		const frame = await engine.search({
			fen: p.fen,
			movetimeMs: args.movetime,
			depth: args.depth,
			multiPv: searchmoves.length,
			searchmoves,
		});
		p.engine = {
			searchmoves,
			bestmove: frame.bestmove,
			depth: frame.depth,
			complete: frame.complete,
		};
		p.lines = frame.lines;
		console.log(
			`  #${p.index} ${searchmoves.length} roots → ${frame.lines.length} lines depth ${frame.depth}${frame.complete ? "" : " (incomplete)"} best ${frame.bestmove} ${frame.elapsedMs.toFixed(0)} ms`
		);
	}
	engine.dispose();
	console.log(
		`engine: ${positions.length} frames in ${((performance.now() - started) / 1000).toFixed(1)} s`
	);

	const fixture: MaiaDrawFixture = {
		provenance: {
			source: "test/fixtures/maia3/positions.json (the 60-position parity set, seed 34)",
			generator: "tools/human-match/make-fixture.ts",
			engine: "vendored Stockfish 18 smallnet, full strength (referee), one thread, 32 MB hash",
			models: args.sizes.map((s) => `maia3-${s}.onnx via onnxruntime-web wasm, one thread`),
			command: `go movetime ${args.movetime} depth ${args.depth} searchmoves <union of each size's top-${args.top}>`,
			threads: 1,
			hashMb: 32,
			collection:
				"Last complete MultiPV cycle per position before the bestmove; `pvSan` filled from the position. Fixed examples; not a rating calibration.",
			capturedOn: new Date().toISOString().slice(0, 10),
			note:
				"policy.<size>.moves are the decoded board-frame legal-move distributions at the position's own selfElo/oppoElo (full precision, summing to 1); lines cover only the searchmoves roots.",
		},
		positions,
	};
	await Bun.write(args.out, `${JSON.stringify(fixture)}\n`);
	console.log(`wrote ${args.out} (${positions.length} positions)`);

	const targets = [1000, 1500, 2000, 2400];
	for (const size of args.sizes) {
		const row = targets.map((E) => {
			let sum = 0;
			for (const p of positions) sum += railedMassAt(p, size, E);
			return `${E}: ${(sum / positions.length).toFixed(3)}`;
		});
		console.log(
			`railed mass under the current rails (${size}, mean over positions) — ${row.join("  ")}`
		);
	}
	console.log(`lossCap knots: ${MAIA.lossCap.map(([e, c]) => `${e}→${c}`).join(", ")}`);
}

await main();
