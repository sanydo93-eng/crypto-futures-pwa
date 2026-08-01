from bot import indicators as ind
from bot.models import Candle, Side
from bot.zones import find_zones, rejection_ratio, retested_zone

TS = 1_700_000_000_000
STEP = 900_000


def c(i, o, h, l, cl, v=100.0) -> Candle:
    return Candle(ts=TS + i * STEP, open=o, high=h, low=l, close=cl, volume=v)


def _filler(count, start=100.0, index_from=0):
    """Flat-ish candles that create no gaps, to warm ATR up."""
    return [
        c(index_from + i, start, start + 1, start - 1, start, 50.0)
        for i in range(count)
    ]


def test_bullish_gap_is_found_with_correct_bounds():
    candles = _filler(30)
    candles += [
        c(30, 100, 101, 99, 100),      # first: high = 101
        c(31, 101, 118, 100, 117),     # displacement
        c(32, 117, 120, 105, 119),     # third: low = 105 > 101 -> gap [101, 105]
    ]
    zones = find_zones(candles, ind.atr(candles, 14))
    bullish = [z for z in zones if z.side is Side.LONG]
    assert len(bullish) == 1
    assert bullish[0].bottom == 101
    assert bullish[0].top == 105


def test_bearish_gap_is_found_with_correct_bounds():
    candles = _filler(30)
    candles += [
        c(30, 100, 101, 99, 100),      # first: low = 99
        c(31, 99, 100, 82, 83),        # displacement down
        c(32, 83, 95, 80, 84),         # third: high = 95 < 99 -> gap [95, 99]
    ]
    zones = find_zones(candles, ind.atr(candles, 14))
    bearish = [z for z in zones if z.side is Side.SHORT]
    assert len(bearish) == 1
    assert bearish[0].bottom == 95
    assert bearish[0].top == 99


def test_overlapping_candles_leave_no_gap():
    candles = _filler(40)
    assert find_zones(candles, ind.atr(candles, 14)) == []


def test_zone_records_touches_when_price_returns():
    candles = _filler(30)
    candles += [
        c(30, 100, 101, 99, 100),
        c(31, 101, 118, 100, 117),
        c(32, 117, 120, 105, 119),
        c(33, 119, 120, 103, 110),     # dips into [101, 105]
        c(34, 110, 115, 108, 114),
    ]
    zone = [z for z in find_zones(candles, ind.atr(candles, 14)) if z.side is Side.LONG][0]
    assert zone.touches == 1
    assert not zone.invalidated
    assert not zone.is_fresh


def test_zone_dies_when_price_closes_through_it():
    candles = _filler(30)
    candles += [
        c(30, 100, 101, 99, 100),
        c(31, 101, 118, 100, 117),
        c(32, 117, 120, 105, 119),
        c(33, 119, 120, 90, 92),       # closes below the zone bottom (101)
    ]
    zone = [z for z in find_zones(candles, ind.atr(candles, 14)) if z.side is Side.LONG][0]
    assert zone.invalidated


def test_retest_requires_closing_back_out_of_the_zone():
    zone_candles = _filler(30) + [
        c(30, 100, 101, 99, 100),
        c(31, 101, 118, 100, 117),
        c(32, 117, 120, 105, 119),
    ]
    zones = find_zones(zone_candles, ind.atr(zone_candles, 14))

    # closes inside the zone -> not a retest
    inside = c(33, 106, 107, 102, 103)
    assert retested_zone(zones, inside, Side.LONG) is None

    # dips in and closes back above -> a retest
    rejected = c(33, 106, 108, 102, 107)
    assert retested_zone(zones, rejected, Side.LONG) is not None

    # slices clean through the zone -> not a retest
    through = c(33, 106, 107, 95, 107)
    assert retested_zone(zones, through, Side.LONG) is None


def test_rejection_ratio_measures_the_wick():
    long_wick = Candle(ts=TS, open=105, high=106, low=100, close=105.5, volume=1)
    assert rejection_ratio(long_wick, Side.LONG) > 0.7
    assert rejection_ratio(long_wick, Side.SHORT) < 0.2

    doji = Candle(ts=TS, open=100, high=100, low=100, close=100, volume=1)
    assert rejection_ratio(doji, Side.LONG) == 0.0
