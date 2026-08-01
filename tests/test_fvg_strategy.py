"""End-to-end behaviour of the zonal FVG retest strategy on synthetic price."""

import pytest

from bot.models import Candle, Side
from bot.strategies import build_strategy

TS = 1_700_000_000_000
STEP = 900_000


def _c(i, o, h, l, c, v=100.0) -> Candle:
    return Candle(ts=TS + i * STEP, open=o, high=h, low=l, close=c, volume=v)


def uptrend(count=250, start=100.0, slope=0.5) -> list[Candle]:
    """A calm rising market: EMA50 above EMA200, price above both, no gaps."""
    out = []
    for i in range(count):
        base = start + i * slope
        out.append(_c(i, base, base + 0.4, base - 0.4, base + 0.2, 100.0))
    return out


def downtrend(count=250, start=250.0, slope=0.5) -> list[Candle]:
    out = []
    for i in range(count):
        base = start - i * slope
        out.append(_c(i, base, base + 0.4, base - 0.4, base - 0.2, 100.0))
    return out


def bullish_setup(retest_close=None, retest_low=None, volume=60.0) -> list[Candle]:
    """Uptrend, an impulse leaving a gap, drift, then a retest of the gap."""
    candles = uptrend()
    n = len(candles)
    top = candles[-1].close  # ~205

    # first / displacement / third -> bullish FVG between first.high and third.low
    candles.append(_c(n, top, top + 0.5, top - 0.5, top + 0.3))
    candles.append(_c(n + 1, top + 0.3, top + 9.0, top, top + 8.5))       # impulse
    candles.append(_c(n + 2, top + 8.5, top + 10.0, top + 3.0, top + 9.0))  # gap [top+0.5, top+3.0]

    # drift higher, leaving the zone untouched
    candles.append(_c(n + 3, top + 9.0, top + 10.5, top + 8.0, top + 9.5))
    candles.append(_c(n + 4, top + 9.5, top + 10.0, top + 7.5, top + 8.0))

    # retest: dip into the zone, close back above it
    low = retest_low if retest_low is not None else top + 1.5
    close = retest_close if retest_close is not None else top + 4.0
    candles.append(_c(n + 5, top + 8.0, top + 8.2, low, close, volume))
    return candles


def test_retest_of_a_bullish_gap_produces_a_long():
    strategy = build_strategy("fvg_retest")
    signal = strategy.evaluate("XBTUSDTM", bullish_setup())

    assert signal is not None
    assert signal.side is Side.LONG
    assert signal.zone is not None
    assert signal.stop_loss < signal.zone["bottom"] < signal.price
    assert all(tp > signal.price for tp in signal.take_profits)
    assert signal.candle_ts == bullish_setup()[-1].ts


def test_signal_carries_a_scored_explanation():
    strategy = build_strategy("fvg_retest")
    signal = strategy.evaluate("XBTUSDTM", bullish_setup())

    assert 0 < signal.strength <= 100
    assert signal.grade in ("A", "B", "C", "D")
    assert {f["name"] for f in signal.factors} == {
        "trend", "freshness", "displacement", "geometry", "reaction", "volume", "rsi"
    }
    assert sum(f["score"] for f in signal.factors) == pytest.approx(signal.strength, abs=0.2)
    assert all(f["note"] for f in signal.factors), "every factor must explain itself"
    assert any("FVG" in r for r in signal.reasons)


def test_targets_sit_at_the_configured_r_multiples():
    strategy = build_strategy("fvg_retest", {"RR_TP1": "2.0", "RR_TP2": "4.0"})
    signal = strategy.evaluate("XBTUSDTM", bullish_setup())
    assert signal.r_multiple_at(signal.take_profits[0]) == pytest.approx(2.0, abs=0.01)
    assert signal.r_multiple_at(signal.take_profits[1]) == pytest.approx(4.0, abs=0.01)


def test_closing_inside_the_zone_is_not_a_retest():
    strategy = build_strategy("fvg_retest")
    top = uptrend()[-1].close
    candles = bullish_setup(retest_close=top + 2.0, retest_low=top + 1.5)  # closes in the gap
    assert strategy.evaluate("XBTUSDTM", candles) is None


def test_flat_market_gives_nothing():
    strategy = build_strategy("fvg_retest")
    flat = [_c(i, 100, 100.5, 99.5, 100) for i in range(260)]
    assert strategy.evaluate("XBTUSDTM", flat) is None


def test_no_signal_before_warmup():
    strategy = build_strategy("fvg_retest")
    assert strategy.evaluate("XBTUSDTM", bullish_setup()[-50:]) is None


def test_counter_trend_setup_is_skipped_when_trend_is_required():
    """A bullish gap inside a downtrend must not fire with REQUIRE_TREND on."""
    strategy = build_strategy("fvg_retest", {"REQUIRE_TREND": "true"})
    candles = downtrend()
    n = len(candles)
    base = candles[-1].close
    candles.append(_c(n, base, base + 0.5, base - 0.5, base))
    candles.append(_c(n + 1, base, base + 9.0, base - 0.5, base + 8.5))
    candles.append(_c(n + 2, base + 8.5, base + 10.0, base + 3.0, base + 9.0))
    candles.append(_c(n + 3, base + 9.0, base + 9.5, base + 1.5, base + 4.0))
    assert strategy.evaluate("XBTUSDTM", candles) is None


def test_strength_threshold_filters_weak_setups():
    lenient = build_strategy("fvg_retest", {"MIN_STRENGTH": "0"})
    strict = build_strategy("fvg_retest", {"MIN_STRENGTH": "99"})
    candles = bullish_setup()
    assert lenient.evaluate("XBTUSDTM", candles) is not None
    assert strict.evaluate("XBTUSDTM", candles) is None


def test_fresh_zone_scores_higher_than_a_touched_one():
    strategy = build_strategy("fvg_retest", {"MIN_STRENGTH": "0"})
    fresh = strategy.evaluate("XBTUSDTM", bullish_setup())

    top = uptrend()[-1].close
    candles = bullish_setup()
    # insert an earlier touch of the zone before the retest
    touched = candles[:-1] + [
        _c(len(candles) - 1, top + 8.0, top + 8.5, top + 2.0, top + 7.0),
        candles[-1],
    ]
    retouched = strategy.evaluate("XBTUSDTM", touched)

    assert retouched is not None
    assert retouched.strength < fresh.strength
