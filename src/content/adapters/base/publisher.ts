/**
 * Snapshot publication: the one path every reading the adapter hands out or delivers passes
 * through. `prime()` records the page's state silently (subscribers get changes, not the initial
 * position); `apply()` turns each later reading into the edges subscribers see — page-kind
 * changes, game starts, position snapshots (deduped, with the republish triggers below), and game
 * ends.
 */

import { turnFieldOf } from "@core/chess/fen";
import { log } from "@core/logger";
import type {
	Color,
	GameResult,
	PageKind,
	PositionSnapshot,
	Site,
	TimeControl,
} from "@typedefs/game";
import type { AdapterPositionSnapshot, AdapterReading } from "../contract";
import { ColourAuthority } from "./colour-authority";
import { Emitter } from "./emitter";
import { TimeControlProbe, type TimeControlProbeHost } from "./time-control-probe";

export interface PublisherHost extends TimeControlProbeHost {
	readonly site: Site;
	/** The site adapter's raw reading (`null` = unstable, retry later). */
	read(): AdapterReading | null;
	detectPageKind(): PageKind;
	/** The colour as the *site* states it (`getPlayingAs()`), as opposed to as the board renders it. */
	authoritativeColour(): Color | null;
	/** Run (and log) the site self-check. */
	probe(): void;
}

function moveMetadata(snapshot: AdapterPositionSnapshot): string {
	return JSON.stringify([snapshot.ply, snapshot.lastMove ?? null, snapshot.moveHistory ?? null]);
}

function clocksDiffer(
	last: PositionSnapshot["clocks"] | null,
	clocks: PositionSnapshot["clocks"]
): boolean {
	return (
		last === null ||
		last.w.ms !== clocks.w.ms ||
		last.w.running !== clocks.w.running ||
		last.b.ms !== clocks.b.ms ||
		last.b.running !== clocks.b.running
	);
}

export class SnapshotPublisher {
	readonly position = new Emitter<[AdapterPositionSnapshot]>();
	readonly pageKind = new Emitter<[]>();
	readonly gameStart = new Emitter<[]>();
	readonly gameEnd = new Emitter<[GameResult]>();
	private readonly colour: ColourAuthority;
	private readonly timeControlProbe: TimeControlProbe;
	private lastPageKind: PageKind | null = null;
	private lastKey: string | null = null;
	private lastMoveMetadata = "";
	/** Last delivered site reading; DOM churn with unchanged clocks is not a new snapshot. */
	private lastClocks: PositionSnapshot["clocks"] | null = null;
	/**
	 * The time control of the last reading delivered, for the same reason as `lastColor`: the site
	 * answers `timeControl.get()` only once the game has actually *started* — a game "not yet
	 * started" answers `null` while its clocks already read `10:00` (owner's capture, 2026-09-09)
	 * — and by then the position has not moved, so the dedupe key is identical and the session
	 * would plan the whole first move as `untimed`: classical motor profile, no premoves, a 7.5 s
	 * think and every clock-pressure term bypassed. Learning it is a change worth delivering.
	 */
	private lastTimeControl: TimeControl | null = null;
	private lastGameKey: string | null = null;
	private lastGameOver = false;
	private isPrimed = false;

	constructor(private readonly host: PublisherHost) {
		this.colour = new ColourAuthority(() => host.site);
		this.timeControlProbe = new TimeControlProbe(host);
	}

	get primed(): boolean {
		return this.isPrimed;
	}

	/**
	 * Every reading this class hands out or publishes, with the one invariant that must hold of
	 * every published `PositionSnapshot`: **`sideToMove` is the turn field of the `fen` beside it.**
	 *
	 * It lives here rather than only in the adapter because this is the single place every snapshot
	 * passes through — `readSnapshot()` (the content script's first publish), `prime()` and
	 * `apply()`. A site adapter that derives the two from different ladders, as the chess.com one
	 * does (bridge → clock → move-list parity against bridge → replay → DOM), can answer
	 * `sideToMove: "b"` beside a FEN that says white; `GameSession.myTurn` reads `sideToMove` while
	 * every search, plan and mark downstream is for whoever the FEN says is to move, so the
	 * contradiction is what makes the assistant recommend the opponent's move and call it ours
	 * (owner's live game, 2026-09-10). chess.com's `reconciledTurn` settles it as it reads, where
	 * the dedupe key is built from the same value; this is the backstop for every adapter.
	 *
	 * The corrected turn is **appended to the dedupe key**. The key is the subclass's own string and
	 * normally embeds the turn it published, so correcting one without the other would let two
	 * different positions share a key; appending keeps the key a function of what is actually
	 * published without this class having to know the subclass's format.
	 *
	 * `turnFieldOf`, not `sideToMove`: see the note on the former — a strict parse would answer
	 * `null` for a FEN with one malformed field and silently leave the contradiction in place.
	 */
	reading(): AdapterReading | null {
		const raw = this.host.read();
		if (raw === null) return null;
		const myColor = this.colour.stated(raw.snapshot.myColor, () => this.host.authoritativeColour());
		const reading =
			myColor === raw.snapshot.myColor ? raw : { ...raw, snapshot: { ...raw.snapshot, myColor } };
		const turn = turnFieldOf(reading.snapshot.fen);
		if (turn === null || turn === reading.snapshot.sideToMove) return reading;
		log.warn("adapter.turnInvariantViolated", {
			site: this.host.site,
			fenTurn: turn,
			sideToMove: reading.snapshot.sideToMove,
		});
		return {
			...reading,
			key: `${reading.key}|${turn}`,
			snapshot: { ...reading.snapshot, sideToMove: turn },
		};
	}

	/** Record the current state without firing (subscribers get changes, not the initial position). */
	prime(): void {
		const reading = this.reading();
		if (!reading) return;
		this.isPrimed = true;
		this.lastKey = reading.key;
		this.lastMoveMetadata = moveMetadata(reading.snapshot);
		this.colour.baseline(reading.snapshot.myColor);
		this.lastTimeControl = reading.snapshot.timeControl ?? null;
		this.lastClocks = reading.snapshot.clocks;
		this.lastGameKey = reading.gameKey;
		this.lastGameOver = reading.gameOver !== null;
		this.timeControlProbe.arm(reading);
	}

	/** Read the page once and deliver whatever changed. */
	apply(): void {
		if (this.host.destroyed()) return;
		const pageKind = this.host.detectPageKind();
		if (pageKind !== this.lastPageKind) {
			this.lastPageKind = pageKind;
			this.pageKind.emit();
		}
		const reading = this.reading();
		if (!reading) return; // unstable: the next mutation re-triggers
		if (!this.isPrimed) {
			this.prime();
			return;
		}
		const gameChanged = this.lastGameKey !== null && reading.gameKey !== this.lastGameKey;
		if (gameChanged) {
			this.lastGameKey = reading.gameKey;
			// An SPA destination's clock cannot republish the old, unchanged board as a new game.
			// Baseline it now so the following bridge callback does not leak that clock-only change.
			this.lastClocks = reading.snapshot.clocks;
			this.lastGameOver = false;
			this.timeControlProbe.newGame();
			this.colour.newGame();
			this.gameStart.emit();
			this.host.probe();
		}
		// The colour lane (`ColourAuthority`): a correction past the per-game cap withholds the
		// colour, and `reading` was built before that decision, so the withhold is applied to what
		// is published here.
		this.colour.enforceCap(this.host.authoritativeColour());
		const snapshot = this.colour.publishable(reading.snapshot);
		const colour = this.colour.triggers(snapshot.myColor, gameChanged);
		// Same shape as a colour learned from nothing, same reason (§4.3): the time control arrives
		// after the first reading of the game it belongs to, on a position that has not moved.
		const timeControlLearned =
			!gameChanged && this.lastTimeControl === null && reading.snapshot.timeControl !== undefined;
		this.lastTimeControl = reading.snapshot.timeControl ?? null;
		const metadata = moveMetadata(snapshot);
		const clocks = snapshot.clocks;
		const clockChanged = clocksDiffer(this.lastClocks, clocks);
		if (
			reading.key !== this.lastKey ||
			metadata !== this.lastMoveMetadata ||
			colour.changed ||
			colour.withdrawn ||
			colour.learned ||
			timeControlLearned ||
			(!gameChanged && clockChanged)
		) {
			this.lastKey = reading.key;
			this.lastMoveMetadata = metadata;
			this.lastClocks = clocks;
			// What the session has actually been *told* advances only with a delivery.
			this.colour.deliver(snapshot.myColor);
			this.position.emit(snapshot);
		}
		this.timeControlProbe.arm(reading);
		const over = reading.gameOver !== null;
		if (over && !this.lastGameOver) {
			this.gameEnd.emit(reading.gameOver ?? "*");
		}
		this.lastGameOver = over;
	}

	/** Stop the time-control re-ask timer. */
	dispose(): void {
		this.timeControlProbe.dispose();
	}

	clearSubscribers(): void {
		this.position.clear();
		this.pageKind.clear();
		this.gameStart.clear();
		this.gameEnd.clear();
	}
}
