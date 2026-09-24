/** Chess constants shared across realms (C1). */

/** The standard starting position. */
export const CHESS_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/**
 * Positions whose legal-move list `legalMoves` keeps (oldest evicted first): one position is asked
 * about by the timing features, the search budget, Maia's budget and the premove gates in the
 * same turn, and every answer costs a full chess.js generation with SAN.
 */
export const LEGAL_MOVES_CACHE_SIZE = 64;
