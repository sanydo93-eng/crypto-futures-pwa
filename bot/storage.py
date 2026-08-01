"""SQLite persistence for signals and their trade outcomes.

Everything the app and the statistics need lives here, including a snapshot of
the candles at signal time so a chart can be redrawn later without refetching
from the exchange.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from typing import Any

from .models import Candle, Side, Signal

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS signals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol          TEXT    NOT NULL,
    side            TEXT    NOT NULL,
    strategy        TEXT    NOT NULL,
    granularity     INTEGER NOT NULL,
    candle_ts       INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    entry           REAL    NOT NULL,
    stop_loss       REAL,
    take_profits    TEXT    NOT NULL DEFAULT '[]',
    strength        REAL    NOT NULL DEFAULT 0,
    grade           TEXT    NOT NULL DEFAULT '',
    factors         TEXT    NOT NULL DEFAULT '[]',
    reasons         TEXT    NOT NULL DEFAULT '[]',
    zone            TEXT,
    candles         TEXT    NOT NULL DEFAULT '[]',
    UNIQUE(strategy, symbol, candle_ts)
);

CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id       INTEGER NOT NULL REFERENCES signals(id),
    status          TEXT    NOT NULL,
    opened_at       INTEGER NOT NULL,
    deadline        INTEGER NOT NULL,
    closed_at       INTEGER,
    exit_price      REAL,
    exit_reason     TEXT,
    tps_hit         INTEGER NOT NULL DEFAULT 0,
    stop_at         REAL,
    pnl_pct         REAL,
    r_multiple      REAL,
    max_favorable_r REAL NOT NULL DEFAULT 0,
    max_adverse_r   REAL NOT NULL DEFAULT 0,
    last_checked_ts INTEGER NOT NULL DEFAULT 0,
    UNIQUE(signal_id)
);

CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_status   ON trades(status);
"""


class Storage:
    def __init__(self, path: str) -> None:
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        self._conn.commit()
        log.info("storage ready at %s", path)

    def close(self) -> None:
        self._conn.close()

    # -- signals -----------------------------------------------------------

    def already_sent(self, strategy: str, symbol: str, candle_ts: int) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM signals WHERE strategy=? AND symbol=? AND candle_ts=?",
            (strategy, symbol, candle_ts),
        ).fetchone()
        return row is not None

    def last_signal(self, strategy: str, symbol: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM signals WHERE strategy=? AND symbol=? ORDER BY candle_ts DESC LIMIT 1",
            (strategy, symbol),
        ).fetchone()

    def save_signal(
        self,
        signal: Signal,
        granularity: int,
        candles: list[Candle],
        max_hold_seconds: int,
    ) -> int:
        now = int(time.time() * 1000)
        cur = self._conn.execute(
            """
            INSERT INTO signals (symbol, side, strategy, granularity, candle_ts, created_at,
                                 entry, stop_loss, take_profits, strength, grade, factors,
                                 reasons, zone, candles)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                signal.symbol,
                signal.side.value,
                signal.strategy,
                granularity,
                signal.candle_ts,
                now,
                signal.price,
                signal.stop_loss,
                json.dumps(signal.take_profits),
                signal.strength,
                signal.grade,
                json.dumps(signal.factors, ensure_ascii=False),
                json.dumps(signal.reasons, ensure_ascii=False),
                json.dumps(signal.zone) if signal.zone else None,
                json.dumps([_candle_row(c) for c in candles[-160:]]),
            ),
        )
        signal_id = int(cur.lastrowid)

        # The clock starts at the entry candle, not at the moment we wrote the
        # row, so "no longer than a day" is measured from the trade itself.
        self._conn.execute(
            """
            INSERT INTO trades (signal_id, status, opened_at, deadline, stop_at, last_checked_ts)
            VALUES (?, 'open', ?, ?, ?, ?)
            """,
            (
                signal_id,
                signal.candle_ts,
                signal.candle_ts + max_hold_seconds * 1000,
                signal.stop_loss,
                signal.candle_ts,
            ),
        )
        self._conn.commit()
        signal.id = signal_id
        return signal_id

    # -- trades ------------------------------------------------------------

    def open_trades(self) -> list[sqlite3.Row]:
        return list(
            self._conn.execute(
                """
                SELECT t.*, s.symbol, s.side, s.entry, s.stop_loss, s.take_profits,
                       s.granularity, s.strategy, s.strength, s.grade
                FROM trades t JOIN signals s ON s.id = t.signal_id
                WHERE t.status = 'open'
                ORDER BY t.opened_at
                """
            ).fetchall()
        )

    def update_trade_progress(
        self,
        trade_id: int,
        tps_hit: int,
        stop_at: float | None,
        max_favorable_r: float,
        max_adverse_r: float,
        last_checked_ts: int,
    ) -> None:
        self._conn.execute(
            """
            UPDATE trades SET tps_hit=?, stop_at=?, max_favorable_r=?, max_adverse_r=?,
                              last_checked_ts=?
            WHERE id=?
            """,
            (tps_hit, stop_at, max_favorable_r, max_adverse_r, last_checked_ts, trade_id),
        )
        self._conn.commit()

    def close_trade(
        self,
        trade_id: int,
        status: str,
        closed_at: int,
        exit_price: float,
        exit_reason: str,
        pnl_pct: float,
        r_multiple: float,
    ) -> None:
        self._conn.execute(
            """
            UPDATE trades SET status=?, closed_at=?, exit_price=?, exit_reason=?,
                              pnl_pct=?, r_multiple=?
            WHERE id=?
            """,
            (status, closed_at, exit_price, exit_reason, pnl_pct, r_multiple, trade_id),
        )
        self._conn.commit()

    # -- reads for the API -------------------------------------------------

    def feed(self, limit: int = 50, offset: int = 0, symbol: str | None = None) -> list[dict]:
        query = """
            SELECT s.*, t.status, t.closed_at, t.exit_price, t.exit_reason, t.tps_hit,
                   t.pnl_pct, t.r_multiple, t.deadline, t.max_favorable_r, t.max_adverse_r
            FROM signals s LEFT JOIN trades t ON t.signal_id = s.id
        """
        params: list[Any] = []
        if symbol:
            query += " WHERE s.symbol = ?"
            params.append(symbol)
        query += " ORDER BY s.created_at DESC LIMIT ? OFFSET ?"
        params += [limit, offset]
        # Feed cards draw their own chart, so they need candles — just fewer of
        # them than the detail view, to keep the payload small.
        return [_signal_dict(r, candle_limit=60) for r in self._conn.execute(query, params)]

    def signal_detail(self, signal_id: int) -> dict | None:
        row = self._conn.execute(
            """
            SELECT s.*, t.status, t.closed_at, t.exit_price, t.exit_reason, t.tps_hit,
                   t.pnl_pct, t.r_multiple, t.deadline, t.max_favorable_r, t.max_adverse_r
            FROM signals s LEFT JOIN trades t ON t.signal_id = s.id
            WHERE s.id = ?
            """,
            (signal_id,),
        ).fetchone()
        return _signal_dict(row, candle_limit=None) if row else None

    def closed_trades(self) -> list[sqlite3.Row]:
        return list(
            self._conn.execute(
                """
                SELECT t.*, s.symbol, s.side, s.strength, s.grade, s.strategy, s.entry
                FROM trades t JOIN signals s ON s.id = t.signal_id
                WHERE t.status != 'open'
                ORDER BY t.closed_at DESC
                """
            ).fetchall()
        )

    def symbols_seen(self) -> list[str]:
        return [r["symbol"] for r in self._conn.execute("SELECT DISTINCT symbol FROM signals ORDER BY symbol")]


def _candle_row(c: Candle) -> list[float]:
    # Snapshots are only ever redrawn as a chart, so full float precision is
    # dead weight on a mobile connection: 8 significant figures is far more
    # than a few hundred pixels of chart can resolve.
    return [c.ts, _round(c.open), _round(c.high), _round(c.low), _round(c.close), round(c.volume, 2)]


def _round(value: float) -> float:
    return float(f"{value:.8g}")


def _signal_dict(row: sqlite3.Row, candle_limit: int | None) -> dict:
    data = {
        "id": row["id"],
        "symbol": row["symbol"],
        "side": row["side"],
        "strategy": row["strategy"],
        "granularity": row["granularity"],
        "candle_ts": row["candle_ts"],
        "created_at": row["created_at"],
        "entry": row["entry"],
        "stop_loss": row["stop_loss"],
        "take_profits": json.loads(row["take_profits"]),
        "strength": row["strength"],
        "grade": row["grade"],
        "factors": json.loads(row["factors"]),
        "reasons": json.loads(row["reasons"]),
        "zone": json.loads(row["zone"]) if row["zone"] else None,
        "status": row["status"],
        "closed_at": row["closed_at"],
        "exit_price": row["exit_price"],
        "exit_reason": row["exit_reason"],
        "tps_hit": row["tps_hit"],
        "pnl_pct": row["pnl_pct"],
        "r_multiple": row["r_multiple"],
        "deadline": row["deadline"],
        "max_favorable_r": row["max_favorable_r"],
        "max_adverse_r": row["max_adverse_r"],
    }
    candles = json.loads(row["candles"])
    data["candles"] = candles[-candle_limit:] if candle_limit else candles
    return data


def side_of(row: sqlite3.Row) -> Side:
    return Side(row["side"])
