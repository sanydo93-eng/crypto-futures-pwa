"""Placeholder strategy: EMA crossover filtered by RSI.

This exists so the pipeline is runnable end to end today. It is meant to be
replaced by (or sit alongside) the real entry rules — add a new module next to
this one, decorate it with @register("your-name"), and set STRATEGY in .env.
"""

from __future__ import annotations

from .. import indicators as ind
from ..models import Candle, Side, Signal
from .base import Strategy, register


@register("ema_rsi")
class EmaRsiStrategy(Strategy):
    def __init__(self, params: dict[str, str] | None = None) -> None:
        super().__init__(params)
        self.fast = self.param_int("EMA_FAST", 12)
        self.slow = self.param_int("EMA_SLOW", 26)
        self.rsi_period = self.param_int("RSI_PERIOD", 14)
        self.rsi_long_max = self.param_float("RSI_LONG_MAX", 70.0)
        self.rsi_short_min = self.param_float("RSI_SHORT_MIN", 30.0)
        self.atr_period = self.param_int("ATR_PERIOD", 14)
        self.atr_stop_mult = self.param_float("ATR_STOP_MULT", 1.5)
        self.rr_targets = [
            self.param_float("RR_TP1", 1.0),
            self.param_float("RR_TP2", 2.0),
        ]
        self.warmup = max(self.slow, self.rsi_period, self.atr_period) + 10

    def evaluate(self, symbol: str, candles: list[Candle]) -> Signal | None:
        if len(candles) < self.warmup:
            return None

        closes = ind.closes(candles)
        fast = ind.ema(closes, self.fast)
        slow = ind.ema(closes, self.slow)
        rsis = ind.rsi(closes, self.rsi_period)
        atrs = ind.atr(candles, self.atr_period)

        if None in (fast[-1], fast[-2], slow[-1], slow[-2], rsis[-1], atrs[-1]):
            return None

        crossed_up = fast[-2] <= slow[-2] and fast[-1] > slow[-1]
        crossed_down = fast[-2] >= slow[-2] and fast[-1] < slow[-1]

        last = candles[-1]
        price = last.close
        atr_now = float(atrs[-1])
        rsi_now = float(rsis[-1])

        if crossed_up and rsi_now < self.rsi_long_max:
            side = Side.LONG
            stop = price - self.atr_stop_mult * atr_now
        elif crossed_down and rsi_now > self.rsi_short_min:
            side = Side.SHORT
            stop = price + self.atr_stop_mult * atr_now
        else:
            return None

        risk = abs(price - stop)
        targets = [
            price + rr * risk if side is Side.LONG else price - rr * risk
            for rr in self.rr_targets
        ]

        return Signal(
            symbol=symbol,
            side=side,
            strategy=self.name,
            candle_ts=last.ts,
            price=price,
            stop_loss=stop,
            take_profits=targets,
            reasons=[
                f"EMA{self.fast}/EMA{self.slow} crossover "
                f"({'bullish' if side is Side.LONG else 'bearish'})",
                f"RSI({self.rsi_period}) = {rsi_now:.1f}",
                f"ATR({self.atr_period}) = {atr_now:.6g}",
            ],
        )
