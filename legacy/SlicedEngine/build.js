'use strict';
(() => {
    function a(r) {
        var i = _modules[r];
        if (void 0 !== i) return i.exports;
        var n = _modules[r] = {
            exports: {}
        };
        return s[r](n, n.exports, a), n.exports
    }
    var s = {
        437: (module, exports, __webpack_require__) => {
            var __WEBPACK_AMD_DEFINE_RESULT__;
            var Chess = function (path) {
                function clear(state) {
                    if (void 0 === state) state = false;
                    board = new Array(128);
                    kings = {
                        w: EMPTY,
                        b: EMPTY
                    };
                    turn = WHITE;
                    castling = {
                        w: 0,
                        b: 0
                    };
                    ep_square = EMPTY;
                    half_moves = 0;
                    move_number = 1;
                    history = [];
                    if (!state) header = {};
                    parts = {};
                    update_setup(generate_fen())
                }

                function remove() {
                    var reversed_history = [];
                    var env = {};
                    var promise = function (i) {
                        if (i in parts) env[i] = parts[i]
                    };
                    for (; history.length > 0;) reversed_history.push(undo_move());
                    promise(generate_fen());
                    for (; reversed_history.length > 0;) {
                        make_move(reversed_history.pop());
                        promise(generate_fen())
                    }
                    parts = env
                }

                function reset() {
                    load(DEFAULT_POSITION)
                }

                function load(fen, state) {
                    if (void 0 === state) state = false;
                    var tokens = fen.split(/\s+/);
                    var title = tokens[0];
                    var square = 0;
                    if (!validate_fen(fen).valid) return false;
                    clear(state);
                    var i = 0;
                    for (; i < title.length; i++) {
                        var piece =
                            title.charAt(i);
                        if ("/" === piece) square = square + 8;
                        else if (-1 !== "0123456789".indexOf(piece)) square = square + parseInt(piece, 10);
                        else {
                            var color = piece < "a" ? WHITE : BLACK;
                            put({
                                type: piece.toLowerCase(),
                                color: color
                            }, algebraic(square));
                            square++
                        }
                    }
                    return turn = tokens[1], tokens[2].indexOf("K") > -1 && (castling.w |= BITS.KSIDE_CASTLE), tokens[2].indexOf("Q") > -1 && (castling.w |= BITS.QSIDE_CASTLE), tokens[2].indexOf("k") > -1 && (castling.b |= BITS.KSIDE_CASTLE), tokens[2].indexOf("q") > -1 && (castling.b |= BITS.QSIDE_CASTLE), ep_square = "-" ===
                        tokens[3] ? EMPTY : SQUARES[tokens[3]], half_moves = parseInt(tokens[4], 10), move_number = parseInt(tokens[5], 10), update_setup(generate_fen()), true
                }

                function validate_fen(fen) {
                    var words = fen.split(/\s+/);
                    if (6 !== words.length) return {
                        valid: false,
                        error_number: 1,
                        error: "FEN string must contain six space-delimited fields."
                    };
                    if (isNaN(words[5]) || parseInt(words[5], 10) <= 0) return {
                        valid: false,
                        error_number: 2,
                        error: "6th field (move number) must be a positive integer."
                    };
                    if (isNaN(words[4]) || parseInt(words[4], 10) < 0) return {
                        valid: false,
                        error_number: 3,
                        error: "5th field (half move counter) must be a non-negative integer."
                    };
                    if (!/^(-|[abcdefgh][36])$/.test(words[3])) return {
                        valid: false,
                        error_number: 4,
                        error: "4th field (en-passant square) is invalid."
                    };
                    if (!/^(KQ?k?q?|Qk?q?|kq?|q|-)$/.test(words[2])) return {
                        valid: false,
                        error_number: 5,
                        error: "3rd field (castling availability) is invalid."
                    };
                    if (!/^(w|b)$/.test(words[1])) return {
                        valid: false,
                        error_number: 6,
                        error: "2nd field (side to move) is invalid."
                    };
                    var s = words[0].split("/");
                    if (8 !== s.length) return {
                        valid: false,
                        error_number: 7,
                        error: "1st field (piece positions) does not contain 8 '/'-delimited rows."
                    };
                    var i = 0;
                    for (; i < s.length; i++) {
                        var extraOffset_Y = 0;
                        var p = false;
                        var j = 0;
                        for (; j < s[i].length; j++)
                            if (isNaN(s[i][j])) {
                                if (!/^[prnbqkPRNBQK]$/.test(s[i][j])) return {
                                    valid: false,
                                    error_number: 9,
                                    error: "1st field (piece positions) is invalid [invalid piece]."
                                };
                                extraOffset_Y = extraOffset_Y + 1;
                                p = false
                            } else {
                                if (p) return {
                                    valid: false,
                                    error_number: 8,
                                    error: "1st field (piece positions) is invalid [consecutive numbers]."
                                };
                                extraOffset_Y = extraOffset_Y + parseInt(s[i][j], 10);
                                p = true
                            } if (8 !== extraOffset_Y) return {
                            valid: false,
                            error_number: 10,
                            error: "1st field (piece positions) is invalid [row too large]."
                        }
                    }
                    return "3" ==
                        words[3][1] && "w" == words[1] || "6" == words[3][1] && "b" == words[1] ? {
                            valid: false,
                            error_number: 11,
                            error: "Illegal en-passant square"
                        } : {
                            valid: true,
                            error_number: 0,
                            error: "No errors."
                        }
                }

                function generate_fen() {
                    var _titleinput = 0;
                    var id = "";
                    var i = SQUARES.a8;
                    for (; i <= SQUARES.h1; i++) {
                        if (null == board[i]) _titleinput++;
                        else {
                            if (_titleinput > 0) {
                                id = id + _titleinput;
                                _titleinput = 0
                            }
                            var color = board[i].color;
                            var s = board[i].type;
                            id = id + (color === WHITE ? s.toUpperCase() : s.toLowerCase())
                        }
                        if (i + 1 & 136) {
                            if (_titleinput > 0) id = id + _titleinput;
                            if (i !==
                                SQUARES.h1) id = id + "/";
                            _titleinput = 0;
                            i = i + 8
                        }
                    }
                    var cflags = "";
                    if (castling.w & BITS.KSIDE_CASTLE) cflags = cflags + "K";
                    if (castling.w & BITS.QSIDE_CASTLE) cflags = cflags + "Q";
                    if (castling.b & BITS.KSIDE_CASTLE) cflags = cflags + "k";
                    if (castling.b & BITS.QSIDE_CASTLE) cflags = cflags + "q";
                    cflags = cflags || "-";
                    var sig = ep_square === EMPTY ? "-" : algebraic(ep_square);
                    return [id, turn, cflags, sig, half_moves, move_number].join(" ")
                }

                function set_header(args) {
                    var i = 0;
                    for (; i < args.length; i = i + 2)
                        if ("string" == typeof args[i] && "string" == typeof args[i + 1]) header[args[i]] =
                            args[i + 1];
                    return header
                }

                function update_setup(fen) {
                    if (!(history.length > 0))
                        if (fen !== DEFAULT_POSITION) {
                            header.SetUp = "1";
                            header.FEN = fen
                        } else {
                            delete header.SetUp;
                            delete header.FEN
                        }
                }

                function get(i) {
                    var piece = board[SQUARES[i]];
                    return piece ? {
                        type: piece.type,
                        color: piece.color
                    } : null
                }

                function put(piece, square) {
                    if (!("type" in piece) || !("color" in piece)) return false;
                    if (-1 === "pnbrqkPNBRQK".indexOf(piece.type.toLowerCase())) return false;
                    if (!(square in SQUARES)) return false;
                    var sq = SQUARES[square];
                    return (piece.type !=
                        KING || kings[piece.color] == EMPTY || kings[piece.color] == sq) && (board[sq] = {
                        type: piece.type,
                        color: piece.color
                    }, piece.type === KING && (kings[piece.color] = sq), update_setup(generate_fen()), true)
                }

                function build_move(board, from, to, flags, promotion) {
                    var move = {
                        color: turn,
                        from: from,
                        to: to,
                        flags: flags,
                        piece: board[from].type
                    };
                    return promotion && (move.flags |= BITS.PROMOTION, move.promotion = promotion), board[to] ? move.captured = board[to].type : flags & BITS.EP_CAPTURE && (move.captured = PAWN), move
                }

                function generate_moves(options) {
                    function add_move(board,
                        moves, from, to, flags) {
                        if (board[from].type !== PAWN || 0 !== rank(to) && 7 !== rank(to)) moves.push(build_move(board, from, to, flags));
                        else {
                            var keys = ["q", "r", "b", "n"];
                            var i = 0;
                            var l = keys.length;
                            for (; i < l; i++) moves.push(build_move(board, from, to, flags, keys[i]))
                        }
                    }
                    var moves = [];
                    var us = turn;
                    var them = swap_color(us);
                    var second_rank = {
                        b: 1,
                        w: 6
                    };
                    var first_sq = SQUARES.a8;
                    var last_sq = SQUARES.h1;
                    var p = false;
                    var g = void 0 === options || !("legal" in options) || options.legal;
                    var key = void 0 === options || !("piece" in options) || "string" != typeof options.piece ||
                        options.piece.toLowerCase();
                    if (void 0 !== options && "square" in options) {
                        if (!(options.square in SQUARES)) return [];
                        first_sq = last_sq = SQUARES[options.square];
                        p = true
                    }
                    var i = first_sq;
                    for (; i <= last_sq; i++)
                        if (136 & i) i = i + 7;
                        else {
                            var e = board[i];
                            if (null != e && e.color === us)
                                if (e.type !== PAWN || true !== key && key !== PAWN) {
                                    if (true === key || key === e.type) {
                                        var j = 0;
                                        var len = PIECE_OFFSETS[e.type].length;
                                        for (; j < len; j++) {
                                            var offset = PIECE_OFFSETS[e.type][j];
                                            square = i;
                                            for (; !(136 & (square = square + offset));) {
                                                if (null != board[square]) {
                                                    if (board[square].color ===
                                                        us) break;
                                                    add_move(board, moves, i, square, BITS.CAPTURE);
                                                    break
                                                }
                                                if (add_move(board, moves, i, square, BITS.NORMAL), "n" === e.type || "k" === e.type) break
                                            }
                                        }
                                    }
                                } else {
                                    var square = i + PAWN_OFFSETS[us][0];
                                    if (null == board[square]) {
                                        add_move(board, moves, i, square, BITS.NORMAL);
                                        square = i + PAWN_OFFSETS[us][1];
                                        if (second_rank[us] === rank(i) && null == board[square]) add_move(board, moves, i, square, BITS.BIG_PAWN)
                                    }
                                    j = 2;
                                    for (; j < 4; j++)
                                        if (!(136 & (square = i + PAWN_OFFSETS[us][j])))
                                            if (null != board[square] && board[square].color === them) add_move(board, moves, i,
                                                square, BITS.CAPTURE);
                                            else if (square === ep_square) add_move(board, moves, i, ep_square, BITS.EP_CAPTURE)
                                }
                        } if (!(true !== key && key !== KING || p && last_sq !== kings[us])) {
                        if (castling[us] & BITS.KSIDE_CASTLE) {
                            var castling_to = (castling_from = kings[us]) + 2;
                            if (!(null != board[castling_from + 1] || null != board[castling_to] || attacked(them, kings[us]) || attacked(them, castling_from + 1) || attacked(them, castling_to))) add_move(board, moves, kings[us], castling_to, BITS.KSIDE_CASTLE)
                        }
                        var castling_from;
                        if (castling[us] & BITS.QSIDE_CASTLE) {
                            castling_to =
                                (castling_from = kings[us]) - 2;
                            if (!(null != board[castling_from - 1] || null != board[castling_from - 2] || null != board[castling_from - 3] || attacked(them, kings[us]) || attacked(them, castling_from - 1) || attacked(them, castling_to))) add_move(board, moves, kings[us], castling_to, BITS.QSIDE_CASTLE)
                        }
                    }
                    if (!g) return moves;
                    var legal_moves = [];
                    i = 0;
                    len = moves.length;
                    for (; i < len; i++) {
                        make_move(moves[i]);
                        if (!king_attacked(us)) legal_moves.push(moves[i]);
                        undo_move()
                    }
                    return legal_moves
                }

                function move_to_san(move, sloppy) {
                    var output = "";
                    if (move.flags &
                        BITS.KSIDE_CASTLE) output = "O-O";
                    else if (move.flags & BITS.QSIDE_CASTLE) output = "O-O-O";
                    else {
                        if (move.piece !== PAWN) {
                            var disambiguator = function (move, result) {
                                var from = move.from;
                                var to = move.to;
                                var piece = move.piece;
                                var numquestion = 0;
                                var s = 0;
                                var words = 0;
                                var i = 0;
                                var len = result.length;
                                for (; i < len; i++) {
                                    var ambig_from = result[i].from;
                                    var ambig_to = result[i].to;
                                    if (piece === result[i].piece && from !== ambig_from && to === ambig_to) {
                                        numquestion++;
                                        if (rank(from) === rank(ambig_from)) s++;
                                        if (file(from) === file(ambig_from)) words++
                                    }
                                }
                                return numquestion >
                                    0 ? s > 0 && words > 0 ? algebraic(from) : words > 0 ? algebraic(from).charAt(1) : algebraic(from).charAt(0) : ""
                            }(move, sloppy);
                            output = output + (move.piece.toUpperCase() + disambiguator)
                        }
                        if (move.flags & (BITS.CAPTURE | BITS.EP_CAPTURE)) {
                            if (move.piece === PAWN) output = output + algebraic(move.from)[0];
                            output = output + "x"
                        }
                        output = output + algebraic(move.to);
                        if (move.flags & BITS.PROMOTION) output = output + ("=" + move.promotion.toUpperCase())
                    }
                    return make_move(move), in_check() && (in_checkmate() ? output = output + "#" : output = output + "+"), undo_move(), output
                }

                function stripped_san(move) {
                    return move.replace(/=/, "").replace(/[+#]?[?!]*$/, "")
                }

                function attacked(color, square) {
                    var i = SQUARES.a8;
                    for (; i <= SQUARES.h1; i++)
                        if (136 & i) i = i + 7;
                        else if (null != board[i] && board[i].color === color) {
                        var piece = board[i];
                        var difference = i - square;
                        var period = difference + 119;
                        if (show[period] & 1 << SHIFTS[piece.type]) {
                            if (piece.type === PAWN) {
                                if (difference > 0) {
                                    if (piece.color === WHITE) return true
                                } else if (piece.color === BLACK) return true;
                                continue
                            }
                            if ("n" === piece.type || "k" === piece.type) return true;
                            var adj =
                                proto[period];
                            var j = i + adj;
                            var d = false;
                            for (; j !== square;) {
                                if (null != board[j]) {
                                    d = true;
                                    break
                                }
                                j = j + adj
                            }
                            if (!d) return true
                        }
                    }
                    return false
                }

                function king_attacked(color) {
                    return attacked(swap_color(color), kings[color])
                }

                function in_check() {
                    return king_attacked(turn)
                }

                function in_checkmate() {
                    return in_check() && 0 === generate_moves().length
                }

                function in_stalemate() {
                    return !in_check() && 0 === generate_moves().length
                }

                function insufficient_material() {
                    var map = {};
                    var keys = [];
                    var n = 0;
                    var keySection = 0;
                    var i = SQUARES.a8;
                    for (; i <=
                        SQUARES.h1; i++)
                        if (keySection = (keySection + 1) % 2, 136 & i) i = i + 7;
                        else {
                            var e = board[i];
                            if (e) {
                                map[e.type] = e.type in map ? map[e.type] + 1 : 1;
                                if ("b" === e.type) keys.push(keySection);
                                n++
                            }
                        } if (2 === n) return true;
                    if (3 === n && (1 === map.b || 1 === map.n)) return true;
                    if (n === map.b + 2) {
                        var key = 0;
                        var index = keys.length;
                        i = 0;
                        for (; i < index; i++) key = key + keys[i];
                        if (0 === key || key === index) return true
                    }
                    return false
                }

                function in_threefold_repetition() {
                    var queue = [];
                    var globalRefreshTokenCreds = {};
                    var repetition = false;
                    for (;;) {
                        var move = undo_move();
                        if (!move) break;
                        queue.push(move)
                    }
                    for (;;) {
                        var stringifiedRefreshToken = generate_fen().split(" ").slice(0, 4).join(" ");
                        if (globalRefreshTokenCreds[stringifiedRefreshToken] = stringifiedRefreshToken in globalRefreshTokenCreds ? globalRefreshTokenCreds[stringifiedRefreshToken] + 1 : 1, globalRefreshTokenCreds[stringifiedRefreshToken] >= 3 && (repetition = true), !queue.length) break;
                        make_move(queue.pop())
                    }
                    return repetition
                }

                function make_move(move) {
                    var us = turn;
                    var them = swap_color(us);
                    if (function (move) {
                            history.push({
                                move: move,
                                kings: {
                                    b: kings.b,
                                    w: kings.w
                                },
                                turn: turn,
                                castling: {
                                    b: castling.b,
                                    w: castling.w
                                },
                                ep_square: ep_square,
                                half_moves: half_moves,
                                move_number: move_number
                            })
                        }(move),
                        board[move.to] = board[move.from], board[move.from] = null, move.flags & BITS.EP_CAPTURE && (turn === BLACK ? board[move.to - 16] = null : board[move.to + 16] = null), move.flags & BITS.PROMOTION && (board[move.to] = {
                            type: move.promotion,
                            color: us
                        }), board[move.to].type === KING) {
                        if (kings[board[move.to].color] = move.to, move.flags & BITS.KSIDE_CASTLE) {
                            var castling_to = move.to - 1;
                            var castling_from = move.to + 1;
                            board[castling_to] = board[castling_from];
                            board[castling_from] = null
                        } else if (move.flags & BITS.QSIDE_CASTLE) {
                            castling_to = move.to + 1;
                            castling_from =
                                move.to - 2;
                            board[castling_to] = board[castling_from];
                            board[castling_from] = null
                        }
                        castling[us] = ""
                    }
                    if (castling[us]) {
                        var i = 0;
                        var c = ROOKS[us].length;
                        for (; i < c; i++)
                            if (move.from === ROOKS[us][i].square && castling[us] & ROOKS[us][i].flag) {
                                castling[us] ^= ROOKS[us][i].flag;
                                break
                            }
                    }
                    if (castling[them]) {
                        i = 0;
                        c = ROOKS[them].length;
                        for (; i < c; i++)
                            if (move.to === ROOKS[them][i].square && castling[them] & ROOKS[them][i].flag) {
                                castling[them] ^= ROOKS[them][i].flag;
                                break
                            }
                    }
                    ep_square = move.flags & BITS.BIG_PAWN ? "b" === turn ? move.to - 16 : move.to + 16 : EMPTY;
                    if (move.piece === PAWN || move.flags & (BITS.CAPTURE | BITS.EP_CAPTURE)) half_moves = 0;
                    else half_moves++;
                    if (turn === BLACK) move_number++;
                    turn = swap_color(turn)
                }

                function undo_move() {
                    var old = history.pop();
                    if (null == old) return null;
                    var move = old.move;
                    kings = old.kings;
                    turn = old.turn;
                    castling = old.castling;
                    ep_square = old.ep_square;
                    half_moves = old.half_moves;
                    move_number = old.move_number;
                    var castling_to;
                    var castling_from;
                    var us = turn;
                    var them = swap_color(turn);
                    if (board[move.from] = board[move.to], board[move.from].type = move.piece,
                        board[move.to] = null, move.flags & BITS.CAPTURE) board[move.to] = {
                        type: move.captured,
                        color: them
                    };
                    else if (move.flags & BITS.EP_CAPTURE) {
                        var sq;
                        sq = us === BLACK ? move.to - 16 : move.to + 16;
                        board[sq] = {
                            type: PAWN,
                            color: them
                        }
                    }
                    return move.flags & (BITS.KSIDE_CASTLE | BITS.QSIDE_CASTLE) && (move.flags & BITS.KSIDE_CASTLE ? (castling_to = move.to + 1, castling_from = move.to - 1) : move.flags & BITS.QSIDE_CASTLE && (castling_to = move.to - 2, castling_from = move.to + 1), board[castling_to] = board[castling_from], board[castling_from] = null), move
                }

                function move_from_san(move,
                    sloppy) {
                    var clean_move = stripped_san(move);
                    if (sloppy) {
                        var points = clean_move.match(/([pnbrqkPNBRQK])?([a-h][1-8])x?-?([a-h][1-8])([qrbnQRBN])?/);
                        if (points) {
                            var b = points[1];
                            var from = points[2];
                            var to = points[3];
                            var initial = points[4]
                        }
                    }
                    var c = function (e) {
                        var v = e.charAt(0);
                        if (v >= "a" && v <= "h") {
                            if (e.match(/[a-h]\d.*[a-h]\d/)) return;
                            return PAWN
                        }
                        return "o" === (v = v.toLowerCase()) ? KING : v
                    }(clean_move);
                    var moves = null;
                    var allMoves2 = generate_moves({
                        legal: true,
                        piece: b || c
                    });
                    if (moves = allMoves2, sloppy) {
                        var pointermove = generate_moves({
                            legal: false,
                            piece: b ||
                                c
                        });
                        moves = pointermove
                    }
                    var i = 0;
                    var len = moves.length;
                    for (; i < len; i++) {
                        if (clean_move === stripped_san(move_to_san(moves[i], allMoves2)) || sloppy && clean_move === stripped_san(move_to_san(moves[i], pointermove))) return moves[i];
                        if (points && (!b || b.toLowerCase() == moves[i].piece) && SQUARES[from] == moves[i].from && SQUARES[to] == moves[i].to && (!initial || initial.toLowerCase() == moves[i].promotion)) return moves[i]
                    }
                    return null
                }

                function rank(i) {
                    return i >> 4
                }

                function file(i) {
                    return 15 & i
                }

                function algebraic(i) {
                    var f = file(i);
                    var r =
                        rank(i);
                    return "abcdefgh".substring(f, f + 1) + "87654321".substring(r, r + 1)
                }

                function swap_color(c) {
                    return c === WHITE ? BLACK : WHITE
                }

                function make_pretty(ugly_move) {
                    var move = clone(ugly_move);
                    move.san = move_to_san(move, generate_moves({
                        legal: true
                    }));
                    move.to = algebraic(move.to);
                    move.from = algebraic(move.from);
                    var flags = "";
                    var flag;
                    for (flag in BITS)
                        if (BITS[flag] & move.flags) flags = flags + FLAGS[flag];
                    return move.flags = flags, move
                }

                function clone(object) {
                    var r2 = object instanceof Array ? [] : {};
                    var prop;
                    for (prop in object) r2[prop] =
                        "object" == typeof prop ? clone(object[prop]) : object[prop];
                    return r2
                }

                function trim(s) {
                    return s.replace(/^\s+|\s+$/g, "")
                }

                function perft(depth) {
                    var moves = generate_moves({
                        legal: false
                    });
                    var nodes = 0;
                    var color = turn;
                    var i = 0;
                    var len = moves.length;
                    for (; i < len; i++) {
                        make_move(moves[i]);
                        if (!king_attacked(color))
                            if (depth - 1 > 0) nodes = nodes + perft(depth - 1);
                            else nodes++;
                        undo_move()
                    }
                    return nodes
                }
                var BLACK = "b";
                var WHITE = "w";
                var EMPTY = -1;
                var PAWN = "p";
                var KING = "k";
                var DEFAULT_POSITION = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
                var xCreateOptions = ["1-0", "0-1", "1/2-1/2", "*"];
                var PAWN_OFFSETS = {
                    b: [16, 32, 17, 15],
                    w: [-16, -32, -17, -15]
                };
                var PIECE_OFFSETS = {
                    n: [-18, -33, -31, -14, 18, 33, 31, 14],
                    b: [-17, -15, 17, 15],
                    r: [-16, 1, 16, -1],
                    q: [-17, -16, -15, 1, 17, 16, 15, -1],
                    k: [-17, -16, -15, 1, 17, 16, 15, -1]
                };
                var show = [20, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 20, 0, 0, 20, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 20, 0, 0, 0, 0, 24, 0, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 24, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0, 24, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 2, 24, 2, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 53, 56, 53, 2, 0, 0, 0, 0, 0,
                    0, 24, 24, 24, 24, 24, 24, 56, 0, 56, 24, 24, 24, 24, 24, 24, 0, 0, 0, 0, 0, 0, 2, 53, 56, 53, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 2, 24, 2, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0, 24, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 24, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 24, 0, 0, 0, 0, 20, 0, 0, 0, 0, 20, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 20, 0, 0, 20, 0, 0, 0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 20
                ];
                var proto = [17, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 15, 0, 0, 17, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 15, 0, 0, 0, 0, 17, 0, 0, 0, 0, 16, 0, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0, 17, 0, 0, 0, 16, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 0, 17, 0, 0, 16, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 17, 0, 16, 0, 15,
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 17, 16, 15, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, -1, -1, -1, -1, -1, -1, -1, 0, 0, 0, 0, 0, 0, 0, -15, -16, -17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -15, 0, -16, 0, -17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -15, 0, 0, -16, 0, 0, -17, 0, 0, 0, 0, 0, 0, 0, 0, -15, 0, 0, 0, -16, 0, 0, 0, -17, 0, 0, 0, 0, 0, 0, -15, 0, 0, 0, 0, -16, 0, 0, 0, 0, -17, 0, 0, 0, 0, -15, 0, 0, 0, 0, 0, -16, 0, 0, 0, 0, 0, -17, 0, 0, -15, 0, 0, 0, 0, 0, 0, -16, 0, 0, 0, 0, 0, 0, -17
                ];
                var SHIFTS = {
                    p: 0,
                    n: 1,
                    b: 2,
                    r: 3,
                    q: 4,
                    k: 5
                };
                var FLAGS = {
                    NORMAL: "n",
                    CAPTURE: "c",
                    BIG_PAWN: "b",
                    EP_CAPTURE: "e",
                    PROMOTION: "p",
                    KSIDE_CASTLE: "k",
                    QSIDE_CASTLE: "q"
                };
                var BITS = {
                    NORMAL: 1,
                    CAPTURE: 2,
                    BIG_PAWN: 4,
                    EP_CAPTURE: 8,
                    PROMOTION: 16,
                    KSIDE_CASTLE: 32,
                    QSIDE_CASTLE: 64
                };
                var SQUARES = {
                    a8: 0,
                    b8: 1,
                    c8: 2,
                    d8: 3,
                    e8: 4,
                    f8: 5,
                    g8: 6,
                    h8: 7,
                    a7: 16,
                    b7: 17,
                    c7: 18,
                    d7: 19,
                    e7: 20,
                    f7: 21,
                    g7: 22,
                    h7: 23,
                    a6: 32,
                    b6: 33,
                    c6: 34,
                    d6: 35,
                    e6: 36,
                    f6: 37,
                    g6: 38,
                    h6: 39,
                    a5: 48,
                    b5: 49,
                    c5: 50,
                    d5: 51,
                    e5: 52,
                    f5: 53,
                    g5: 54,
                    h5: 55,
                    a4: 64,
                    b4: 65,
                    c4: 66,
                    d4: 67,
                    e4: 68,
                    f4: 69,
                    g4: 70,
                    h4: 71,
                    a3: 80,
                    b3: 81,
                    c3: 82,
                    d3: 83,
                    e3: 84,
                    f3: 85,
                    g3: 86,
                    h3: 87,
                    a2: 96,
                    b2: 97,
                    c2: 98,
                    d2: 99,
                    e2: 100,
                    f2: 101,
                    g2: 102,
                    h2: 103,
                    a1: 112,
                    b1: 113,
                    c1: 114,
                    d1: 115,
                    e1: 116,
                    f1: 117,
                    g1: 118,
                    h1: 119
                };
                var ROOKS = {
                    w: [{
                        square: SQUARES.a1,
                        flag: BITS.QSIDE_CASTLE
                    }, {
                        square: SQUARES.h1,
                        flag: BITS.KSIDE_CASTLE
                    }],
                    b: [{
                        square: SQUARES.a8,
                        flag: BITS.QSIDE_CASTLE
                    }, {
                        square: SQUARES.h8,
                        flag: BITS.KSIDE_CASTLE
                    }]
                };
                var board = new Array(128);
                var kings = {
                    w: EMPTY,
                    b: EMPTY
                };
                var turn = WHITE;
                var castling = {
                    w: 0,
                    b: 0
                };
                var ep_square = EMPTY;
                var half_moves = 0;
                var move_number = 1;
                var history = [];
                var header = {};
                var parts = {};
                return load(void 0 === path ? DEFAULT_POSITION : path), {
                    WHITE: WHITE,
                    BLACK: BLACK,
                    PAWN: PAWN,
                    KNIGHT: "n",
                    BISHOP: "b",
                    ROOK: "r",
                    QUEEN: "q",
                    KING: KING,
                    SQUARES: function () {
                        var keys = [];
                        var i = SQUARES.a8;
                        for (; i <= SQUARES.h1; i++)
                            if (136 & i) i = i + 7;
                            else keys.push(algebraic(i));
                        return keys
                    }(),
                    FLAGS: FLAGS,
                    load: function (fen) {
                        return load(fen)
                    },
                    reset: function () {
                        return reset()
                    },
                    moves: function (options) {
                        var ugly_moves = generate_moves(options);
                        var moves = [];
                        var i = 0;
                        var len = ugly_moves.length;
                        for (; i < len; i++)
                            if (void 0 !== options && "verbose" in options && options.verbose) moves.push(make_pretty(ugly_moves[i]));
                            else moves.push(move_to_san(ugly_moves[i], generate_moves({
                                legal: true
                            })));
                        return moves
                    },
                    in_check: function () {
                        return in_check()
                    },
                    in_checkmate: function () {
                        return in_checkmate()
                    },
                    in_stalemate: function () {
                        return in_stalemate()
                    },
                    in_draw: function () {
                        return half_moves >=
                            100 || in_stalemate() || insufficient_material() || in_threefold_repetition()
                    },
                    insufficient_material: function () {
                        return insufficient_material()
                    },
                    in_threefold_repetition: function () {
                        return in_threefold_repetition()
                    },
                    game_over: function () {
                        return half_moves >= 100 || in_checkmate() || in_stalemate() || insufficient_material() || in_threefold_repetition()
                    },
                    validate_fen: function (fen) {
                        return validate_fen(fen)
                    },
                    fen: function () {
                        return generate_fen()
                    },
                    board: function () {
                        var output = [];
                        var menu = [];
                        var i = SQUARES.a8;
                        for (; i <= SQUARES.h1; i++) {
                            if (null ==
                                board[i]) menu.push(null);
                            else menu.push({
                                type: board[i].type,
                                color: board[i].color
                            });
                            if (i + 1 & 136) {
                                output.push(menu);
                                menu = [];
                                i = i + 8
                            }
                        }
                        return output
                    },
                    pgn: function (options) {
                        var end = "object" == typeof options && "string" == typeof options.newline_char ? options.newline_char : "\n";
                        var n = "object" == typeof options && "number" == typeof options.max_width ? options.max_width : 0;
                        var output = [];
                        var header_exists = false;
                        var i;
                        for (i in header) {
                            output.push("[" + i + ' "' + header[i] + '"]' + end);
                            header_exists = true
                        }
                        if (header_exists && history.length) output.push(end);
                        var load = function (filename) {
                            var value = parts[generate_fen()];
                            return void 0 !== value && (filename = `${filename}${filename.length>0?" ":""}{${value}}`), filename
                        };
                        var reversed_history = [];
                        for (; history.length > 0;) reversed_history.push(undo_move());
                        var results = [];
                        var file = "";
                        if (0 === reversed_history.length) results.push(load(""));
                        for (; reversed_history.length > 0;) {
                            file = load(file);
                            var move = reversed_history.pop();
                            if (history.length || "b" !== move.color) {
                                if ("w" === move.color) {
                                    if (file.length) results.push(file);
                                    file = move_number +
                                        "."
                                }
                            } else file = move_number + ". ...";
                            file = file + " " + move_to_san(move, generate_moves({
                                legal: false
                            }));
                            make_move(move)
                        }
                        if (file.length && results.push(load(file)), void 0 !== header.Result && results.push(header.Result), 0 === n) return output.join("") + results.join(" ");
                        var remove = function () {
                            return output.length > 0 && " " === output[output.length - 1] && (output.pop(), true)
                        };
                        var done = function (i, box) {
                            var iv;
                            for (iv of box.split(" "))
                                if (iv) {
                                    if (i + iv.length > n) {
                                        for (; remove();) i--;
                                        output.push(end);
                                        i = 0
                                    }
                                    output.push(iv);
                                    i = i + iv.length;
                                    output.push(" ");
                                    i++
                                } return remove() && i--, i
                        };
                        var count = 0;
                        i = 0;
                        for (; i < results.length; i++)
                            if (count + results[i].length > n && results[i].includes("{")) count = done(count, results[i]);
                            else {
                                if (count + results[i].length > n && 0 !== i) {
                                    if (" " === output[output.length - 1]) output.pop();
                                    output.push(end);
                                    count = 0
                                } else if (0 !== i) {
                                    output.push(" ");
                                    count++
                                }
                                output.push(results[i]);
                                count = count + results[i].length
                            } return output.join("")
                    },
                    load_pgn: function (from, options) {
                        function mask(type) {
                            return type.replace(/\\/g, "\\")
                        }
                        var sloppy = void 0 !==
                            options && "sloppy" in options && options.sloppy;
                        var value = "object" == typeof options && "string" == typeof options.newline_char ? options.newline_char : "\r?\n";
                        var from_regex = new RegExp("^(\\[((?:" + mask(value) + ")|.)*\\])(?:" + mask(value) + "){2}");
                        var token = from_regex.test(from) ? from_regex.exec(from)[1] : "";
                        reset();
                        var data = function ($2, options) {
                            var value = "object" == typeof options && "string" == typeof options.newline_char ? options.newline_char : "\r?\n";
                            var AsciiArt = {};
                            var theFileExtension = $2.split(new RegExp(mask(value)));
                            var name = "";
                            var result = "";
                            var i = 0;
                            for (; i < theFileExtension.length; i++) {
                                name = theFileExtension[i].replace(/^\[([A-Z][A-Za-z]*)\s.*\]$/, "$1");
                                result = theFileExtension[i].replace(/^\[[A-Za-z]+\s"(.*)" *\]$/, "$1");
                                if (trim(name).length > 0) AsciiArt[name] = result
                            }
                            return AsciiArt
                        }(token, options);
                        var key;
                        for (key in data) set_header([key, data[key]]);
                        if (!("1" !== data.SetUp || "FEN" in data && load(data.FEN, true))) return false;
                        var fn = function (x) {
                            return `{${(function(lookupdEndpoints){return Array.from(lookupdEndpoints).map(function(e){return e.charCodeAt(0)<
128?e.charCodeAt(0).toString(16):encodeURIComponent(e).replace(/%/g,"").toLowerCase()}).join("")})((x=x.replace(new RegExp(mask(value),"g")," ")).slice(1,x.length-1))}}`
                        };
                        var f = function (fname) {
                            if (fname.startsWith("{") && fname.endsWith("}")) return function (e) {
                                return 0 == e.length ? "" : decodeURIComponent("%" + e.match(/.{1,2}/g).join("%"))
                            }(fname.slice(1, fname.length - 1))
                        };
                        var s = from.replace(token, "").replace(new RegExp(`({[^}]*})+?|;([^${mask(value)}]*)`, "g"), function (canCreateDiscussions, val, headerPlusSegments) {
                            return void 0 !==
                                val ? fn(val) : " " + fn(`{${headerPlusSegments.slice(1)}}`)
                        }).replace(new RegExp(mask(value), "g"), " ");
                        var g = /(\([^\(\)]+\))+?/g;
                        for (; g.test(s);) s = s.replace(g, "");
                        var moves = trim(s = (s = (s = s.replace(/\d+\.(\.\.)?/g, "")).replace(/\.\.\./g, "")).replace(/\$\d+/g, "")).split(new RegExp(/\s+/));
                        moves = moves.join(",").replace(/,,+/g, ",").split(",");
                        var move = "";
                        var half_move = 0;
                        for (; half_move < moves.length - 1; half_move++) {
                            var y = f(moves[half_move]);
                            if (void 0 === y) {
                                if (null == (move = move_from_san(moves[half_move], sloppy))) return false;
                                make_move(move)
                            } else parts[generate_fen()] = y
                        }
                        if (void 0 !== (y = f(moves[moves.length - 1])) && (parts[generate_fen()] = y, moves.pop()), move = moves[moves.length - 1], xCreateOptions.indexOf(move) > -1) {
                            if (function (value) {
                                    var fqPropertyName;
                                    for (fqPropertyName in value) return true;
                                    return false
                                }(header) && void 0 === header.Result) set_header(["Result", move])
                        } else {
                            if (null == (move = move_from_san(move, sloppy))) return false;
                            make_move(move)
                        }
                        return true
                    },
                    header: function () {
                        return set_header(arguments)
                    },
                    ascii: function () {
                        return function () {
                            var ret =
                                "   +------------------------+\n";
                            var i = SQUARES.a8;
                            for (; i <= SQUARES.h1; i++) {
                                if (0 === file(i) && (ret = ret + (" " + "87654321" [rank(i)] + " |")), null == board[i]) ret = ret + " . ";
                                else {
                                    var referenceChar = board[i].type;
                                    ret = ret + (" " + (board[i].color === WHITE ? referenceChar.toUpperCase() : referenceChar.toLowerCase()) + " ")
                                }
                                if (i + 1 & 136) {
                                    ret = ret + "|\n";
                                    i = i + 8
                                }
                            }
                            return (ret = ret + "   +------------------------+\n") + "     a  b  c  d  e  f  g  h\n"
                        }()
                    },
                    turn: function () {
                        return turn
                    },
                    move: function (move, options) {
                        var sloppy = void 0 !== options &&
                            "sloppy" in options && options.sloppy;
                        var move_obj = null;
                        if ("string" == typeof move) move_obj = move_from_san(move, sloppy);
                        else if ("object" == typeof move) {
                            var moves = generate_moves();
                            var i = 0;
                            var len = moves.length;
                            for (; i < len; i++)
                                if (move.from === algebraic(moves[i].from) && move.to === algebraic(moves[i].to) && (!("promotion" in moves[i]) || move.promotion === moves[i].promotion)) {
                                    move_obj = moves[i];
                                    break
                                }
                        }
                        if (!move_obj) return null;
                        var pretty_move = make_pretty(move_obj);
                        return make_move(move_obj), pretty_move
                    },
                    undo: function () {
                        var move =
                            undo_move();
                        return move ? make_pretty(move) : null
                    },
                    clear: function () {
                        return clear()
                    },
                    put: function (piece, square) {
                        return put(piece, square)
                    },
                    get: function (e) {
                        return get(e)
                    },
                    remove: function (a) {
                        return function (square) {
                            var piece = get(square);
                            return board[SQUARES[square]] = null, piece && piece.type === KING && (kings[piece.color] = EMPTY), update_setup(generate_fen()), piece
                        }(a)
                    },
                    perft: function (depth) {
                        return perft(depth)
                    },
                    square_color: function (square) {
                        if (square in SQUARES) {
                            var sq_0x88 = SQUARES[square];
                            return (rank(sq_0x88) +
                                file(sq_0x88)) % 2 == 0 ? "light" : "dark"
                        }
                        return null
                    },
                    history: function (options) {
                        var reversed_history = [];
                        var move_history = [];
                        var r = void 0 !== options && "verbose" in options && options.verbose;
                        for (; history.length > 0;) reversed_history.push(undo_move());
                        for (; reversed_history.length > 0;) {
                            var move = reversed_history.pop();
                            if (r) move_history.push(make_pretty(move));
                            else move_history.push(move_to_san(move, generate_moves({
                                legal: true
                            })));
                            make_move(move)
                        }
                        return move_history
                    },
                    get_comment: function () {
                        return parts[generate_fen()]
                    },
                    set_comment: function (originalBaseURL) {
                        parts[generate_fen()] =
                            originalBaseURL.replace("{", "[").replace("}", "]")
                    },
                    delete_comment: function () {
                        var tmz = parts[generate_fen()];
                        return delete parts[generate_fen()], tmz
                    },
                    get_comments: function () {
                        return remove(), Object.keys(parts).map(function (i) {
                            return {
                                fen: i,
                                comment: parts[i]
                            }
                        })
                    },
                    delete_comments: function () {
                        return remove(), Object.keys(parts).map(function (i) {
                            var source = parts[i];
                            return delete parts[i], {
                                fen: i,
                                comment: source
                            }
                        })
                    }
                }
            };
            exports.Chess = Chess;
            if (!(void 0 === (__WEBPACK_AMD_DEFINE_RESULT__ = function () {
                    return Chess
                }.call(exports,
                    __webpack_require__, exports, module)))) module.exports = __WEBPACK_AMD_DEFINE_RESULT__
        }
    };
    var _modules = {};
    a.n = (module) => {
        var value = module && module.__esModule ? () => {
            return module.default
        } : () => {
            return module
        };
        return a.d(value, {
            a: value
        }), value
    };
    a.d = (d, e) => {
        var name;
        for (name in e)
            if (a.o(e, name) && !a.o(d, name)) Object.defineProperty(d, name, {
                enumerable: true,
                get: e[name]
            })
    };
    a.o = (t, object) => {
        return Object.prototype.hasOwnProperty.call(t, object)
    };
    (() => {
        class Stoke {
            constructor(val, choices) {
                this.row = val;
                this.column = choices
            }
            toChessSquareString() {
                return String.fromCharCode("a".charCodeAt(0) +
                    this.column) + (8 - this.row)
            }
            getRow() {
                return this.row
            }
            getColumn() {
                return this.column
            }
            static fromRowAndColumn(dt, n) {
                return new Stoke(dt, n)
            }
            static fromSquare(n) {
                const t = n.charCodeAt(0) - "a".charCodeAt(0);
                const r = 8 - parseInt(n[1]);
                return new Stoke(r, t)
            }
        }
        const t = (proplist) => {
            return 60 * parseInt(proplist.split(":")[0]) + parseInt(proplist.split(":")[1])
        };
        const r = (hash) => {
            if (hash > 36) throw new Error("Does not support generating random string of length > 36");
            return Math.random().toString(36).replace(/[^a-z]+/g,
                "").substring(0, hash)
        };
        const map = () => {
            return thisArg = void 0, _arguments = void 0, generator = function* () {
                return new Promise((saveNotifs) => {
                    try {
                        chrome.storage.local.get(["extensionActive", "depthValue", "elo", "maxWaitTime", "newgame", "highlightMoves", "automove", "autoPlayNewGame", "bongcloud", "voice", "moveKeybind", "exitKeybind", "ttsKeybind"], (notifications) => {
                            saveNotifs(notifications)
                        })
                    } catch (e) {
                    }
                })
            }, new((Color = void 0) || (Color = Promise))(function (unCleanDataForForm, error) {
                function done(err) {
                    try {
                        update(generator.next(err))
                    } catch (errormessage) {
                        error(errormessage)
                    }
                }

                function error(err) {
                    try {
                        update(generator.throw(err))
                    } catch (errormessage) {
                        error(errormessage)
                    }
                }

                function update(item) {
                    var color;
                    if (item.done) unCleanDataForForm(item.value);
                    else(color = item.value, color instanceof Color ? color : new Color(function (expect) {
                        expect(color)
                    })).then(done, error)
                }
                update((generator = generator.apply(thisArg, _arguments || [])).next())
            });
            var thisArg;
            var _arguments;
            var Color;
            var generator
        };
        const getCell = (screenX, screenY, e) => {
            chrome.runtime.sendMessage({
                eventPlease: "trusted",
                x: screenX,
                y: screenY,
                mouse: e
            }, function (canCreateDiscussions) {})
        };
        const update = (table, cell, width, left, key, rules) => {
            const col = rules / 8;
            const delta = col / 2;
            let x;
            let y;
            let endX;
            let depthInFontWeight;
            return "white" === width ? (x = left + col * (table.getColumn() + 1) - delta, y = key + rules - col * (8 - table.getRow()) + delta, endX = left + col * (cell.getColumn() + 1) - delta, depthInFontWeight = key + rules - col * (8 - cell.getRow()) + delta) : (x = left + col * (8 - table.getColumn()) - delta, y = key + rules - col * (table.getRow() + 1) + delta, endX = left + col * (8 - cell.getColumn()) - delta, depthInFontWeight = key + rules - col * (cell.getRow() + 1) + delta), {
                startX: x,
                startY: y,
                endX: endX,
                endY: depthInFontWeight
            }
        };
        const UIManager = (Matrix4, panels, undoManager, previewManager, commandManager, helpOptions) => {
            const KFactor = helpOptions / 8;
            const no = KFactor / 2;
            let xfact = 0;
            let tmpSlug = 0;
            const BlueWe = ((key) => {
                switch (key) {
                case "q":
                    return 0;
                case "k":
                    return 1;
                case "b":
                    return 2;
                case "r":
                default:
                    return 3
                }
            })(panels);
            return "white" === undoManager ? (xfact = previewManager + KFactor * (Matrix4.getColumn() + 1) - no, tmpSlug = commandManager + helpOptions - KFactor * (8 - Matrix4.getRow() - BlueWe) + no) : (xfact = previewManager + KFactor * (8 - Matrix4.getColumn()) -
                no, tmpSlug = commandManager + helpOptions - KFactor * (Matrix4.getRow() + 1 - BlueWe) + no), {
                x: xfact,
                y: tmpSlug
            }
        };
        class MetricsData {
            constructor() {
                this.RED_SQUARE_CLASS_NAME = r(20);
                this.getPlayerColour = () => {
                    return document.querySelector(".clock-bottom").classList.contains("clock-white") ? "white" : "black"
                }
            }
            isMyTurn() {
                return !!document.querySelector(".clock-bottom") && document.querySelector(".clock-bottom").classList.contains("clock-player-turn")
            }
            amIWhite() {
                return !!document.querySelector(".clock-bottom") && document.querySelector(".clock-bottom").classList.contains("clock-white")
            }
            getMyTimeInSeconds() {
                const el7 =
                    document.querySelector(".clock-bottom");
                if (el7) {
                    const n = el7.querySelector("span").innerText;
                    return t(n)
                }
                return -1
            }
            getOpponentTimeInSeconds() {
                const el7 = document.querySelector(".clock-top");
                if (el7) {
                    const n = el7.querySelector("span").innerText;
                    return t(n)
                }
                return -1
            }
            makeMove(next, curr) {
                const config = this.getPlayerColour();
                const previewElt = document.querySelector(".board");
                const {
                    left: left,
                    top: top,
                    width: width
                } = previewElt.getBoundingClientRect();
                const {
                    startX: startX,
                    startY: startY,
                    endX: endX,
                    endY: endY
                } = update(next,
                    curr, config, left, top, width);
                getCell(startX, startY, "D");
                getCell(startX, startY, "U");
                getCell(endX, endY, "D");
                getCell(endX, endY, "U")
            }
            promote(props, datum) {
                const idx = this.getPlayerColour();
                const previewElt = document.querySelector(".board");
                const {
                    left: left,
                    top: top,
                    width: width
                } = previewElt.getBoundingClientRect();
                const {
                    x: x,
                    y: y
                } = UIManager(props, datum, idx, left, top, width);
                getCell(x, y, "D");
                getCell(x, y, "U")
            }
            draw(table) {
                if (this.isMyTurn()) {
                    const transparent = this.getPlayerColour();
                    const overlay = document.querySelector(".board");
                    const cursor =
                        document.createElement("div");
                    cursor.style.display = "block";
                    cursor.style.position = "absolute";
                    if ("white" === transparent) {
                        cursor.style.top = 12.5 * table.getRow() + "%";
                        cursor.style.left = 12.5 * table.getColumn() + "%"
                    } else {
                        cursor.style.top = 12.5 * (7 - table.getRow()) + "%";
                        cursor.style.left = 12.5 * (7 - table.getColumn()) + "%"
                    }
                    cursor.style.background = "rgba(255, 167, 31, 0.4)";
                    cursor.style.height = "12.5%";
                    cursor.style.width = "12.5%";
                    cursor.className = this.RED_SQUARE_CLASS_NAME;
                    overlay.appendChild(cursor)
                }
            }
            clearAllDrawings() {
                document.querySelectorAll(`.${this.RED_SQUARE_CLASS_NAME}`).forEach((inventoryService) => {
                    return inventoryService.remove()
                })
            }
            onNewMove(curr) {
                if (!window.location.href.includes("computer")) {
                    const tempLrcLine = document.querySelector(".clock-bottom");
                    if (tempLrcLine) {
                        let n = tempLrcLine.className.includes("clock-player-turn");
                        setInterval(() => {
                            const migrationBarrier = document.querySelector(".clock-bottom").className.includes("clock-player-turn");
                            if (n !== migrationBarrier) {
                                n = migrationBarrier;
                                curr()
                            }
                        }, 50)
                    }
                } else {

                }
            }
            getPgn(s, type) {
                const i = s.indexOf("=");
                return -1 != i ? s.substring(0, i + 1) + type + s.substring(i + 1) : type + s
            }
            getAllMoves() {
                const pipelets = document.querySelectorAll(".move");
                let t = [];
                return pipelets.forEach((fieldsetLabel) => {
                    var n;
                    var r;
                    const selected = fieldsetLabel.querySelector(".white");
                    if (selected && selected.textContent) {
                        const bar_node = selected.querySelector(".icon-font-chess");
                        let r = selected.textContent;
                        if (bar_node) {
                            const keepLayersOrder = null !== (n = bar_node.getAttribute("data-figurine")) && void 0 !== n ? n : "";
                            r = this.getPgn(r, keepLayersOrder)
                        }
                        t.push(r)
                    }
                    const button = fieldsetLabel.querySelector(".black");
                    if (button && button.textContent) {
                        const bar_node = button.querySelector(".icon-font-chess");
                        let n = button.textContent;
                        if (bar_node) {
                            const nameCountFunc = null !== (r = bar_node.getAttribute("data-figurine")) && void 0 !== r ? r : "";
                            n = this.getPgn(n, nameCountFunc)
                        }
                        t.push(n)
                    }
                }), t
            }
            tryToStartNewGame() {
                var tag;
                var file;
                try {
                    const header = [...document.querySelector(".new-game-buttons-component").children][0];
                    if (null === (file = null === (tag = header.lastChild)
                        || void 0 === tag ? void 0 : tag.textContent)
                        || void 0 === file ? void 0 : file.includes("New")) {
                        setTimeout(() => {
                            header.click()
                        }, genInt(600, 1700));
                        //header.click()
                    }
                } catch (e) {
                }
            }
        }
        const callback = (data) => {
            chrome.runtime.sendMessage(data)
        };
        var __awaiter =
            function (thisArg, _arguments, P, generator) {
                return new(P || (P = Promise))(function (expect, reject) {
                    function fulfilled(value) {
                        try {
                            step(generator.next(value))
                        } catch (createConnectionErr) {
                            reject(createConnectionErr)
                        }
                    }

                    function rejected(value) {
                        try {
                            step(generator.throw(value))
                        } catch (createConnectionErr) {
                            reject(createConnectionErr)
                        }
                    }

                    function step(result) {
                        var x;
                        if (result.done) expect(result.value);
                        else(x = result.value, x instanceof P ? x : new P(function (resolve) {
                            resolve(x)
                        })).then(fulfilled, rejected)
                    }
                    step((generator =
                        generator.apply(thisArg, _arguments || [])).next())
                })
            };
        class Nucleus {
            constructor() {
                var validate;
                this.backgroundMessage = "";
                this.currentDepth = "";
                this.currentRound = 0;
                validate = (schema) => {
                    if ("stockfish" === schema.type && (schema.message.includes("pv") || schema.message.includes("bestmove"))) return this.backgroundMessage = schema.message, this.currentRound = schema.round, schema
                };
                chrome.runtime.onMessage.addListener((itemSchema, n, canCreateDiscussions) => {
                    validate(itemSchema)
                })
            }
            startNewGame() {
                chrome.runtime.sendMessage({
                    type: "stockfish",
                    message: "uci"
                })
            }
            getBestMove(genes,
                nucleus) {
                return __awaiter(this, void 0, void 0, function* () {
                    return this.currentRound++, callback({
                        type: "stockfish",
                        message: "stop"
                    }), callback({
                        type: "stockfish",
                        message: `go depth ${nucleus}`,
                        position: `position fen ${genes}`
                    }), new Promise((resolve, canCreateDiscussions) => {
                        const n = this.currentRound;
                        const target = setInterval(() => {
                            if (this.currentRound > n && (clearInterval(target), resolve("")), "bestmove" === this.backgroundMessage.substring(0, 8)) {
                                const map = this.backgroundMessage.split(" ");
                                const num_elements = map.indexOf("bestmove") +
                                    1;
                                const currentPriceList = map[num_elements];
                                clearInterval(target);
                                resolve(currentPriceList)
                            }
                        }, 100)
                    })
                })
            }
            keepFindingBestMove(i, dt, entity) {
                return __awaiter(this, void 0, void 0, function* () {
                    this.currentRound++;
                    callback({
                        type: "stockfish",
                        message: "stop"
                    });
                    callback({
                        type: "stockfish",
                        message: `go depth ${dt}`,
                        position: `position fen ${i}`
                    });
                    const logIntervalId = setInterval(() => {
                        const e = this.currentRound;
                        if (this.currentRound > e) {
                            clearInterval(logIntervalId);
                            entity("")
                        }
                        let args = this.backgroundMessage.split(" ");
                        const callbackPosition =
                            args.indexOf("depth") + 1;
                        let buffer = 0;
                        let value = "";
                        if (this.backgroundMessage.includes("pv") && this.currentDepth !== args[callbackPosition]) {
                            buffer = args.indexOf("pv") + 1;
                            this.currentDepth = args[callbackPosition];
                            value = args[buffer]
                        } else if ("bestmove" === this.backgroundMessage.substring(0, 8)) {
                            buffer = args.indexOf("bestmove") + 1;
                            this.currentDepth = "";
                            value = args[buffer];
                            clearInterval(logIntervalId)
                        }
                        if ("" !== value) entity(value)
                    }, 100)
                })
            }
            stopAnalyzing() {
                return callback({
                    type: "stockfish",
                    message: "stop"
                }), new Promise((cb,
                    canCreateDiscussions) => {
                    const logIntervalId = setInterval(() => {
                        if ("" === this.backgroundMessage) {
                            clearInterval(logIntervalId);
                            cb("TODO")
                        } else if ("bestmove" === this.backgroundMessage.substring(0, 8)) {
                            const mutationsMap = this.backgroundMessage;
                            this.backgroundMessage = "";
                            clearInterval(logIntervalId);
                            cb(mutationsMap)
                        }
                    }, 100)
                })
            }
            getEvaluation(entity, i) {
                return callback({
                    type: "stockfish",
                    message: `go depth ${i}`,
                    position: entity,
                    depth: i
                }), new Promise((saveNotifs, canCreateDiscussions) => {
                    const logIntervalId = setInterval(() => {
                        if ("info" === this.backgroundMessage.substring(0, 4)) {
                            const item = this.backgroundMessage.split(" ");
                            const depsType = item.indexOf("score") + 2;
                            const notifications = item[depsType];
                            saveNotifs(notifications);
                            clearInterval(logIntervalId)
                        }
                    }, 100)
                })
            }
        }
        var c = a(437);
        var grouper = a.n(c);
        class Router {
            constructor() {
                this.RED_SQUARE_CLASS_NAME = r(20);
                this.getPlayerColour = () => {
                    return document.querySelector(".cg-wrap").classList.contains("orientation-black") ? "black" : "white"
                }
            }
            isMyTurn() {
                const subHeading = document.querySelector(".rclock-bottom");
                const barra = subHeading.textContent;
                const count = barra.substring(barra.length - 2, barra.length);
                const selected = document.querySelector("#main-wrap > main > div.round__app.variant-standard > div.expiration.expiration-bottom.bar-glider");
                const isFieldDate = !!(selected && selected.textContent && selected.textContent.includes("first move"));
                return subHeading.classList.contains("running") || isFieldDate || "00" === count
            }
            amIWhite() {
                return false
            }
            getMyTimeInSeconds() {
                return 1E5
            }
            getOpponentTimeInSeconds() {
                return 1E5
            }
            makeMove(next,
                curr) {
                const config = this.getPlayerColour();
                const previewElt = document.querySelector("cg-board");
                const {
                    left: left,
                    top: top,
                    width: width
                } = previewElt.getBoundingClientRect();
                const {
                    startX: startX,
                    startY: startY,
                    endX: endX,
                    endY: endY
                } = update(next, curr, config, left, top, width);
                getCell(startX, startY, "D");
                getCell(startX, startY, "U");
                getCell(endX, endY, "D");
                getCell(endX, endY, "U")
            }
            promote(props, datum) {
                const idx = this.getPlayerColour();
                const previewElt = document.querySelector("cg-board");
                const {
                    left: left,
                    top: top,
                    width: width
                } =
                previewElt.getBoundingClientRect();
                const {
                    x: x,
                    y: y
                } = UIManager(props, datum, idx, left, top, width);
                getCell(x, y, "D");
                getCell(x, y, "U")
            }
            draw(fn) {}
            clearAllDrawings() {}
            onNewMove(cb) {
                let initialLetter = this.getAllMoves().length;
                window.setInterval(() => {
                    const letterCandidate = this.getAllMoves().length;
                    if (letterCandidate !== initialLetter) {
                        initialLetter = letterCandidate;
                        cb()
                    }
                }, 50)
            }
            getAllMoves() {
                var vsection;
                var settingbarRow;
                var n;
                const ELEMENT_NODE = document.querySelector(".flip");
                const pipelets = null !== (n = null === (settingbarRow =
                    null === (vsection = null == ELEMENT_NODE ? void 0 : ELEMENT_NODE.parentElement) || void 0 === vsection ? void 0 : vsection.nextElementSibling) || void 0 === settingbarRow ? void 0 : settingbarRow.childNodes) && void 0 !== n ? n : [];
                const results = [];
                return pipelets.forEach((elem) => {
                    if (elem.textContent && elem.textContent.length > 1) results.push(elem.textContent)
                }), results
            }
            tryToStartNewGame() {
                const e = document.querySelector("#main-wrap > main > div.round__app.variant-standard > div.rcontrols > div > a:nth-child(2)");
                if (e && "New opponent" ===
                    e.textContent) e.click()
            }
        }
        var exports = function (thisArg, _arguments, P, generator) {
            return new(P || (P = Promise))(function (moment, search) {
                function handlePossibleRedirection(data) {
                    try {
                        render(generator.next(data))
                    } catch (complexObj) {
                        search(complexObj)
                    }
                }

                function test(value) {
                    try {
                        render(generator.throw(value))
                    } catch (complexObj) {
                        search(complexObj)
                    }
                }

                function render(end) {
                    var x;
                    if (end.done) moment(end.value);
                    else(x = end.value, x instanceof P ? x : new P(function (resolve) {
                        resolve(x)
                    })).then(handlePossibleRedirection, test)
                }
                render((generator = generator.apply(thisArg, _arguments || [])).next())
            })
        };
        chrome.runtime.onMessage.addListener(function (s) {
            if ("start" === s.type) callback({
                type: "start"
            });
            else if ("pause" === s.type) callback({
                type: "pause"
            });
            else if ("instant" === s.type) callback({
                type: "instant"
            });
        });
        function genInt(n, x) {
            return Math.floor(Math.random() * (x - n + 1) + n)
        }
        function chance(percent = "10%") {
            return (genInt(1, 100) <= parseFloat(percent.replace("%", "")));
        }
        const createClient = (game, fn, instant) => {
            return exports(void 0, void 0, void 0, function* () {
                setTimeout(() => {
                    return exports(void 0, void 0, void 0, function* () {
                        let {
                            extensionActive: r,
                            elo: eRating,
                            depthValue: e,
                            maxWaitTime: b,
                            highlightMoves: hlM,
                            automove: rOffset,
                            bongcloud: gOffset,
                            voice: info,
                            moveKeybind: mKb,
                            exitKeybind: eKb
                        } = yield map();
                        if (e || (e = 10), !r) return;
                        const deprecatedStylingMethods =
                            game.getAllMoves();
                        const t = new (grouper());
                        var totalMoves = deprecatedStylingMethods.length;
                        deprecatedStylingMethods.forEach((delta) => {
                            t.move(delta)
                        });
                        let input = "";
                        if (gOffset) input = ((canCreateDiscussions, _game) => {
                            if (_game.amIWhite()) {
                                if (0 === canCreateDiscussions) return "f2f3";
                                if (2 === canCreateDiscussions) return "e1f2"
                            } else {
                                if (1 === canCreateDiscussions) return "f7f6";
                                if (3 === canCreateDiscussions) return "e8f7"
                            }
                            return ""
                        })(deprecatedStylingMethods.length, game);
                        if ("" === input) input = yield fn.getBestMove(t.fen(), e);
                        game.clearAllDrawings();
                        const self = Stoke.fromSquare(input.substring(0, 2));
                        const x = Stoke.fromSquare(input.substring(2, 4));
                        if (game.isMyTurn() && 4 === input.length) {
                            const textToSay = input.substring(0, 2) + " to " + input.substring(2, 4);
                            //const utterance = new SpeechSynthesisUtterance(textToSay);
                            //window.speechSynthesis.cancel();
                            //window.speechSynthesis.speak(utterance);
                            ((text) => {
                                chrome.storage.local.set({
                                    voiceMessage: text
                                })
                            })(textToSay)
                        }
                        if (hlM) {
                            game.draw(self);
                            game.draw(x);
                        }

                        /* ******************************************** */
                        /*    Calculate MoveTime （是一个非常难的算法）    */

                        const debugTimings = true;

                        let initialValue = b;
                        let moveTime = (initialValue * 1000);
                        let timeBeforeStealth = moveTime;
                        if (true) {
                            if (debugTimings) console.log("[STEALTH] Stealth mode is enabled!, calculating move time...");

                            /* ------- Humanize Step: [111] ------- */
                            // Initial Randomization. Also check that the
                            // moveTime is not too low, if so, add some
                            // extra delay.

                            moveTime = (Math.random()) * moveTime;
                            if (moveTime < 330) {
                                const gT = genInt(100, 200);
                                moveTime += gT;
                                if (debugTimings) console.log("[STEALTH] Increased by " + gT + "ms due to being lower than 330ms initial value. New Time: " + moveTime);
                            }

                            /* ------- Humanize Step: [222] ------- */
                            // Calculate the distance between the two locations,
                            // if less than 1.9, the moveTime is reduced by 50%
                            // if greater than 4.4, the moveTime is increased by 31%
                            // if greater than 6.2, the moveTime is increased by 46%

                            try {
                                const loc1 = input.substring(0, 2);
                                const loc2 = input.substring(2, 4);
                                //if (debugTimings) console.log("[STEALTH] Calculating distance between " + loc1 + " and " + loc2 + "...");
                                // Assuming a standard chess board is 8x8, create a 2D array of the board
                                const board = Array.from(Array(8), () => new Array(8).fill(0));
                                // Place the loc1 and loc2 in the 2D array in their proper positions based on their chess string values, e.g. "f2" as loc1 and "f6" as loc2
                                // Location 1
                                switch (loc1[0]) {
                                    case "a":
                                        board[parseInt(loc1[1]) - 1][0] = 1;
                                        break;
                                    case "b":
                                        board[parseInt(loc1[1]) - 1][1] = 1;
                                        break;
                                    case "c":
                                        board[parseInt(loc1[1]) - 1][2] = 1;
                                        break;
                                    case "d":
                                        board[parseInt(loc1[1]) - 1][3] = 1;
                                        break;
                                    case "e":
                                        board[parseInt(loc1[1]) - 1][4] = 1;
                                        break;
                                    case "f":
                                        board[parseInt(loc1[1]) - 1][5] = 1;
                                        break;
                                    case "g":
                                        board[parseInt(loc1[1]) - 1][6] = 1;
                                        break;
                                    case "h":
                                        board[parseInt(loc1[1]) - 1][7] = 1;
                                        break;
                                }
                                // Location 2
                                switch (loc2[0]) {
                                    case "a":
                                        board[parseInt(loc2[1]) - 1][0] = 1;
                                        break;
                                    case "b":
                                        board[parseInt(loc2[1]) - 1][1] = 1;
                                        break;
                                    case "c":
                                        board[parseInt(loc2[1]) - 1][2] = 1;
                                        break;
                                    case "d":
                                        board[parseInt(loc2[1]) - 1][3] = 1;
                                        break;
                                    case "e":
                                        board[parseInt(loc2[1]) - 1][4] = 1;
                                        break;
                                    case "f":
                                        board[parseInt(loc2[1]) - 1][5] = 1;
                                        break;
                                    case "g":
                                        board[parseInt(loc2[1]) - 1][6] = 1;
                                        break;
                                    case "h":
                                        board[parseInt(loc2[1]) - 1][7] = 1;
                                        break;
                                }
                                //if(debugTimings) console.log("[STEALTH] Board: " + board);
                                // Calculate the distance between the two 1's in the 2D array
                                let x1, y1, x2, y2;
                                for (let i = 0; i < board.length; i++) {
                                    for (let j = 0; j < board[i].length; j++) {
                                        if (board[i][j] === 1) {
                                            if (x1 === undefined) {
                                                //if(debugTimings) console.log("[STEALTH] Found loc1 at x: " + j + ", y: " + i);
                                                x1 = j;
                                                y1 = i;
                                            } else {
                                                //if(debugTimings) console.log("[STEALTH] Found loc2 at x: " + j + ", y: " + i);
                                                x2 = j;
                                                y2 = i;
                                            }
                                        }
                                    }
                                }
                                const distanceX = Math.abs(x1 - x2);
                                const distanceY = Math.abs(y1 - y2);
                                const distance = Math.sqrt(Math.pow(distanceX, 2) + Math.pow(distanceY, 2));
                                //if(debugTimings) console.log("[STEALTH] Calculated Distance: " + distance);
                                // If the distance is less than 1.9,
                                if (distance < 1.9) {
                                    moveTime = moveTime / 2;
                                    if (debugTimings) console.log("[STEALTH] Distance less than 1.9, Reducing moveTime by 50%. New Time: " + moveTime);
                                };
                                // If the distance is greater than 5,
                                if (distance > 4.4) {
                                    if (distance > 6.2) {
                                        moveTime = moveTime * 1.46;
                                        if (debugTimings) console.log("[STEALTH] Distance greater than 6.2, Increasing moveTime by 46%. New Time: " + moveTime);
                                    } else {
                                        moveTime = moveTime * 1.31;
                                        if (debugTimings) console.log("[STEALTH] Distance greater than 4.4, Increasing moveTime by 31%. New Time: " + moveTime);
                                    }
                                };
                            } catch (e) {
                                // This means it must be a promotion move
                                moveTime += genInt(50, 300);
                            }

                            /* ------- Humanize Step: [333] ------- */
                            // Check if the move is one of the opening moves, if so, reduce the moveTime by 83%
                            // Also check if it is a late game or EXTRA late game move. If so, increase the moveTime accordingly.

                            let baseMemorizedMoves = 8;
                            baseMemorizedMoves = baseMemorizedMoves + genInt(-4, 4);
                            if (debugTimings) console.log("[STEALTH] There are " + totalMoves + " completed moves.");
                            if (totalMoves < baseMemorizedMoves) {
                                let reduc = parseFloat("0.1" + genInt(0, 9).toString())
                                moveTime = moveTime * parseFloat("0.1" + genInt(0, 9).toString());
                                if (debugTimings) console.log("[STEALTH] Move is an opening move (M-" + totalMoves + `). Reducing moveTime by ${reduc * 100}%. New Time: ` + moveTime);
                            } else if (totalMoves > (baseMemorizedMoves + 9)) {
                                if (totalMoves > (baseMemorizedMoves + 33)) {
                                    let reduc = parseFloat("1.7" + genInt(0, 9).toString())
                                    moveTime = moveTime * reduc;
                                    if (debugTimings) console.log("[STEALTH] Move is an EXTRA late game move (M-" + totalMoves + `). Increasing moveTime by ${reduc * 100}%. New Time: ` + moveTime);
                                } else {
                                    let reduc = parseFloat("1.5" + genInt(0, 9).toString())
                                    moveTime = moveTime * reduc;
                                    if (debugTimings) console.log("[STEALTH] Move is a late game move (M-" + totalMoves + `). Increasing moveTime by ${reduc * 100}%. New Time: ` + moveTime);
                                }
                            }

                            /* ------- Humanize Step: [444] ------- */
                            // Check if we are almost out of time. If so, reduce the moveTime.

                            if (game.getMyTimeInSeconds() < 40) {
                                if (game.getMyTimeInSeconds() < 14) {
                                    if (game.getMyTimeInSeconds() > 8) {
                                        moveTime = moveTime * 0.1;
                                        if (debugTimings) console.log("[STEALTH] Less than 8 seconds remaining. Reducing moveTime by 90%. New Time: " + moveTime);
                                    } else {
                                        moveTime = moveTime * 0.3;
                                        if (debugTimings) console.log("[STEALTH] Less than 14 seconds remaining. Reducing moveTime by 70%. New Time: " + moveTime);
                                    }
                                    } else {
                                    moveTime = moveTime * 0.6;
                                    if (debugTimings) console.log("[STEALTH] Less than 40 seconds remaining. Reducing moveTime by 40%. New Time: " + moveTime);
                                }
                            }

                            /* ------- Humanize Step: [555] ------- */
                            // Check if you have a brainfart (1.6%) if so, increase moveTime by 130%.

                            if (chance("1.6666%")) {
                                moveTime = moveTime * 2.3;
                                if (debugTimings) console.log("[STEALTH] Brainfart! Increased moveTime by 130%. New Time: " + moveTime);
                            }

                            /* ------- Humanize Step: [666] ------- */
                            // Check if 10% chance of 19% increase occurs.

                            if (chance("10%")) {
                                moveTime = moveTime * 1.19;
                                if (debugTimings) console.log("[STEALTH] 10% chance of 19% increase. New Time: " + moveTime);
                            }

                            /* ------- Humanize Step: [777] ------- */
                            // Check if 7% chance of 19% decrease occurs.

                            if (chance("7%")) {
                                moveTime = moveTime * 0.81;
                                if (debugTimings) console.log("[STEALTH] 7% chance of 19% decrease. New Time: " + moveTime);
                            }

                            /* ------- Humanize Step: [888] ------- */
                            // Check if 3% chance of 54% decrease occurs.

                            if (chance("3%")) {
                                moveTime = moveTime * 0.46;
                                if (debugTimings) console.log("[STEALTH] 3% chance of 54% decrease. New Time: " + moveTime);
                            }
                        }

                        /* Perform End Operations */
                        if (moveTime < 230 || (moveTime < 699 && moveTime > 599)) {
                            const gX = genInt(100, 220);
                            moveTime += gX;
                            if (debugTimings) console.log("[STEALTH] Increased by " + gX + "ms due to being lower than 330ms late computed value or was 0.6s.");
                        } else if (moveTime > 30000) {
                            const gD = genInt(5000, 13000);
                            moveTime -= gD;
                            if (debugTimings) console.log("[STEALTH] Decreased by " + gD + "ms due to being higher than 30s late computed value.");
                        }

                        if (instant) moveTime = 0;
                        if (instant) timeBeforeStealth = 0;
                        let translatedTime = (moveTime / 1000).toFixed(1);
                        let translatedTimeBeforeStealth = (timeBeforeStealth / 1000).toFixed(1);
                        if (debugTimings) console.log("--------------------------\n\nMove Timeset Generated!\nNORMAL: [ " + translatedTimeBeforeStealth + "s ]\nSTEALTH: [ " + translatedTime + "s ]\n\n--------------------------\n");

                        /* ******************************************** */

                        if (game.isMyTurn() && (rOffset || instant)) setTimeout(() => {
                            var temp;
                            game.makeMove(self, x);
                            if (5 === (temp = input).length && ["q", "b", "k", "r"].includes(temp.substring(4))) setTimeout(() => {
                                game.promote(x, input.substring(4))
                            }, 50)
                        }, moveTime)
                    })
                }, 100)
            })
        };
        setTimeout(() => {
            exports(void 0, void 0, void 0, function* () {
                const currentlyDownKeys = {};
                let rtcConfig;
                let localhost = new Nucleus;
                const n = window.location.href;
                if (n.includes("chess.com")) rtcConfig = new MetricsData;
                else {
                    if (!n.includes("lichess.org")) throw new Error("sliced.gg - unsupported site");
                    rtcConfig = new Router
                }
                rtcConfig.onNewMove(() => {
                    return createClient(rtcConfig, localhost)
                });
                setTimeout(() => {
                    createClient(rtcConfig, localhost)
                }, 1200);
                setInterval(() => {
                    return exports(void 0, void 0, void 0, function* () {
                        const {
                            autoPlayNewGame: t
                        } = yield map();
                        if (t) rtcConfig.tryToStartNewGame()
                    })
                }, 1E3);
                const getObjectFromLocalStorage = async function(key) {
                    return new Promise((resolve, reject) => {
                      try {
                        chrome.storage.local.get(key, function(value) {
                          resolve(value[key]);
                        });
                      } catch (ex) {
                        reject(ex);
                      }
                    });
                };
                async function checkKeybinds() {
                    let moveKeybn;
                    let exitKeybn;
                    let ttsKeybn;
                    try {
                        moveKeybn = await getObjectFromLocalStorage("moveKeybind");
                        exitKeybn = await getObjectFromLocalStorage("exitKeybind");
                        ttsKeybn = await getObjectFromLocalStorage("ttsKeybind");
                    } catch (e) {
                        //console.error(e);
                    }
                        if (currentlyDownKeys[moveKeybn]) {
                            //console.log("[Instant Move]");
                            createClient(rtcConfig, localhost, true);
                        }
                        if (currentlyDownKeys[exitKeybn]) {
                            rtcConfig.clearAllDrawings();
                            chrome.storage.local.set({ extensionActive: false });
                            callback({
                                type: "pause"
                            });
                        }
                        if (currentlyDownKeys[ttsKeybn]) {
                            chrome.storage.local.get(["voiceMessage"], function (canCreateDiscussions) {
                                const textToSpeak = canCreateDiscussions.voiceMessage;
                                const utterance = new SpeechSynthesisUtterance(textToSpeak);
                                window.speechSynthesis.cancel();
                                window.speechSynthesis.speak(utterance)
                            })
                        }
                }
                document.onkeydown = function (e) {
                    var ev = window.event ? event : e;
                    currentlyDownKeys[ev.code] = true;
                    //console.error(currentlyDownKeys)
                    checkKeybinds();
                };
                document.onkeyup = function (e) {
                    var ev = window.event ? event : e;
                    currentlyDownKeys[ev.code] = false;
                    checkKeybinds();
                };
                chrome.runtime.onMessage.addListener(function (s) {
                    if ("start" === s.type) { createClient(rtcConfig, localhost, false) } else if ("instant" === s.type) {
                        //console.log("[Instant Move]");
                        //createClient(rtcConfig, localhost, true);
                    }
                })
            })
        }, 750);
    })()
})();
