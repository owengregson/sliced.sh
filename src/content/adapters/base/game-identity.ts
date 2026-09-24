/**
 * Game identity for a page whose URL may not name its game (chess.com `/play/computer`). The
 * serial advances when the board is replaced or reset, or a finished game becomes active again —
 * the latter also covers aborted one-ply games and a new opening that skips ply zero. It never
 * changes as plies accumulate.
 */
export class GameIdentity {
	private serial = 0;
	private board: Element | null = null;
	private ply = -1;
	private ended = false;

	/** Changes for a new board/game, independently of a route changing around the old board. */
	get generation(): number {
		return this.serial;
	}

	/** Account for one reading of `board` at `ply`; call once per `read()`. */
	advance(board: Element | null, ply: number, ended: boolean, active: boolean): void {
		const restarted = this.ended && !ended && active;
		const replaced = board !== this.board && this.board !== null;
		if (board !== this.board) {
			this.board = board;
		}
		const reset = ply === 0 && this.ply >= 2;
		if (replaced || reset || restarted) this.serial++;
		this.ended = ended || (this.ended && !replaced && !reset && !restarted);
		this.ply = ply;
	}

	/** The identity of a game the URL does not name: `<path>#<serial>`. */
	pathKey(pathname: string): string {
		return `${pathname.replace(/\W+/g, "-")}#${this.serial}`;
	}
}
