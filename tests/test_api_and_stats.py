"""API surface and the statistics the app renders."""

import asyncio

import pytest
from aiohttp.test_utils import TestClient, TestServer

from bot import stats as stats_module
from bot.api import build_app
from bot.config import Config
from bot.models import Candle, Side, Signal
from bot.storage import Storage
from bot.tracker import TradeTracker

TS = 1_700_000_000_000
STEP = 900_000


@pytest.fixture
def store(tmp_path):
    storage = Storage(str(tmp_path / "signals.db"))
    yield storage
    storage.close()


@pytest.fixture
def config():
    return Config.from_env(
        {"TELEGRAM_BOT_TOKEN": "1:x", "TELEGRAM_CHAT_ID": "@c", "SYMBOLS": "XBTUSDTM"}
    )


def _signal(symbol="XBTUSDTM", side=Side.LONG, ts=TS, strength=72.0) -> Signal:
    return Signal(
        symbol=symbol,
        side=side,
        strategy="fvg_retest",
        candle_ts=ts,
        price=100.0,
        stop_loss=95.0,
        take_profits=[107.5, 115.0],
        strength=strength,
        grade="B",
        factors=[{"name": "trend", "label": "Тренд", "score": 25, "max": 25, "note": "ок"}],
        reasons=["Ретест бычьей FVG-зоны"],
        zone={"side": "LONG", "top": 99.0, "bottom": 96.0, "created_ts": TS - STEP, "touches": 0},
    )


def _candles(count=5):
    return [
        Candle(ts=TS - (count - i) * STEP, open=100, high=101, low=99, close=100, volume=10)
        for i in range(count)
    ]


def _seed(store, signal):
    store.save_signal(signal, granularity=15, candles=_candles(), max_hold_seconds=86400)


def _request(app, path):
    async def go():
        async with TestClient(TestServer(app)) as client:
            resp = await client.get(path)
            body = await resp.json() if resp.content_type == "application/json" else None
            return resp.status, body

    return asyncio.run(go())


# -- storage / dedup ------------------------------------------------------


def test_signal_round_trips_through_storage(store):
    _seed(store, _signal())
    detail = store.signal_detail(1)

    assert detail["symbol"] == "XBTUSDTM"
    assert detail["side"] == "LONG"
    assert detail["take_profits"] == [107.5, 115.0]
    assert detail["zone"]["bottom"] == 96.0
    assert detail["reasons"] == ["Ретест бычьей FVG-зоны"]
    assert detail["status"] == "open"
    assert len(detail["candles"]) == 5, "candles are snapshotted for redrawing the chart"


def test_the_same_candle_is_only_ever_signalled_once(store):
    _seed(store, _signal())
    assert store.already_sent("fvg_retest", "XBTUSDTM", TS)
    assert not store.already_sent("fvg_retest", "XBTUSDTM", TS + STEP)
    assert not store.already_sent("ema_rsi", "XBTUSDTM", TS)


def test_feed_is_newest_first_and_filters_by_symbol(store):
    _seed(store, _signal(symbol="XBTUSDTM", ts=TS))
    _seed(store, _signal(symbol="ETHUSDTM", ts=TS + STEP))

    assert [i["symbol"] for i in store.feed()] == ["ETHUSDTM", "XBTUSDTM"]
    assert [i["symbol"] for i in store.feed(symbol="XBTUSDTM")] == ["XBTUSDTM"]
    assert store.symbols_seen() == ["ETHUSDTM", "XBTUSDTM"]


# -- statistics -----------------------------------------------------------


def _close(store, trade_row, exit_price, reason, status, r):
    store.close_trade(
        trade_id=int(trade_row["id"]),
        status=status,
        closed_at=TS + 4 * STEP,
        exit_price=exit_price,
        exit_reason=reason,
        pnl_pct=r * 5,
        r_multiple=r,
    )


def test_statistics_summarise_closed_trades(store):
    for i, (r, status) in enumerate([(3.0, "win"), (-1.0, "loss"), (1.5, "win"), (-1.0, "loss")]):
        _seed(store, _signal(ts=TS + i * STEP))
        _close(store, store.open_trades()[0], 100 + r, "tp2" if r > 0 else "sl", status, r)

    summary = stats_module.build(store)["overall"]
    assert summary["trades"] == 4
    assert summary["wins"] == 2 and summary["losses"] == 2
    assert summary["winrate"] == 50.0
    assert summary["total_r"] == pytest.approx(2.5)
    assert summary["avg_r"] == pytest.approx(0.625)
    assert summary["profit_factor"] == pytest.approx(2.25)
    assert summary["best_r"] == 3.0 and summary["worst_r"] == -1.0


def test_open_trades_are_excluded_from_results_but_counted(store):
    _seed(store, _signal(ts=TS))
    _seed(store, _signal(ts=TS + STEP))
    _close(store, store.open_trades()[0], 107.5, "tp1", "win", 1.5)

    summary = stats_module.build(store)["overall"]
    assert summary["trades"] == 1
    assert summary["open_now"] == 1


def test_equity_curve_accumulates_in_order(store):
    for i, r in enumerate([1.0, -1.0, 2.0]):
        _seed(store, _signal(ts=TS + i * STEP))
        row = store.open_trades()[0]
        store.close_trade(int(row["id"]), "win" if r > 0 else "loss", TS + i * STEP, 100, "tp1", r * 5, r)

    curve = stats_module.build(store)["equity_curve"]
    assert [point["r"] for point in curve] == [1.0, 0.0, 2.0]


def test_breakdowns_split_by_symbol_and_strength(store):
    _seed(store, _signal(symbol="XBTUSDTM", strength=85.0, ts=TS))
    _close(store, store.open_trades()[0], 115, "tp2", "win", 3.0)
    _seed(store, _signal(symbol="ETHUSDTM", strength=57.0, ts=TS + STEP))
    _close(store, store.open_trades()[0], 95, "sl", "loss", -1.0)

    stats = stats_module.build(store)
    assert stats["by_symbol"]["XBTUSDTM"]["total_r"] == 3.0
    assert stats["by_symbol"]["ETHUSDTM"]["total_r"] == -1.0
    assert stats["by_strength"]["80-100"]["wins"] == 1
    assert stats["by_strength"]["55-67"]["losses"] == 1
    assert stats["by_exit"] == {"tp2": 1, "sl": 1}


def test_empty_statistics_do_not_divide_by_zero(store):
    summary = stats_module.build(store)["overall"]
    assert summary["trades"] == 0
    assert summary["winrate"] == 0.0
    assert summary["profit_factor"] == 0.0


# -- HTTP -----------------------------------------------------------------


def test_health_endpoint(store, config):
    status, body = _request(build_app(store, config), "/api/health")
    assert status == 200 and body == {"ok": True}


def test_feed_endpoint_returns_signals(store, config):
    _seed(store, _signal())
    status, body = _request(build_app(store, config), "/api/feed")

    assert status == 200
    assert len(body["items"]) == 1
    assert body["items"][0]["strength"] == 72.0
    assert body["symbols"] == ["XBTUSDTM"]
    assert body["items"][0]["candles"], "feed cards draw a chart, so they carry candles"


def test_feed_carries_fewer_candles_than_the_detail_view(store, config):
    many = [
        Candle(ts=TS - (100 - i) * STEP, open=100, high=101, low=99, close=100, volume=1)
        for i in range(100)
    ]
    store.save_signal(_signal(), granularity=15, candles=many, max_hold_seconds=86400)

    _, feed = _request(build_app(store, config), "/api/feed")
    _, detail = _request(build_app(store, config), "/api/signals/1")
    assert len(feed["items"][0]["candles"]) == 60
    assert len(detail["candles"]) == 100


def test_signal_detail_endpoint_includes_candles(store, config):
    _seed(store, _signal())
    status, body = _request(build_app(store, config), "/api/signals/1")
    assert status == 200
    assert body["candles"]
    assert body["factors"][0]["label"] == "Тренд"


def test_missing_signal_returns_404(store, config):
    status, _ = _request(build_app(store, config), "/api/signals/999")
    assert status == 404


def test_non_numeric_signal_id_is_rejected(store, config):
    status, _ = _request(build_app(store, config), "/api/signals/abc")
    assert status == 400


def test_stats_endpoint_matches_the_module(store, config):
    _seed(store, _signal())
    _close(store, store.open_trades()[0], 115, "tp2", "win", 3.0)
    status, body = _request(build_app(store, config), "/api/stats")
    assert status == 200
    assert body["overall"]["total_r"] == 3.0


def test_feed_limit_is_clamped_to_a_sane_range(store, config):
    for i in range(3):
        _seed(store, _signal(ts=TS + i * STEP))

    # A fresh app per call: aiohttp freezes an Application once it has served.
    def items(query):
        _, body = _request(build_app(store, config), query)
        return body["items"]

    assert len(items("/api/feed?limit=1")) == 1
    assert len(items("/api/feed?limit=99999")) == 3
    assert len(items("/api/feed?limit=nonsense")) == 3
    assert len(items("/api/feed?limit=-5")) == 1


def test_config_endpoint_exposes_runtime_settings(store, config):
    status, body = _request(build_app(store, config), "/api/config")
    assert status == 200
    assert body["max_hold_hours"] == 24.0
    assert body["strategy"] == "fvg_retest"


def test_tracked_trade_shows_up_in_the_feed_with_its_result(store, config):
    """The number in the feed comes from the tracker, not from a separate path."""
    _seed(store, _signal())
    update = TradeTracker(store).review(
        store.open_trades()[0],
        [Candle(ts=TS + STEP, open=100, high=101, low=94, close=95, volume=1)],
    )
    assert update.status == "loss"

    _, body = _request(build_app(store, config), "/api/feed")
    item = body["items"][0]
    assert item["status"] == "loss"
    assert item["exit_reason"] == "sl"
    assert item["r_multiple"] == -1.0
