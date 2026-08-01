"""Trade lifecycle over a real SQLite store: targets, stops, and the 24h cap."""

import time

import pytest

from bot.models import Candle, Side, Signal
from bot.storage import Storage
from bot.tracker import TradeTracker

HOUR = 3_600_000
STEP = 900_000  # 15m

# Deadlines are wall-clock aware (a trade can time out with no new candles), so
# the fixture data sits on the current 15m boundary rather than at a fixed past
# date — otherwise every trade would already be overdue before the test runs.
TS = int(time.time() * 1000) // STEP * STEP


@pytest.fixture
def store(tmp_path):
    storage = Storage(str(tmp_path / "signals.db"))
    yield storage
    storage.close()


def _signal(side=Side.LONG, entry=100.0, stop=95.0, targets=(107.5, 115.0)) -> Signal:
    return Signal(
        symbol="XBTUSDTM",
        side=side,
        strategy="fvg_retest",
        candle_ts=TS,
        price=entry,
        stop_loss=stop,
        take_profits=list(targets),
        strength=72.0,
        grade="B",
    )


def _open(store, signal, max_hold_seconds=24 * 3600):
    store.save_signal(signal, granularity=15, candles=[], max_hold_seconds=max_hold_seconds)
    return store.open_trades()[0]


def candle(offset_steps, high, low, close=None, ts_base=TS):
    price = close if close is not None else (high + low) / 2
    return Candle(
        ts=ts_base + offset_steps * STEP,
        open=price,
        high=high,
        low=low,
        close=price,
        volume=10.0,
    )


def test_quiet_candles_leave_the_trade_open(store):
    trade = _open(store, _signal())
    tracker = TradeTracker(store)
    assert tracker.review(trade, [candle(1, 102, 99), candle(2, 103, 100)]) is None
    assert len(store.open_trades()) == 1


def test_stop_hit_closes_as_a_loss_of_one_r(store):
    trade = _open(store, _signal())
    update = TradeTracker(store).review(trade, [candle(1, 101, 94)])
    assert update.status == "loss"
    assert update.exit_reason == "sl"
    assert update.r_multiple == pytest.approx(-1.0)
    assert store.open_trades() == []


def test_final_target_closes_as_a_win(store):
    trade = _open(store, _signal())
    update = TradeTracker(store).review(trade, [candle(1, 108, 100), candle(2, 116, 110)])
    assert update.status == "win"
    assert update.exit_reason == "tp2"
    assert update.r_multiple == pytest.approx(3.0)


def test_stop_wins_the_tie_when_one_candle_touches_both(store):
    """Intrabar order is unknowable, so the pessimistic read is the honest one."""
    trade = _open(store, _signal())
    update = TradeTracker(store).review(trade, [candle(1, 116, 94)])
    assert update.status == "loss"
    assert update.exit_reason == "sl"


def test_stop_moves_to_breakeven_after_the_first_target(store):
    trade = _open(store, _signal())
    tracker = TradeTracker(store)

    assert tracker.review(trade, [candle(1, 108, 101)]) is None  # tp1 hit, still open
    reopened = store.open_trades()[0]
    assert reopened["tps_hit"] == 1
    assert reopened["stop_at"] == pytest.approx(100.0)

    update = tracker.review(reopened, [candle(2, 104, 99)])
    assert update.status == "breakeven"
    assert update.exit_reason == "be"
    assert update.r_multiple == pytest.approx(0.0)


def test_trade_is_force_closed_after_the_deadline(store):
    trade = _open(store, _signal(), max_hold_seconds=3600)  # 1 hour
    late = Candle(ts=TS + 2 * HOUR, open=103, high=104, low=102, close=103, volume=1)
    update = TradeTracker(store).review(trade, [late])
    assert update.exit_reason == "timeout"
    assert update.status == "win"
    assert update.r_multiple == pytest.approx(0.6)


def test_timeout_at_a_loss_is_recorded_as_a_loss(store):
    trade = _open(store, _signal(), max_hold_seconds=3600)
    late = Candle(ts=TS + 2 * HOUR, open=97, high=98, low=96, close=97, volume=1)
    update = TradeTracker(store).review(trade, [late])
    assert update.exit_reason == "timeout"
    assert update.status == "loss"


def test_short_trades_mirror_long_logic(store):
    signal = _signal(side=Side.SHORT, entry=100.0, stop=105.0, targets=(92.5, 85.0))
    trade = _open(store, signal)
    update = TradeTracker(store).review(trade, [candle(1, 101, 84)])
    assert update.status == "win"
    assert update.exit_reason == "tp2"
    assert update.r_multiple == pytest.approx(3.0)


def test_short_stop_is_above_entry(store):
    signal = _signal(side=Side.SHORT, entry=100.0, stop=105.0, targets=(92.5,))
    trade = _open(store, signal)
    update = TradeTracker(store).review(trade, [candle(1, 106, 99)])
    assert update.status == "loss"
    assert update.r_multiple == pytest.approx(-1.0)


def test_already_reviewed_candles_are_not_replayed(store):
    trade = _open(store, _signal())
    tracker = TradeTracker(store)
    tracker.review(trade, [candle(1, 102, 99)])

    reopened = store.open_trades()[0]
    assert reopened["last_checked_ts"] == TS + STEP
    # feeding the same candle again must not re-trigger anything
    assert tracker.review(reopened, [candle(1, 102, 99)]) is None


def test_excursions_are_tracked_while_open(store):
    trade = _open(store, _signal())
    TradeTracker(store).review(trade, [candle(1, 106, 97)])
    row = store.open_trades()[0]
    assert row["max_favorable_r"] == pytest.approx(1.2)
    assert row["max_adverse_r"] == pytest.approx(-0.6)
