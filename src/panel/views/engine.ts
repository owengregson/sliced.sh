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
import { type LogStreamMessage, MSG, type PanelSnapshot } from "@core/constants/messages";
import { UI_TIMINGS } from "@core/constants/ui";
import { LOG_LEVELS, type LogEntry, levelAllows, log } from "@core/logger";
import { TOKENS } from "@design/tokens.generated";
import type { ExecutionResult } from "@typedefs/game";
import type { LogLevel } from "@typedefs/settings";
import type { TimingLogEntry } from "@typedefs/timing";
import { JSON_DATA_URL_PREFIX } from "../actions";
import { type ButtonHandle, createButton } from "../components/button";
import { createPill, type PillHandle, type PillVariant } from "../components/pill";
import { showToast } from "../components/toast";
import { COPY } from "../copy";
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
			COPY.engineView.rationale.base(entry.alloc.toFixed(1), entry.mode, persona),
			...entry.topTerms.map(([name, value]) =>
				COPY.engineView.rationale.term(name, `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}`)
			),
			COPY.engineView.rationale.factors(entry.comp.toFixed(2), entry.eps.toFixed(2)),
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
function createSparkline(host: HTMLElement): { push(nps: number): void; dispose(): void } {
	const width = LIMITS.npsSparklineSamples * TOKENS.unit;
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
	host.setAttribute("aria-label", COPY.engineView.sparkline);
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
		push(nps) {
			samples.push(Math.max(0, nps));
			if (samples.length > LIMITS.npsSparklineSamples) samples.shift();
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
			let lastSampleAt = Number.NEGATIVE_INFINITY;
			/** The game tab the debugger commands target (the active tab of this window). */
			let tabId: number | null = null;

			// ── headings & labels ──────────────────────────────────────────────────
			part(el, '[data-part="title-engine"]').textContent = COPY.engineView.sections.engine;
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
			const nps = part(el, ".sl-engine__nps");
			const depth = part(el, ".sl-engine__depth");
			const sparkline = createSparkline(part(el, ".sl-engine__spark"));
			const statusPill: PillHandle = createPill(part(el, ".sl-engine__status"), {
				variant: "idle",
				icon: "status.idle",
				text: COPY.engine.loading,
			});
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
				version.textContent = COPY.engine.rows.version(engine.version, nnueNames(engine.nnue));
				resources.textContent = COPY.engine.rows.resources(engine.threads, settings.engine.hashMb);
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
				// Every committed move is a drag (there is no click-to-move), so the row names the
				// timing profile against the one input method the hand has.
				valueCell("input").textContent = COPY.engineView.inputMode(
					COPY.execution.drag,
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
				session.textContent = COPY.engineView.session(
					snapshot.stats.games,
					snapshot.stats.moves,
					seconds(snapshot.stats.avgThinkMs)
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
					if (disposed || !Array.isArray(entries)) return;
					timingEntries = entries.slice(-LIMITS.timingLogMax).concat(timingEntries);
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
				for (const b of commands) b.dispose();
				el.remove();
			};
		},
	};
}

export const engineView: View = createEngineView();
