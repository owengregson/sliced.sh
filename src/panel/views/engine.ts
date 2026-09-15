/**
 * View 6 — Engine and diagnostics (Appendix F §4.7, §9.7, V2 §3.6).
 *
 * A projection of `PanelSnapshot`: engine rows (version · NNUE names, threads/hash, the nps
 * numeral and depth) with a 60 s nps sparkline sampled once per `UI_TIMINGS.sparklineSampleMs`
 * from successive snapshots (an inline `<svg>` built with DOM APIs, ≤ `LIMITS.npsSparklineSamples`
 * points, colours from the theme tokens in `engine.css`); executor rows (debugger, target, input mode, last
 * action with the `ExecutionResult.timeline` phase durations) with Detach / Reattach; the raw
 * license verdict; the timing rationale log (`TimingLogEntry` → `plan/exec/verify/warn` rows in
 * `mono-xs`, newest at the bottom) with Copy / Export / Clear; the session line with Reset; and
 * the live log pane fed by `logging-bridge.ts` with a level control (initial value
 * `settings.advanced.logLevel`). Every listener, port and component is released by the cleanup.
 *
 * Export builds a `data:application/json` URL and opens it through the shell's `open-url`
 * action (refused while hands-off, §13.4); `chrome.downloads` is not a permission. While a game
 * is live every command here is disabled (hands-off).
 */

import { tabsQuery } from "@core/chrome/tabs";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { LIMITS } from "@core/constants/limits";
import { MAIA_INPUT } from "@core/constants/maia";
import { type LogStreamMessage, MSG, type PanelSnapshot } from "@core/constants/messages";
import { UI_TIMINGS } from "@core/constants/ui";
import { LOG_LEVELS, type LogEntry, levelAllows, log } from "@core/logger";
import { maiaSizeFor, usesMaia, usesMaiaPrior } from "@core/policy/maia-size";
import { normalizeTimingStats } from "@core/timing/session-stats";
import { TOKENS } from "@design/tokens.generated";
import type { ExecutionResult } from "@typedefs/game";
import type { LogLevel } from "@typedefs/settings";
import type { TimingLogEntry } from "@typedefs/timing";
import { JSON_DATA_URL_PREFIX } from "../actions";
import { type ButtonHandle, createButton } from "../components/button";
import { createPill, type PillHandle, type PillVariant } from "../components/pill";
import { showToast } from "../components/toast";
import { COPY, SETTINGS_COPY } from "../copy";
import { mountIcons } from "../icons-mount";
import { createLoggingBridge, type LoggingBridge } from "../logging-bridge";
import { isHandsOff } from "../router";
import type { PanelCommandType } from "../store";
import { instantiate, part } from "../template";
import type { Cleanup, View, ViewContext } from "../view";
import html from "./templates/engine.html?raw";
import consoleRowHtml from "./templates/engine-console-row.html?raw";
import logLineHtml from "./templates/engine-log-line.html?raw";
import logRowHtml from "./templates/engine-log-row.html?raw";
import optionHtml from "./templates/engine-option.html?raw";
import phaseHtml from "./templates/engine-phase.html?raw";

export type RationaleKind = keyof typeof COPY.engine.logKinds;

/** One rendered row of the timing rationale log (8ch time column, 5ch kind column, lines). */
export interface RationaleRow {
	kind: RationaleKind;
	time: string;
	lines: string[];
}

export interface EngineViewDeps {
	/** Log-stream bridge factory (tests inject a fake); receives the initial level. */
	logging?: (level: LogLevel) => LoggingBridge;
	/** Clipboard writer for "Copy log" (defaults to `navigator.clipboard.writeText`). */
	clipboard?: (text: string) => Promise<void>;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const MEGA = 1_000_000;
const KILO = 1_000;
const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const TWO_DIGITS = 10;

/** `1.42 Mn/s`, `950 kn/s`, `420 n/s`; the em dash when unknown. */
export function formatNps(nps: number | undefined): string {
	if (nps === undefined || !Number.isFinite(nps)) return COPY.engineView.none;
	if (nps >= MEGA) return COPY.engineView.nps.mega((nps / MEGA).toFixed(2));
	if (nps >= KILO) return COPY.engineView.nps.kilo(String(Math.round(nps / KILO)));
	return COPY.engineView.nps.unit(String(Math.round(nps)));
}

const seconds = (ms: number): string => (ms / SECOND_MS).toFixed(1);
const signedSeconds = (ms: number): string => `${ms >= 0 ? "+" : "−"}${seconds(Math.abs(ms))}`;

/** `m:ss` from a clock in ms (the 8ch column of the rationale log). */
function clockText(ms: number): string {
	const total = Math.max(0, Math.round(ms / SECOND_MS));
	const m = Math.floor(total / (MINUTE_MS / SECOND_MS));
	const s = total % (MINUTE_MS / SECOND_MS);
	return `${m}:${s < TWO_DIGITS ? "0" : ""}${s}`;
}

/** `TimingLogEntry` → the rows the log shows for it (§8.6, Appendix F §4.7). */
export function rationaleRows(entry: TimingLogEntry): RationaleRow[] {
	const time = clockText(entry.clockMs);
	const persona = COPY.personaName[entry.persona];
	const plan: RationaleRow = {
		kind: "plan",
		time,
		lines: [
			...(entry.model ? [COPY.engineView.rationale.model(entry.model.head, entry.model.band)] : []),
			...(entry.model?.fallbackReason
				? [COPY.engineView.rationale.fallback(entry.model.fallbackReason)]
				: []),
			...(entry.targetElo !== undefined && entry.opponentClockMs !== undefined
				? [COPY.engineView.rationale.context(entry.targetElo, seconds(entry.opponentClockMs))]
				: []),
			COPY.engineView.rationale.base(entry.alloc.toFixed(1), entry.mode, persona),
			...entry.topTerms.map(([name, value]) =>
				COPY.engineView.rationale.term(name, `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}`)
			),
			COPY.engineView.rationale.factors(entry.comp.toFixed(2), entry.eps.toFixed(2)),
			...(entry.rationale ?? []),
			COPY.engineView.rationale.total(seconds(entry.plannedMs), entry.mode),
		],
	};
	if (entry.actualMs === null) return [plan];
	const delta = entry.actualMs - entry.plannedMs;
	const drift = entry.plannedMs > 0 ? Math.abs(delta) / entry.plannedMs : 0;
	const exec: RationaleRow = {
		kind: "exec",
		time,
		lines: [COPY.engineView.rationale.exec(seconds(entry.actualMs), signedSeconds(delta))],
	};
	const outcome: RationaleRow =
		drift > LIMITS.timingLogDriftWarn
			? { kind: "warn", time, lines: [COPY.engineView.rationale.warn(signedSeconds(delta))] }
			: { kind: "verify", time, lines: [COPY.engineView.rationale.verify(signedSeconds(delta))] };
	return [plan, exec, outcome];
}

function enginePill(snapshot: PanelSnapshot): { variant: PillVariant; text: string } {
	switch (snapshot.engine.state) {
		case "searching":
			return { variant: "thinking", text: COPY.engine.thinking(snapshot.recommendation?.depth ?? 0) };
		case "ready":
			return { variant: "ok", text: COPY.engine.idle };
		case "crashed":
			return { variant: "danger", text: COPY.engine.stopped };
		default:
			return { variant: "idle", text: COPY.engine.loading };
	}
}

/** Selection policy at the active target and the network currently reported by the engine. */
export function selectionModel(snapshot: PanelSnapshot): string {
	const { strength } = snapshot.settings;
	const target = snapshot.opponent?.derivedTargetElo ?? strength.targetElo;
	const { selection } = COPY.engineView;
	if (usesMaia(target)) return selection.maia(selection.maiaSizes[maiaSizeFor(target)]);
	const full = snapshot.engine.variant === "full";
	if (usesMaiaPrior(target)) return full ? selection.maiaPriorFull : selection.maiaPriorSmall;
	return full ? selection.stockfishFull : selection.stockfishSmall;
}

/** What the Human-model block shows for a snapshot (exported for the view's tests). */
export interface PolicyBlock {
	name: string;
	pill: { variant: PillVariant; text: string };
	/** The last answer's pick probability and WDL, or why there is none. */
	detail: string;
	latency: string;
	meta: string;
	/** Identity of the recommendation the answer belongs to; a new one adds a sparkline sample. */
	sampleKey: string | null;
	sampleMs: number | null;
	/** The fidelity meters (§3.2) present on `rec.maia`, in template order; empty → the list hides. */
	meters: Array<{ row: PolicyMeterRow; value: string }>;
	/** H7.1: the history warning, or `null`. */
	warning: string | null;
}

export type PolicyMeterRow = keyof typeof COPY.engineView.policy.meters;

const PERCENT = 100;
const pct = (v: number): string => String(Math.round(v * PERCENT));
const ENTROPY_DIGITS = 2;
const KL_DIGITS = 3;

/**
 * The meters `rec.maia` carries, as rows: the history window and the rating asked at come with
 * every answer; the draw's own meters only when the selector drew from the model
 * (`rec.maia.meters`); the generate-and-verify pair only when that path ran.
 */
export function policyMeters(maia: NonNullable<PanelSnapshot["recommendation"]>["maia"]): {
	rows: PolicyBlock["meters"];
} {
	const { policy: copy } = COPY.engineView;
	const rows: PolicyBlock["meters"] = [];
	if (!maia) return { rows };
	if (maia.historyPlies !== undefined)
		rows.push({ row: "history", value: copy.historyValue(maia.historyPlies, MAIA_INPUT.history) });
	if (maia.selfElo !== undefined)
		rows.push({ row: "selfElo", value: copy.eloValue(Math.round(maia.selfElo)) });
	const m = maia.meters;
	if (m) {
		rows.push({ row: "entropy", value: m.entropy.toFixed(ENTROPY_DIGITS) });
		rows.push({ row: "railed", value: copy.pctValue(pct(m.railedMass)) });
		rows.push({ row: "unscored", value: copy.pctValue(pct(m.unscoredMass)) });
		rows.push({ row: "kl", value: m.klFromMaia.toFixed(KL_DIGITS) });
		rows.push({
			row: "rank",
			value: m.rank > 0 ? copy.rankValue(m.rank, m.survivors) : COPY.engineView.none,
		});
		if (m.candidates !== undefined && m.verifyDepth !== undefined)
			rows.push({ row: "candidates", value: copy.candidatesValue(m.candidates, m.verifyDepth) });
	}
	return { rows };
}

/** H7.1: the query carried fewer plies than the model's window, and the game is past that window. */
export function policyHistoryWarning(historyPlies: number | undefined, ply: number): string | null {
	if (historyPlies === undefined) return null;
	if (historyPlies >= MAIA_INPUT.history || ply <= MAIA_INPUT.history) return null;
	return COPY.engineView.policy.historyWarning;
}

/**
 * The Maia-3 block from the snapshot alone: the size the target maps to (or that Stockfish's own
 * policy applies at this rating), whether the last recommendation carried an answer, that
 * answer's pick probability and WDL, and its inference time — the value the sparkline tracks,
 * one point per recommendation the model answered (not per snapshot, which repeat it).
 */
export function policyBlock(snapshot: PanelSnapshot): PolicyBlock {
	const { strength } = snapshot.settings;
	const target = snapshot.opponent?.derivedTargetElo ?? strength.targetElo;
	const { policy: copy, selection, none } = COPY.engineView;
	const active = usesMaia(target) || usesMaiaPrior(target);
	const rec = snapshot.recommendation;
	const maia = active ? rec?.maia : undefined;
	if (!active)
		return {
			name: copy.inactive,
			pill: { variant: "idle", text: copy.off },
			detail: none,
			latency: none,
			meta: none,
			sampleKey: null,
			sampleMs: null,
			meters: [],
			warning: null,
		};
	const name = copy.name(selection.maiaSizes[maia?.size ?? maiaSizeFor(target)]);
	if (!maia || !rec)
		return {
			name,
			pill: { variant: "idle", text: copy.waiting },
			detail: none,
			latency: none,
			meta: none,
			sampleKey: null,
			sampleMs: null,
			meters: [],
			warning: null,
		};
	const [loss, draw, win] = maia.wdl;
	const used = rec.chosen.source === "maia" && maia.p !== undefined;
	return {
		name,
		pill: { variant: "ok", text: copy.answered },
		detail: used ? copy.wdl(pct(win), pct(draw), pct(loss)) : copy.fallback,
		latency: maia.ms === undefined ? none : copy.latency(String(Math.round(maia.ms))),
		meta: used && maia.p !== undefined ? copy.pick(pct(maia.p)) : none,
		sampleKey: `${rec.fen}:${rec.computedAt}`,
		sampleMs: maia.ms ?? null,
		meters: policyMeters(maia).rows,
		warning: policyHistoryWarning(maia.historyPlies, snapshot.session.ply),
	};
}

function nnueNames(names: readonly string[]): string {
	const short = names.map((n) => n.replace(/\.nnue$/, "")).filter(Boolean);
	return short.length > 0 ? short.join(" + ") : COPY.engine.rows.nnueLoaded;
}

function timeOfDay(timestamp: number): string {
	const d = new Date(timestamp);
	const pad = (n: number): string => (n < TWO_DIGITS ? `0${n}` : String(n));
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sourceLabel(source: string): string {
	try {
		const url = new URL(source);
		return url.pathname.split("/").pop() || url.host;
	} catch {
		return source;
	}
}

function argText(arg: LogEntry["args"][number]): string {
	if (typeof arg === "string") return arg;
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}

async function defaultClipboard(text: string): Promise<void> {
	const clipboard = globalThis.navigator?.clipboard;
	if (!clipboard || typeof clipboard.writeText !== "function")
		throw new Error("clipboard unavailable");
	await clipboard.writeText(text);
}

/**
 * The nps sparkline: a ring of ≤ `LIMITS.npsSparklineSamples` samples drawn as an SVG polyline.
 * Geometry is token-sized here; colours come from `css/views/engine.css` (theme tokens).
 */
function createSparkline(
	host: HTMLElement,
	label: string = COPY.engineView.sparkline,
	capacity: number = LIMITS.npsSparklineSamples
): { push(value: number): void; dispose(): void } {
	const width = capacity * TOKENS.unit;
	const height = TOKENS.space[8];
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "sl-engine__spark-svg");
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("width", String(width));
	svg.setAttribute("height", String(height));
	svg.setAttribute("preserveAspectRatio", "none");
	const area = document.createElementNS(SVG_NS, "polygon");
	area.setAttribute("class", "sl-engine__spark-area");
	const line = document.createElementNS(SVG_NS, "polyline");
	line.setAttribute("class", "sl-engine__spark-line");
	svg.append(area, line);
	host.replaceChildren(svg);
	host.setAttribute("aria-label", label);
	const samples: number[] = [];

	function render(): void {
		const max = Math.max(1, ...samples);
		const step = samples.length > 1 ? width / (samples.length - 1) : 0;
		const points = samples.map((v, i) => {
			const x = samples.length > 1 ? i * step : width;
			const y = height - (v / max) * height;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		line.setAttribute("points", points.join(" "));
		const first = points[0];
		const last = points[points.length - 1];
		area.setAttribute(
			"points",
			first && last
				? [`${first.split(",")[0]},${height}`, ...points, `${last.split(",")[0]},${height}`].join(" ")
				: ""
		);
	}

	return {
		push(value) {
			samples.push(Math.max(0, value));
			if (samples.length > capacity) samples.shift();
			render();
		},
		dispose() {
			svg.remove();
		},
	};
}

export function createEngineView(deps: EngineViewDeps = {}): View {
	const makeLogging = deps.logging ?? ((level: LogLevel) => createLoggingBridge({ level }));
	const clipboard = deps.clipboard ?? defaultClipboard;

	return {
		mount(ctx: ViewContext): Cleanup {
			const { store } = ctx;
			const el = instantiate(html);
			part(el, ".sl-engine__title").textContent = COPY.workspace.engineTitle;
			part(el, ".sl-engine__intro").textContent = COPY.workspace.engineBody;
			const initialLevel =
				ctx.snapshot?.settings.advanced.logLevel ?? DEFAULT_SETTINGS.advanced.logLevel;
			let disposed = false;
			let handsOff = false;
			let attached = false;
			let timingEntries: TimingLogEntry[] = [];
			let timingCleared = false;
			let lastSampleAt = Number.NEGATIVE_INFINITY;
			/** The game tab the debugger commands target (the active tab of this window). */
			let tabId: number | null = null;

			// ── headings & labels ──────────────────────────────────────────────────
			part(el, '[data-part="title-engine"]').textContent = COPY.engineView.sections.engine;
			part(el, '[data-part="title-policy"]').textContent = COPY.engineView.sections.policy;
			part(el, '[data-part="title-executor"]').textContent = COPY.engineView.sections.executor;
			part(el, '[data-part="title-timing"]').textContent = COPY.engineView.sections.timing;
			part(el, '[data-part="title-session"]').textContent = COPY.engineView.sections.session;
			part(el, '[data-part="title-log"]').textContent = COPY.engineView.sections.log;
			part(el, '[data-part="level-label"]').textContent = COPY.engineView.level;
			for (const row of Object.keys(COPY.engineView.rows) as Array<
				keyof typeof COPY.engineView.rows
			>) {
				part(el, `[data-row="${row}"] .sl-engine__key`).textContent = COPY.engineView.rows[row];
			}
			const logEmpty = part(el, ".sl-engine__log-empty");
			logEmpty.textContent = COPY.engineView.logEmpty;
			const consoleEmpty = part(el, ".sl-engine__console-empty");
			consoleEmpty.textContent = COPY.engineView.consoleEmpty;

			// ── parts ──────────────────────────────────────────────────────────────
			const version = part(el, ".sl-engine__version");
			const resources = part(el, ".sl-engine__resources");
			const selection = part(el, ".sl-engine__selection");
			const nps = part(el, ".sl-engine__nps");
			const depth = part(el, ".sl-engine__depth");
			const sparkline = createSparkline(part(el, ".sl-engine__spark:not(.sl-engine__spark--policy)"));
			const statusPill: PillHandle = createPill(part(el, ".sl-engine__status"), {
				variant: "idle",
				icon: "status.idle",
				text: COPY.engine.loading,
			});
			const policyName = part(el, ".sl-engine__policy-name");
			const policyDetail = part(el, ".sl-engine__policy-detail");
			const policyLatency = part(el, ".sl-engine__policy-latency");
			const policyMeta = part(el, ".sl-engine__policy-meta");
			const policySparkline = createSparkline(
				part(el, ".sl-engine__policy-spark"),
				COPY.engineView.policy.sparkline,
				LIMITS.policySparklineSamples
			);
			const policyPill: PillHandle = createPill(part(el, ".sl-engine__policy-status"), {
				variant: "idle",
				icon: "status.idle",
				text: COPY.engineView.policy.off,
			});
			const policyMetersList = part(el, ".sl-engine__policy-meters");
			const policyWarning = part(el, ".sl-engine__policy-warning");
			const meterRows = Object.keys(COPY.engineView.policy.meters) as PolicyMeterRow[];
			const meterCells = new Map<PolicyMeterRow, { row: HTMLElement; value: HTMLElement }>();
			for (const row of meterRows) {
				const rowEl = part(policyMetersList, `[data-meter="${row}"]`);
				part(rowEl, ".sl-engine__key").textContent = COPY.engineView.policy.meters[row];
				meterCells.set(row, { row: rowEl, value: part(rowEl, ".sl-engine__value") });
			}
			let lastPolicySample: string | null = null;
			const valueCell = (row: string): HTMLElement =>
				part(el, `[data-row="${row}"] .sl-engine__value`);
			const debuggerFlag = part(el, '[data-row="debugger"] .sl-engine__flag');
			const timeline = part(el, ".sl-engine__timeline");
			const logRows = part(el, ".sl-engine__log-rows");
			const logPane = part(el, ".sl-engine__log");
			const session = part(el, ".sl-engine__session");
			const levelSelect = part<HTMLSelectElement>(el, ".sl-engine__level");
			const consoleRows = part(el, ".sl-engine__console-rows");
			const consolePane = part(el, ".sl-engine__console");

			// ── commands ───────────────────────────────────────────────────────────
			const dispatch = (type: PanelCommandType): void => {
				store
					.dispatch({ type })
					.catch((error: unknown) => log.warn("engine view: dispatch failed", { type, error }));
			};
			/** The debugger pair is per tab (Task 28): both act on the game tab's executor. */
			const dispatchDebugger = (
				type: typeof MSG.PANEL_DETACH_DEBUGGER | typeof MSG.PANEL_REATTACH_DEBUGGER
			): void => {
				if (tabId === null) {
					log.warn("engine view: no active tab for the command", { type });
					return;
				}
				store
					.dispatch({ type, tabId })
					.catch((error: unknown) => log.warn("engine view: dispatch failed", { type, error }));
			};
			const detach: ButtonHandle = createButton(part(el, '[data-part="detach"]'), {
				label: COPY.engineView.detach,
				variant: "ghost",
				size: "sm",
				icon: "status.detached",
				onClick: () => dispatchDebugger(MSG.PANEL_DETACH_DEBUGGER),
			});
			detach.el.dataset.cmd = "detach";
			const reattach: ButtonHandle = createButton(part(el, '[data-part="reattach"]'), {
				label: COPY.banner.reattach,
				variant: "ghost",
				size: "sm",
				icon: "action.reattach",
				onClick: () => dispatchDebugger(MSG.PANEL_REATTACH_DEBUGGER),
			});
			reattach.el.dataset.cmd = "reattach";
			const copy: ButtonHandle = createButton(part(el, '[data-part="copy"]'), {
				label: COPY.engineView.copy,
				variant: "ghost",
				size: "sm",
				icon: "action.copy",
				onClick: () => {
					clipboard(JSON.stringify(timingEntries, null, 2)).then(
						() => {
							if (!disposed) showToast("success", COPY.engineView.copied);
						},
						(error: unknown) => {
							log.warn("engine view: copy failed", error);
							if (!disposed) showToast("warn", COPY.engineView.copyFailed);
						}
					);
				},
			});
			copy.el.dataset.cmd = "copy";
			const exportButton: ButtonHandle = createButton(part(el, '[data-part="export"]'), {
				label: COPY.engineView.export,
				variant: "ghost",
				size: "sm",
				icon: "action.export",
				onClick: () => {
					// The shell's `open-url` action (bubbling after this) opens it in a new tab; the URL
					// is dropped once the click has bubbled so the (large) payload never lingers in the DOM.
					exportButton.el.dataset.url = `${JSON_DATA_URL_PREFIX};charset=utf-8,${encodeURIComponent(
						JSON.stringify(timingEntries)
					)}`;
					queueMicrotask(() => {
						delete exportButton.el.dataset.url;
					});
				},
			});
			exportButton.el.dataset.cmd = "export";
			exportButton.el.dataset.action = "open-url";
			const clear: ButtonHandle = createButton(part(el, '[data-part="clear"]'), {
				label: COPY.engineView.clear,
				variant: "ghost",
				dangerText: true,
				size: "sm",
				onClick: () => {
					timingEntries = [];
					timingCleared = true;
					renderTimingLog();
					dispatch(MSG.PANEL_CLEAR_TIMING_LOG);
				},
			});
			clear.el.dataset.cmd = "clear";
			const reset: ButtonHandle = createButton(part(el, '[data-part="reset"]'), {
				label: COPY.engineView.reset,
				variant: "ghost",
				dangerText: true,
				size: "sm",
				onClick: () => dispatch(MSG.PANEL_RESET_SESSION),
			});
			reset.el.dataset.cmd = "reset";
			const commands: ButtonHandle[] = [detach, reattach, copy, exportButton, clear, reset];

			function applyCommandState(): void {
				for (const b of commands) b.update({ disabled: handsOff });
				detach.update({ disabled: handsOff || !attached });
				reattach.update({ disabled: handsOff || attached });
				reattach.update({ variant: attached ? "ghost" : "primary" });
			}

			// ── snapshot projection ────────────────────────────────────────────────
			function renderTimeline(execution: ExecutionResult | undefined): void {
				timeline.replaceChildren();
				if (!execution) return;
				for (const phase of execution.timeline) {
					const chip = instantiate(phaseHtml);
					chip.textContent = COPY.engineView.phase(phase.phase, Math.round(phase.endMs - phase.startMs));
					timeline.append(chip);
				}
			}

			function render(snapshot: PanelSnapshot): void {
				const { engine, settings } = snapshot;
				handsOff = isHandsOff(snapshot);
				attached = snapshot.executor.debuggerAttached;
				version.textContent = engine.fallbackFrom
					? `${COPY.engine.rows.version(engine.version, nnueNames(engine.nnue))} · ${COPY.engine.rows.fallback}`
					: COPY.engine.rows.version(engine.version, nnueNames(engine.nnue));
				resources.textContent = COPY.engine.rows.resources(engine.threads, settings.engine.hashMb);
				selection.textContent = selectionModel(snapshot);
				const npsValue = engine.nps ?? snapshot.recommendation?.nps;
				nps.textContent = formatNps(npsValue);
				depth.textContent = COPY.engineView.depth(snapshot.recommendation?.depth ?? 0);
				const p = enginePill(snapshot);
				statusPill.update({
					variant: p.variant,
					icon:
						p.variant === "thinking"
							? "status.thinking"
							: p.variant === "danger"
								? "status.detached"
								: p.variant === "ok"
									? "status.ok"
									: "status.idle",
					text: p.text,
				});
				const now = Date.now();
				if (npsValue !== undefined && now - lastSampleAt >= UI_TIMINGS.sparklineSampleMs) {
					lastSampleAt = now;
					sparkline.push(npsValue);
				}
				const policy = policyBlock(snapshot);
				policyName.textContent = policy.name;
				policyDetail.textContent = policy.detail;
				policyLatency.textContent = policy.latency;
				policyMeta.textContent = policy.meta;
				policyPill.update({
					variant: policy.pill.variant,
					icon: policy.pill.variant === "ok" ? "status.ok" : "status.idle",
					text: policy.pill.text,
				});
				const shown = new Map(policy.meters.map((m) => [m.row, m.value]));
				for (const [row, cells] of meterCells) {
					const value = shown.get(row);
					cells.row.hidden = value === undefined;
					cells.value.textContent = value ?? "";
				}
				policyMetersList.hidden = policy.meters.length === 0;
				policyWarning.hidden = policy.warning === null;
				policyWarning.textContent = policy.warning ?? "";
				if (
					policy.sampleKey !== null &&
					policy.sampleMs !== null &&
					policy.sampleKey !== lastPolicySample
				) {
					lastPolicySample = policy.sampleKey;
					policySparkline.push(policy.sampleMs);
				}

				valueCell("debugger").textContent = attached ? COPY.executor.attached : COPY.executor.detached;
				debuggerFlag.hidden = !attached;
				const site = snapshot.session.site ?? snapshot.site;
				const gameId = snapshot.session.gameId;
				valueCell("target").textContent =
					site && gameId
						? COPY.engineView.target(gameId)
						: site
							? COPY.engineView.site
							: COPY.engineView.none;
				const execution = snapshot.session.lastExecution;
				valueCell("input").textContent = COPY.engineView.inputMode(
					SETTINGS_COPY.options.inputMode[settings.execution.inputMode],
					COPY.engineView.profiles[settings.timing.profile]
				);
				valueCell("last").textContent = execution
					? COPY.engineView.lastAction(
							// Every committed move is a drag, and the word the user reads comes from
							// `copy.ts` (C5) — never from the service worker's own `tier` value.
							COPY.execution.drag,
							seconds(execution.elapsedMs),
							COPY.engineView.outcomes[execution.outcome]
						)
					: COPY.executor.notStarted;
				renderTimeline(execution);
				const raw = snapshot.license.rawStatus ?? snapshot.license.status;
				valueCell("license").textContent = COPY.engineView.licenseVerdict(
					raw,
					snapshot.license.rawStatus !== undefined && raw !== snapshot.license.status
				);
				const measuredTiming = normalizeTimingStats(snapshot.stats);
				session.textContent = COPY.engineView.session(
					snapshot.stats.games,
					snapshot.stats.moves,
					measuredTiming.timingSamples ? seconds(measuredTiming.avgThinkMs) : null
				);
				applyCommandState();
			}

			// ── timing rationale log ───────────────────────────────────────────────
			function appendRationale(entry: TimingLogEntry): void {
				for (const row of rationaleRows(entry)) {
					const rowEl = instantiate(logRowHtml);
					rowEl.dataset.kind = row.kind;
					part(rowEl, ".sl-engine__log-time").textContent = row.time;
					part(rowEl, ".sl-engine__log-kind").textContent = COPY.engine.logKinds[row.kind];
					const lines = part(rowEl, ".sl-engine__log-lines");
					for (const text of row.lines) {
						const line = instantiate(logLineHtml);
						line.textContent = text;
						lines.append(line);
					}
					logRows.append(rowEl);
				}
			}

			function renderTimingLog(): void {
				logRows.replaceChildren();
				for (const entry of timingEntries) appendRationale(entry);
				logEmpty.hidden = timingEntries.length > 0;
				logPane.scrollTop = logPane.scrollHeight;
			}

			function pushTiming(entry: TimingLogEntry): void {
				const existing = timingEntries.findIndex(
					(row) => row.gameId === entry.gameId && row.ply === entry.ply
				);
				if (existing >= 0) {
					timingEntries[existing] = entry;
					renderTimingLog();
					return;
				}
				timingEntries.push(entry);
				if (timingEntries.length > LIMITS.timingLogMax) {
					timingEntries = timingEntries.slice(timingEntries.length - LIMITS.timingLogMax);
					renderTimingLog();
					return;
				}
				appendRationale(entry);
				logEmpty.hidden = true;
				logPane.scrollTop = logPane.scrollHeight;
			}

			store
				.dispatch({ type: MSG.PANEL_EXPORT_TIMING_LOG })
				.then((entries) => {
					if (disposed || timingCleared || !Array.isArray(entries)) return;
					const merged = new Map<string, TimingLogEntry>();
					for (const entry of [...entries, ...timingEntries])
						merged.set(`${entry.gameId}:${entry.ply}`, entry);
					timingEntries = [...merged.values()].slice(-LIMITS.timingLogMax);
					renderTimingLog();
				})
				.catch((error: unknown) => log.debug("engine view: timing log unavailable", error));
			const unsubscribePort = store.onPortMessage((message) => {
				if (message.kind === "timingLog") pushTiming(message.entry);
			});

			// ── live log pane ──────────────────────────────────────────────────────
			const logging = makeLogging(initialLevel);
			for (const level of LOG_LEVELS) {
				const option = instantiate<HTMLOptionElement>(optionHtml);
				option.value = level;
				option.textContent = COPY.engineView.levels[level];
				levelSelect.append(option);
			}
			levelSelect.value = initialLevel;
			levelSelect.setAttribute("aria-label", COPY.engineView.level);

			function appendConsole(entry: LogEntry): void {
				const row = instantiate(consoleRowHtml);
				row.dataset.level = entry.level;
				part(row, ".sl-engine__console-time").textContent = timeOfDay(entry.meta.timestamp);
				part(row, ".sl-engine__console-level").textContent = entry.level;
				part(row, ".sl-engine__console-source").textContent = sourceLabel(entry.meta.source);
				part(row, ".sl-engine__console-text").textContent = entry.args.map(argText).join(" ");
				consoleRows.append(row);
			}

			function renderConsole(): void {
				consoleRows.replaceChildren();
				let shown = 0;
				for (const entry of logging.entries) {
					if (!levelAllows(logging.level, entry.level)) continue;
					appendConsole(entry);
					shown += 1;
				}
				consoleEmpty.hidden = shown > 0;
				consolePane.scrollTop = consolePane.scrollHeight;
			}

			const unsubscribeLogging = logging.subscribe((message: LogStreamMessage) => {
				if (message.kind === "backlog") {
					renderConsole();
					return;
				}
				if (!levelAllows(logging.level, message.entry.level)) return;
				appendConsole(message.entry);
				consoleEmpty.hidden = true;
				while (consoleRows.childElementCount > LIMITS.logRingMax)
					consoleRows.firstElementChild?.remove();
				consolePane.scrollTop = consolePane.scrollHeight;
			});
			const onLevelChange = (): void => {
				const next = levelSelect.value;
				if (!LOG_LEVELS.includes(next as LogLevel)) return;
				logging.setLevel(next as LogLevel);
				renderConsole();
			};
			levelSelect.addEventListener("change", onLevelChange);
			renderConsole();

			// ── mount ──────────────────────────────────────────────────────────────
			mountIcons(el);
			ctx.container.append(el);
			const unsubscribeStore = store.subscribe((snapshot) => {
				if (!disposed) render(snapshot);
			});
			tabsQuery({ active: true, currentWindow: true })
				.then((tabs) => {
					if (disposed) return;
					const id = tabs[0]?.id;
					tabId = typeof id === "number" ? id : null;
				})
				.catch((error: unknown) => log.warn("engine view: tabs.query failed", error));

			return () => {
				if (disposed) return;
				disposed = true;
				unsubscribeStore();
				unsubscribePort();
				unsubscribeLogging();
				levelSelect.removeEventListener("change", onLevelChange);
				logging.dispose();
				sparkline.dispose();
				statusPill.dispose();
				policySparkline.dispose();
				policyPill.dispose();
				for (const b of commands) b.dispose();
				el.remove();
			};
		},
	};
}

export const engineView: View = createEngineView();
