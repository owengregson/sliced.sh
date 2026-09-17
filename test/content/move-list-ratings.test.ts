import { expect, it } from "bun:test";
import { BRIDGE_KINDS } from "@content/adapters/adapter";
import { createMoveListRatings } from "@content/move-list-ratings";
import type { MoveListRating } from "@core/constants/move-quality";
import { FakeBridge } from "./adapters/helpers";

it("keeps log ratings through board clears, replays after ready and rejects old games", () => {
	const bridge = new FakeBridge();
	const log = createMoveListRatings(bridge);
	const rating: MoveListRating = { ply: 0, san: "e4", quality: "best" };
	log.setGame("one");
	log.setEnabled(true);
	log.apply({ kind: "moveListRating", gameId: "one", rating });
	expect(bridge.calls.at(-1)?.payload).toEqual([rating]);
	expect(log.apply({ kind: "clearEffects" })).toBe(false);
	bridge.emit(BRIDGE_KINDS.ready, {});
	expect(bridge.calls.at(-1)?.payload).toEqual([rating]);
	log.setEnabled(false);
	expect(bridge.calls.at(-1)?.payload).toEqual([]);
	log.setEnabled(true);
	expect(bridge.calls.at(-1)?.payload).toEqual([rating]);
	log.setGame("two");
	log.apply({ kind: "moveListRating", gameId: "one", rating });
	expect(bridge.calls.at(-1)?.payload).toEqual([]);
	log.dispose();
	bridge.emit(BRIDGE_KINDS.ready, {});
	expect(bridge.calls.at(-1)?.payload).toEqual([]);
});
