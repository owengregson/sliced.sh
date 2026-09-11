import { expect, it } from "bun:test";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingLogEntry } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { ctx } from "./helpers";

const meta: GameMeta = {
	gameId: "live-settings",
	targetElo: 1650,
	profile: "balanced",
	baseSec: 0,
	incSec: 0,
	site: "chesscom",
};
const settings = { ...DEFAULT_SETTINGS.timing, respectBudget: false, speedScale: 1 };
const position = (ply: number) => ctx({ ply, baseSec: 0, incSec: 0, myClockMs: 0, oppClockMs: 0 });
function model() {
	const entries: TimingLogEntry[] = [];
	const m = new TimingModel(new V1ParametricHead(), { ...settings }, createRng(7), {
		onEntry: (entry) => entries.push(entry),
	});
	m.startGame(meta);
	return { m, entries };
}

it("unrelated settings updates preserve the timing state, current plan, and next random samples", () => {
	const a = model();
	const b = model();
	for (let ply = 20; ply < 24; ply++) {
		const pa = a.m.planMove(position(ply));
		const pb = b.m.planMove(position(ply));
		a.m.observe(pa.thinkMs, pa);
		b.m.observe(pb.thinkMs, pb);
	}
	const state = a.m.state;
	const before = structuredClone(state);
	const plan = state.lastPlan;
	const persona = a.m.persona;
	a.m.updateSettings({ ...settings }, meta);
	expect(a.m.state).toBe(state);
	expect(state).toEqual(before);
	expect(state.lastPlan).toBe(plan);
	expect(a.m.persona).toBe(persona);
	for (let ply = 24; ply < 28; ply++)
		expect(a.m.planMove(position(ply))).toEqual(b.m.planMove(position(ply)));
});

it("a live speed adjustment changes future planning without changing the pending plan or receipt", () => {
	const a = model();
	const b = model();
	const pending = a.m.planMove(position(20));
	const controlPending = b.m.planMove(position(20));
	const saved = structuredClone(pending);
	a.m.updateSettings({ ...settings, speedScale: 0.5 }, meta);
	expect(pending).toEqual(saved);
	a.m.observe(pending.thinkMs, pending);
	b.m.observe(controlPending.thinkMs, controlPending);
	expect(a.entries[0]?.actualMs).toBe(pending.thinkMs);
	let faster = 0;
	for (let ply = 21; ply < 31; ply++) {
		const pa = a.m.planMove(position(ply));
		const pb = b.m.planMove(position(ply));
		if (pa.mode === "normal" && pb.mode === "normal" && pb.thinkMs > 2000) {
			expect(pa.thinkMs).toBeLessThan(pb.thinkMs);
			faster++;
		}
	}
	expect(faster).toBeGreaterThan(2);
});

it("live persona and tendency changes retain played history while changing future distribution knobs", () => {
	const { m } = model();
	const plan = m.planMove(position(20));
	m.observe(plan.thinkMs, plan);
	const before = structuredClone(m.state);
	const oldPersona = m.persona;
	m.updateSettings(
		{ ...settings, varianceScale: 0.5, premoveTendency: 1, longThinkFrequency: 0 },
		{ profile: "blitz", targetElo: 2200 }
	);
	expect(m.state.myThinkMs).toEqual(before.myThinkMs);
	expect(m.state.plannedMs).toEqual(before.plannedMs);
	expect(m.state.eps).toBe(before.eps);
	expect(m.state.tilt).toBe(before.tilt);
	expect(m.state.lastPlan).toBe(plan);
	expect(m.state.knobs.sigmaScale).toBe(0.5);
	expect(m.state.knobs.piOffset).toBeGreaterThan(before.knobs.piOffset);
	expect(m.state.knobs.lambdaScale).toBe(0);
	expect(m.persona).not.toEqual(oldPersona);
});
