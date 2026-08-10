import math

from bot import indicators as ind
from bot.models import Candle


def test_sma_matches_manual_average():
    values = [1, 2, 3, 4, 5]
    result = ind.sma(values, 3)
    assert result[:2] == [None, None]
    assert result[2:] == [2.0, 3.0, 4.0]


def test_ema_seeds_with_sma_then_smooths():
    values = [1, 2, 3, 4, 5]
    result = ind.ema(values, 3)
    assert result[:2] == [None, None]
    assert result[2] == 2.0
    k = 2 / 4
    assert math.isclose(result[3], 4 * k + 2.0 * (1 - k))


def test_rsi_is_100_on_a_pure_uptrend():
    values = list(range(1, 40))
    result = ind.rsi(values, 14)
    assert result[13] is None or result[13] == 100.0
    assert result[-1] == 100.0


def test_rsi_is_zero_on_a_pure_downtrend():
    values = list(range(40, 1, -1))
    assert ind.rsi(values, 14)[-1] == 0.0


def test_rsi_stays_in_range_on_mixed_data():
    values = [10, 11, 10.5, 12, 11.8, 13, 12.2, 12.9, 14, 13.5, 15, 14.2, 16, 15.1, 17, 16.4]
    for value in ind.rsi(values, 14):
        if value is not None:
            assert 0.0 <= value <= 100.0


def test_atr_is_positive_and_defined_after_warmup():
    candles = [
        Candle(ts=i * 60000, open=100 + i, high=102 + i, low=99 + i, close=101 + i, volume=10)
        for i in range(30)
    ]
    result = ind.atr(candles, 14)
    assert result[13] is None
    assert result[14] is not None
    assert all(v > 0 for v in result[14:])


def test_short_series_returns_all_none():
    assert ind.ema([1, 2], 10) == [None, None]
    assert ind.rsi([1, 2], 14) == [None, None]
