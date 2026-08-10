"""The kline column order is detected from the data, so both KuCoin layouts
(futures-style OHLCV and spot-style OCHLV) must parse correctly."""

import pytest

from bot.exchange.kucoin import KuCoinError, KuCoinFutures, _detect_layout


def _rows_ohlcv():
    # [t, open, high, low, close, volume]
    return [
        [1700000000000, 100.0, 105.0, 99.0, 103.0, 12.0],
        [1700000060000, 103.0, 108.0, 102.0, 107.0, 15.0],
    ]


def _rows_ochlv():
    # [t, open, close, high, low, volume] — same candles, spot-style order
    return [
        [1700000000000, 100.0, 103.0, 105.0, 99.0, 12.0],
        [1700000060000, 103.0, 107.0, 108.0, 102.0, 15.0],
    ]


def test_detects_futures_layout():
    assert _detect_layout(_rows_ohlcv()) == "ohlcv"


def test_detects_spot_layout():
    assert _detect_layout(_rows_ochlv()) == "ochlv"


def test_both_layouts_yield_identical_candles():
    a = KuCoinFutures()._parse("XBTUSDTM", _rows_ohlcv())
    b = KuCoinFutures()._parse("XBTUSDTM", _rows_ochlv())
    assert a == b
    assert a[0].high == 105.0 and a[0].low == 99.0 and a[0].close == 103.0


def test_impossible_candle_is_rejected_rather_than_guessed():
    # high below open under every layout — data we must not trade on
    rows = [[1700000000000, 100.0, 90.0, 80.0, 85.0, 1.0], [1700000060000, 50.0, 10.0, 5.0, 7.0, 1.0]]
    assert _detect_layout(rows) is None
    with pytest.raises(KuCoinError):
        KuCoinFutures()._parse("XBTUSDTM", rows)


def test_layout_is_cached_after_first_parse():
    client = KuCoinFutures()
    client._parse("XBTUSDTM", _rows_ochlv())
    assert client._layout == "ochlv"
