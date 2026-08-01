"""Trade lifecycle: from entry to exit, capped at one day.

Every signal opens a tracked trade. On each cycle we replay the candles that
appeared since the last check and decide whether the trade hit a target, hit
the stop, or ran out of time.

Two deliberate choices:

* If a single candle touches both the stop and a target, we count the stop.
  We cannot see the intrabar order, and the honest assumption is the losing
  one — otherwise the statistics flatter themselves.
* The deadline is a hard exit at the market price of the candle that crosses
  it, so nothing sits open longer than MAX_HOLD_HOURS.
"""

from __future__ import annotations

import json
import logging
import time

from .models import Candle, Side

log = logging.getLogger(__name__)


class TradeUpdate:
    def __init__(
        self,
        trade_id: int,
        signal_id: int,
        symbol: str,
        side: Side,
        status: str,
        exit_price: float,
        exit_reason: str,
        r_multiple: float,
        pnl_pct: float,
        strength: float,
    ) -> None:
        self.trade_id = trade_id
        self.signal_id = signal_id
        self.symbol = symbol
        self.side = side
        self.status = status
        self.exit_price = exit_price
        self.exit_reason = exit_reason
        self.r_multiple = r_multiple
        self.pnl_pct = pnl_pct
        self.strength = strength


EXIT_LABELS = {
    "sl": "стоп",
    "be": "в безубыток",
    "tp1": "цель 1",
    "tp2": "цель 2",
    "tp3": "цель 3",
    "timeout": "по времени (сутки)",
}


class TradeTracker:
    def __init__(self, storage, move_stop_to_breakeven: bool = True) -> None:
        self._storage = storage
        self._move_to_be = move_stop_to_breakeven

    def review(self, trade_row, candles: list[Candle]) -> TradeUpdate | None:
        """Replay new candles for one open trade. Returns an update if it closed."""
        entry = float(trade_row["entry"])
        side = Side(trade_row["side"])
        targets: list[float] = json.loads(trade_row["take_profits"])
        original_stop = trade_row["stop_loss"]
        stop_at = trade_row["stop_at"] if trade_row["stop_at"] is not None else original_stop
        tps_hit = int(trade_row["tps_hit"])
        deadline = int(trade_row["deadline"])
        last_checked = int(trade_row["last_checked_ts"])
        risk = abs(entry - float(original_stop)) if original_stop is not None else 0.0

        best_r = float(trade_row["max_favorable_r"])
        worst_r = float(trade_row["max_adverse_r"])

        fresh = [c for c in candles if c.ts > last_checked]
        if not fresh:
            return None

        for candle in fresh:
            best_r = max(best_r, _r_at(entry, _favorable(candle, side), side, risk))
            worst_r = min(worst_r, _r_at(entry, _adverse(candle, side), side, risk))

            if stop_at is not None and _touched(candle, float(stop_at), side, adverse=True):
                reason = "be" if tps_hit > 0 and self._move_to_be else "sl"
                return self._close(trade_row, side, entry, risk, float(stop_at), reason, candle.ts)

            hit_now = tps_hit
            for level, target in enumerate(targets, start=1):
                if level <= tps_hit:
                    continue
                if _touched(candle, target, side, adverse=False):
                    hit_now = level

            if hit_now > tps_hit:
                tps_hit = hit_now
                if tps_hit >= len(targets):
                    return self._close(
                        trade_row, side, entry, risk, targets[-1], f"tp{tps_hit}", candle.ts
                    )
                if self._move_to_be:
                    stop_at = entry

            if candle.ts >= deadline:
                return self._close(trade_row, side, entry, risk, candle.close, "timeout", candle.ts)

        # Still open: persist progress so the next cycle resumes where we stopped.
        self._storage.update_trade_progress(
            trade_id=int(trade_row["id"]),
            tps_hit=tps_hit,
            stop_at=stop_at,
            max_favorable_r=round(best_r, 3),
            max_adverse_r=round(worst_r, 3),
            last_checked_ts=fresh[-1].ts,
        )

        # A deadline can fall between candles (e.g. after the last close).
        if int(time.time() * 1000) >= deadline:
            return self._close(trade_row, side, entry, risk, fresh[-1].close, "timeout", deadline)
        return None

    def _close(
        self,
        trade_row,
        side: Side,
        entry: float,
        risk: float,
        exit_price: float,
        reason: str,
        closed_at: int,
    ) -> TradeUpdate:
        r_multiple = _r_at(entry, exit_price, side, risk)
        pnl_pct = ((exit_price - entry) / entry * 100) * (1 if side is Side.LONG else -1)

        if reason == "sl":
            status = "loss"
        elif reason == "be":
            status = "breakeven"
        elif reason == "timeout":
            status = "win" if r_multiple > 0 else ("loss" if r_multiple < 0 else "breakeven")
        else:
            status = "win"

        self._storage.close_trade(
            trade_id=int(trade_row["id"]),
            status=status,
            closed_at=closed_at,
            exit_price=exit_price,
            exit_reason=reason,
            pnl_pct=round(pnl_pct, 4),
            r_multiple=round(r_multiple, 3),
        )
        log.info(
            "trade %s on %s closed: %s (%s) R=%.2f",
            trade_row["id"],
            trade_row["symbol"],
            status,
            reason,
            r_multiple,
        )
        return TradeUpdate(
            trade_id=int(trade_row["id"]),
            signal_id=int(trade_row["signal_id"]),
            symbol=trade_row["symbol"],
            side=side,
            status=status,
            exit_price=exit_price,
            exit_reason=reason,
            r_multiple=round(r_multiple, 3),
            pnl_pct=round(pnl_pct, 2),
            strength=float(trade_row["strength"]),
        )


def _touched(candle: Candle, level: float, side: Side, adverse: bool) -> bool:
    """Did price reach `level` inside this candle?"""
    going_down = (side is Side.LONG) == adverse
    return candle.low <= level if going_down else candle.high >= level


def _favorable(candle: Candle, side: Side) -> float:
    return candle.high if side is Side.LONG else candle.low


def _adverse(candle: Candle, side: Side) -> float:
    return candle.low if side is Side.LONG else candle.high


def _r_at(entry: float, price: float, side: Side, risk: float) -> float:
    if risk <= 0:
        return 0.0
    delta = price - entry if side is Side.LONG else entry - price
    return delta / risk
