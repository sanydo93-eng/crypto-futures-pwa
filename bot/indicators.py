"""Pure-python indicators. No numpy/pandas so the image stays small.

Every function takes the oldest-first series and returns a list of the same
length, with ``None`` for positions where the indicator is not defined yet.
"""

from __future__ import annotations

from .models import Candle

Series = list[float]
MaybeSeries = list[float | None]


def sma(values: Series, period: int) -> MaybeSeries:
    if period <= 0:
        raise ValueError("period must be positive")
    out: MaybeSeries = [None] * len(values)
    running = 0.0
    for i, v in enumerate(values):
        running += v
        if i >= period:
            running -= values[i - period]
        if i >= period - 1:
            out[i] = running / period
    return out


def ema(values: Series, period: int) -> MaybeSeries:
    if period <= 0:
        raise ValueError("period must be positive")
    out: MaybeSeries = [None] * len(values)
    if len(values) < period:
        return out
    k = 2 / (period + 1)
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(values: Series, period: int = 14) -> MaybeSeries:
    """Wilder's RSI."""
    out: MaybeSeries = [None] * len(values)
    if len(values) <= period:
        return out

    gains = 0.0
    losses = 0.0
    for i in range(1, period + 1):
        delta = values[i] - values[i - 1]
        gains += max(delta, 0.0)
        losses += max(-delta, 0.0)
    avg_gain = gains / period
    avg_loss = losses / period
    out[period] = _rsi_from(avg_gain, avg_loss)

    for i in range(period + 1, len(values)):
        delta = values[i] - values[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(delta, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-delta, 0.0)) / period
        out[i] = _rsi_from(avg_gain, avg_loss)
    return out


def _rsi_from(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def atr(candles: list[Candle], period: int = 14) -> MaybeSeries:
    """Wilder's ATR, used for stop-loss placement."""
    out: MaybeSeries = [None] * len(candles)
    if len(candles) <= period:
        return out

    trs: Series = [candles[0].high - candles[0].low]
    for i in range(1, len(candles)):
        prev_close = candles[i - 1].close
        c = candles[i]
        trs.append(max(c.high - c.low, abs(c.high - prev_close), abs(c.low - prev_close)))

    prev = sum(trs[1 : period + 1]) / period
    out[period] = prev
    for i in range(period + 1, len(candles)):
        prev = (prev * (period - 1) + trs[i]) / period
        out[i] = prev
    return out


def highest(values: Series, period: int) -> MaybeSeries:
    out: MaybeSeries = [None] * len(values)
    for i in range(period - 1, len(values)):
        out[i] = max(values[i - period + 1 : i + 1])
    return out


def lowest(values: Series, period: int) -> MaybeSeries:
    out: MaybeSeries = [None] * len(values)
    for i in range(period - 1, len(values)):
        out[i] = min(values[i - period + 1 : i + 1])
    return out


def closes(candles: list[Candle]) -> Series:
    return [c.close for c in candles]


def volumes(candles: list[Candle]) -> Series:
    return [c.volume for c in candles]
