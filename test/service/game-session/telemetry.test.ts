// test/service/game-session/telemetry.test.ts — `MoveWindow`, the §13.2 writer. Two things live here
// that a simulated game cannot reach: the `fork()` a premove's window is (Fix F), and the rule that
// only the writer may say a window was the **owner's** — which is what the model's focus exemption
// keys on, so it is the difference between a property and a coincidence.
import { describe, expect, it } from "bun:test";
import type { MoveWindowClose } from "@service/game-session/telemetry";
import { MoveWindow } from "@service/game-session/telemetry";

const AT = 1_000_000;

function closeArgs(over: Partial<MoveWindowClose> = {}): MoveWindowClose {
	return {
		elapsedMs: 500,
		pointerOffsetPx: 300,
		multiplePieces: false,
		orientationMs: 0,
		multiSelectEligible: false,
		nReasonable: 1,
		at: AT + 2_000,
		...over,
	};
}

describe("MoveWindow.fork (Fix F)", () => {
	it("inherits the period, so the fork's record contains a drag that happened inside it", () => {
		const window = new MoveWindow();
		window.open(AT, false);
		const fork = window.fork(AT + 500);
		const record = fork.close(closeArgs({ elapsedMs: 500, at: AT + 1_500 }));
		// 1500 ms of window around a 500 ms hold — the fork started where the original did, not where
		// it was forked.
		expect(record?.ac.TotalFocusTime).toBe(1_500);
		expect(record?.ac.MoveHoldTime).toBe(500);
	});

	it("inherits the edges seen before the fork", () => {
		const window = new MoveWindow();
		window.open(AT, false);
		window.edge(false, AT + 100); // the owner clicked away before the premove was sent
		const fork = window.fork(AT + 500);
		const record = fork.close(closeArgs({ at: AT + 1_100, ownerOwnsWindow: true }));
		expect(record?.ac.BlurCount).toBe(1);
		expect(record?.ac.DidBlurOnOpponentTurn).toBe(true);
		expect(record?.ac.TotalBlurTime).toBe(1_000);
	});

	it("inherits `ownTurn`, so a fork of our own window is still ours", () => {
		const window = new MoveWindow();
		window.open(AT, true); // our turn
		const fork = window.fork(AT + 500);
		fork.edge(false, AT + 600);
		const record = fork.close(closeArgs({ at: AT + 1_000, ownerOwnsWindow: true }));
		// The blur is flagged on *our* turn and the owner's-window bit is refused: a caller cannot
		// smuggle the model's focus exemption through a fork of a window we own.
		expect(record?.ac.DidBlurOnOwnTurn).toBe(true);
		expect(record?.ac.DidBlurOnOpponentTurn).toBe(false);
		expect(record?.ownerOwnsWindow).toBeUndefined();
	});

	it("leaves the original open — closing the fork must not consume the next move's window", () => {
		const window = new MoveWindow();
		window.open(AT, false);
		const fork = window.fork(AT + 500);
		expect(fork.close(closeArgs())).not.toBeNull();
		expect(window.isOpen()).toBe(true);
		expect(window.close(closeArgs({ elapsedMs: 900, at: AT + 3_000 }))?.ac.MoveHoldTime).toBe(900);
	});

	it("opens at the fallback when the window it forks from is already closed", () => {
		const window = new MoveWindow();
		window.open(AT, false);
		window.close(closeArgs()); // a late report for the previous move closed it
		expect(window.isOpen()).toBe(false);
		const fork = window.fork(AT + 4_000);
		// Without the fallback this fork would be closed, and a closed window produces no record at
		// all — a played move with `actualMs` and no §13.2 blob.
		expect(fork.isOpen()).toBe(true);
		const record = fork.close(closeArgs({ elapsedMs: 400, at: AT + 5_000, ownerOwnsWindow: true }));
		expect(record).not.toBeNull();
		expect(record?.ac.TotalFocusTime).toBe(1_000);
		expect(record?.ownerOwnsWindow).toBe(true);
	});

	it("a closed window yields no second record, which is why the caller must not close a fork twice", () => {
		const window = new MoveWindow();
		window.open(AT, false);
		const fork = window.fork(AT);
		expect(fork.close(closeArgs())).not.toBeNull();
		expect(fork.close(closeArgs())).toBeNull();
	});
});

describe("MoveWindow: whose window was it", () => {
	it("records the owner's-window bit only when the caller says so", () => {
		const window = new MoveWindow();
		window.open(AT, false);
		expect(window.close(closeArgs())?.ownerOwnsWindow).toBeUndefined();
		window.open(AT, false);
		expect(window.close(closeArgs({ ownerOwnsWindow: true }))?.ownerOwnsWindow).toBe(true);
	});

	it("refuses it for a window opened on our own turn, whatever the caller claims", () => {
		const window = new MoveWindow();
		window.open(AT, true);
		expect(window.close(closeArgs({ ownerOwnsWindow: true }))?.ownerOwnsWindow).toBeUndefined();
	});
});
