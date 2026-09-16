// test/service/engine-controller-max-strength.test.ts — the playing engine's own options follow the
// session's active target into max-strength mode (owner, 2026-09-15: "maximal performance") and
// back out, applied before the request's own search on the routed (production) path.
import { describe, expect, it } from "bun:test";
import { LIMITS } from "@core/constants/limits";
import { MAX_STRENGTH } from "@core/constants/max-strength";
import { AnalysisCache } from "@core/engine/analysis-cache";
import type { AnalysisRequest } from "@core/engine/types";
import { UciEngine } from "@core/engine/uci-client";
import { EngineController } from "@service/engine-controller";
import { DEFAULT_SETTINGS, type Settings } from "@typedefs/settings";
import { FakeEngineTransport, FakeScheduler, flush } from "../fakes/engine-transport";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const STORED_HASH = 32;

async function rig() {
	const t = new FakeEngineTransport();
	const sched = new FakeScheduler();
	const eng = new UciEngine(t, { scheduler: sched.scheduler });
	await eng.init();
	// The full network at every target, so only the options can change between requests.
	const settings: Settings = {
		...DEFAULT_SETTINGS,
		strength: { ...DEFAULT_SETTINGS.strength, targetElo: 1500 },
		engine: { ...DEFAULT_SETTINGS.engine, nnue: "big", hashMb: STORED_HASH },
	};
	const ctrl = new EngineController(eng, {
		getSettings: () => Promise.resolve(settings),
		onSettingsChanged: () => () => {},
		env: { hardwareConcurrency: 8, sab: true },
		cache: new AnalysisCache(),
		now: sched.nowFn,
		configureVariant: () => Promise.resolve(),
	});
	await ctrl.ready;
	await ctrl.init();
	await flush();
	return { t, ctrl };
}

function request(id: string, targetElo: number): AnalysisRequest {
	return {
		id,
		fen: START,
		multiPv: 1,
		limit: { movetimeMs: 1_000, depth: MAX_STRENGTH.searchDepth },
		targetElo,
		priority: "move",
	};
}

describe("EngineController options in max-strength mode", () => {
	it("sets the max-strength hash before a max request's search, and the stored hash after it", async () => {
		const { t, ctrl } = await rig();
		const hashLines = () => t.sent.filter((line) => line.startsWith("setoption name Hash"));
		const goAt = (from: number) => t.sent.findIndex((line, i) => i >= from && line.startsWith("go "));
		expect(hashLines().at(-1)).toBe(`setoption name Hash value ${STORED_HASH}`);

		const sentBefore = t.sent.length;
		const max = ctrl.analyse(request("max", LIMITS.eloMax));
		await flush();
		const maxHash = t.sent.indexOf(`setoption name Hash value ${MAX_STRENGTH.hashMb}`, sentBefore);
		expect(maxHash).toBeGreaterThanOrEqual(sentBefore);
		expect(goAt(sentBefore)).toBeGreaterThan(maxHash);
		t.feed("info depth 20 multipv 1 score cp 20 nodes 1 nps 1 time 1 pv e2e4", "bestmove e2e4");
		expect((await max.result).status).toBe("complete");
		expect(ctrl.status().options?.Hash).toBe(MAX_STRENGTH.hashMb);

		// Still max strength: nothing is re-sent.
		const again = t.sent.length;
		const second = ctrl.analyse({
			...request("max-2", LIMITS.eloMax),
			fen: `${START.slice(0, -1)}2`,
		});
		await flush();
		expect(t.sent.slice(again).some((line) => line.startsWith("setoption name Hash"))).toBe(false);
		t.feed("info depth 20 multipv 1 score cp 20 nodes 1 nps 1 time 1 pv d2d4", "bestmove d2d4");
		await second.result;

		// Below the ceiling again: the stored hash returns before the next search.
		const below = t.sent.length;
		const next = ctrl.analyse({
			...request("below", LIMITS.eloMax - 1),
			limit: { movetimeMs: 500, depth: 30 },
		});
		await flush();
		const storedHash = t.sent.indexOf(`setoption name Hash value ${STORED_HASH}`, below);
		expect(storedHash).toBeGreaterThanOrEqual(below);
		expect(goAt(below)).toBeGreaterThan(storedHash);
		t.feed("info depth 20 multipv 1 score cp 20 nodes 1 nps 1 time 1 pv g1f3", "bestmove g1f3");
		await next.result;
		expect(ctrl.status().options?.Hash).toBe(STORED_HASH);
	});

	it("leaves the options alone for a request without a target", async () => {
		const { t, ctrl } = await rig();
		const before = t.sent.length;
		const { targetElo: _unused, ...untargeted } = request("none", LIMITS.eloMax);
		const handle = ctrl.analyse(untargeted);
		await flush();
		expect(t.sent.slice(before).some((line) => line.startsWith("setoption name Hash"))).toBe(false);
		t.feed("info depth 20 multipv 1 score cp 20 nodes 1 nps 1 time 1 pv e2e4", "bestmove e2e4");
		await handle.result;
	});
});
