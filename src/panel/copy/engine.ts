/** Engine status and the Engine & diagnostics view (Task 26; Appendix F §4.7, V2 §3.6). */

import { SITE } from "./site";

export const ENGINE_COPY = {
	idle: "Ready",
	thinking: (depth: number): string => (depth > 0 ? `Thinking · d${depth}` : "Thinking…"),
	locked: "Locked",
	stopped: "Stopped",
	loading: "Loading…",
	rows: {
		version: (v: string, nnue: string): string => `Stockfish ${v} · ${nnue}`,
		nnueLoaded: "NNUE loaded",
		/** The host runs the small-net build because the requested full build crashed twice. */
		fallback: "full build crashed · small net until restart",
		resources: (threads: number, hashMb: number): string => `Threads ${threads} · Hash ${hashMb} MB`,
	},
	logKinds: { plan: "plan", exec: "exec", verify: "verify", warn: "warn" },
} as const;

export const ENGINE_VIEW_COPY = {
	sections: {
		engine: "Engine",
		policy: "Human model",
		executor: "Executor",
		timing: "Timing model",
		session: "Session",
		log: "Log",
	},
	depth: (d: number): string => `depth ${d}`,
	nps: {
		mega: (n: string): string => `${n} Mn/s`,
		kilo: (n: string): string => `${n} kn/s`,
		unit: (n: string): string => `${n} n/s`,
	},
	sparkline: "Nodes per second, last 60 seconds",
	none: "—",
	/** Which model picks the move at the current target rating (2026-09-11). */
	selection: {
		maia: (size: string): string => `Selection · Maia-3 · ${size}`,
		stockfishSmall: "Selection · Stockfish 19 · small net",
		stockfishFull: "Selection · Stockfish 19 · full net",
		/** One shipped size since 2026-09-13; the map stays total over `MaiaSize`. */
		maiaSizes: { "79m": "79M" },
	},
	/** The Maia-3 block: the active size, its last answer and the inference-time sparkline. */
	policy: {
		name: (size: string): string => `Maia-3 · ${size}`,
		inactive: "Stockfish policy at this rating",
		off: "Off",
		waiting: "No answer yet",
		answered: "Answering",
		fallback: "Engine policy for this move",
		sparkline: "Maia-3 inference time per move, last 60 moves",
		latency: (ms: string): string => `${ms} ms`,
		pick: (pct: string): string => `pick ${pct}%`,
		wdl: (w: string, d: string, l: string): string => `W ${w} · D ${d} · L ${l} · side to move`,
		/**
		 * The fidelity meters (2026-09-13, §3.2 of the human-move-selection ideas): how much of
		 * the move was Maia's and how much the wrapper's, per move, from `rec.maia`.
		 */
		meters: {
			history: "History",
			selfElo: "Asked at",
			entropy: "Entropy",
			railed: "Railed mass",
			unscored: "Unscored mass",
			kl: "KL from Maia",
			rank: "Rank",
			candidates: "Candidates",
		},
		historyValue: (plies: number, max: number): string => `${plies}/${max} plies`,
		eloValue: (elo: number): string => `${elo} Elo`,
		pctValue: (pct: string): string => `${pct}%`,
		rankValue: (rank: number, survivors: number): string => `${rank} of ${survivors}`,
		candidatesValue: (k: number, depth: number): string => `${k} @ depth ${depth}`,
		/** H7.1: the query carried fewer plies than the model's window, past the opening. */
		historyWarning: "History unavailable — the model sees one frame",
	},
	rows: {
		debugger: "Debugger",
		target: "Target",
		input: "Input mode",
		last: "Last action",
		license: "License",
	},
	site: SITE,
	target: (gameId: string): string => `${SITE} · game ${gameId}`,
	outcomes: {
		executed: "executed",
		dispatched: "premove sent",
		skipped: "skipped",
		paused: "paused",
		aborted: "aborted",
		failed: "failed",
	},
	lastAction: (tier: string, seconds: string, outcome: string): string =>
		`${tier} · ${seconds}s · ${outcome}`,
	phase: (name: string, ms: number): string => `${name} ${ms}ms`,
	detach: "Detach",
	licenseVerdict: (raw: string, forced: boolean): string => (forced ? `${raw} (forced valid)` : raw),
	rationale: {
		model: (head: string, band?: string): string => `model ${head}${band ? ` · ${band}` : ""}`,
		fallback: (reason: string): string => `fallback: ${reason}`,
		context: (elo: number, opponentSeconds: string): string =>
			`target ${elo} · opponent ${opponentSeconds}s`,
		base: (seconds: string, mode: string, persona: string): string =>
			`base ${seconds}s (${mode} · ${persona})`,
		term: (name: string, seconds: string): string => `${seconds}s ${name}`,
		factors: (comp: string, eps: string): string => `complexity ${comp} · eps ${eps}`,
		total: (seconds: string, mode: string): string => `= ${seconds}s · ${mode}`,
		exec: (seconds: string, delta: string): string => `actual ${seconds}s (Δ ${delta}s)`,
		verify: (delta: string): string => `within plan (Δ ${delta}s)`,
		warn: (delta: string): string => `drifted from plan (Δ ${delta}s)`,
	},
	copy: "Copy log",
	export: "Export",
	clear: "Clear",
	copied: "Log copied",
	copyFailed: "Copy failed",
	logEmpty: "No timing entries",
	session: (games: number, moves: number, avg: string | null): string =>
		`${games} games · ${moves} moves · ${avg === null ? "—" : `${avg}s`} avg move`,
	reset: "Reset session",
	level: "Level",
	levels: { silent: "Silent", error: "Error", warn: "Warn", info: "Info", debug: "Debug" },
	consoleEmpty: "No log entries",
} as const;
