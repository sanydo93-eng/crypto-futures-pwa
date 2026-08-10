"""Virtual balance: fixed-risk compounding replayed over closed trades.

No exchange API keys exist anywhere in this bot — this is purely a way to
read a stream of R multiples as money against a starting number the user
picks.
"""

import pytest

from bot import balance
from bot.models import Side, Signal
from bot.storage import Storage

TS = 1_700_000_000_000
STEP = 900_000


@pytest.fixture
def store(tmp_path):
    storage = Storage(str(tmp_path / "signals.db"))
    yield storage
    storage.close()


def _signal(ts=TS, symbol="XBTUSDTM") -> Signal:
    return Signal(
        symbol=symbol, side=Side.LONG, strategy="fvg_retest", candle_ts=ts,
        price=100.0, stop_loss=95.0, take_profits=[110.0], strength=70.0, grade="B",
    )


def _open_with_risk(store, risk_amount, ts=TS, symbol="XBTUSDTM"):
    store.save_signal(_signal(ts, symbol), granularity=15, candles=[], max_hold_seconds=86400,
                      risk_amount=risk_amount)
    return [t for t in store.open_trades() if t["symbol"] == symbol][-1]


def _close(store, trade_row, r_multiple, closed_at):
    store.close_trade(
        trade_id=int(trade_row["id"]), status="win" if r_multiple > 0 else "loss",
        closed_at=closed_at, exit_price=100.0, exit_reason="tp1" if r_multiple > 0 else "sl",
        pnl_pct=r_multiple * 5, r_multiple=r_multiple,
    )


def test_no_trades_returns_the_starting_balance(store):
    result = balance.build(store, starting_balance=1000.0, risk_pct=1.0, currency="USDT")
    assert result["balance"] == 1000.0
    assert result["change_pct"] == 0.0
    assert result["curve"] == [{"ts": None, "balance": 1000.0}]


def test_a_winning_trade_grows_the_balance_by_risk_times_r(store):
    trade = _open_with_risk(store, risk_amount=10.0)
    _close(store, trade, r_multiple=2.0, closed_at=TS + STEP)

    result = balance.build(store, starting_balance=1000.0, risk_pct=1.0, currency="USDT")
    assert result["balance"] == 1020.0
    assert result["change_pct"] == 2.0


def test_a_losing_trade_shrinks_the_balance(store):
    trade = _open_with_risk(store, risk_amount=10.0)
    _close(store, trade, r_multiple=-1.0, closed_at=TS + STEP)

    result = balance.build(store, starting_balance=1000.0, risk_pct=1.0, currency="USDT")
    assert result["balance"] == 990.0


def test_compounding_uses_the_balance_at_the_time_each_trade_opened(store):
    r1 = balance.risk_amount_now(store, starting_balance=1000.0, risk_pct=1.0)
    assert r1 == pytest.approx(10.0)
    t1 = _open_with_risk(store, risk_amount=r1, ts=TS)
    _close(store, t1, r_multiple=3.0, closed_at=TS + STEP)  # balance -> 1030

    r2 = balance.risk_amount_now(store, starting_balance=1000.0, risk_pct=1.0)
    assert r2 == pytest.approx(10.30)
    t2 = _open_with_risk(store, risk_amount=r2, ts=TS + STEP, symbol="ETHUSDTM")
    _close(store, t2, r_multiple=2.0, closed_at=TS + 2 * STEP)  # balance -> 1030 + 20.6

    result = balance.build(store, starting_balance=1000.0, risk_pct=1.0, currency="USDT")
    assert result["balance"] == pytest.approx(1050.6)


def test_a_later_close_cannot_change_what_an_earlier_trade_was_worth(store):
    """risk_amount is fixed at open time, so replay order doesn't retroactively
    rewrite an earlier trade's pnl even when a later-opened trade closes first."""
    t1 = _open_with_risk(store, risk_amount=10.0, ts=TS, symbol="XBTUSDTM")
    t2 = _open_with_risk(store, risk_amount=10.0, ts=TS + STEP, symbol="ETHUSDTM")
    # t2 (opened second) closes first
    _close(store, t2, r_multiple=1.0, closed_at=TS + 2 * STEP)
    _close(store, t1, r_multiple=1.0, closed_at=TS + 3 * STEP)

    result = balance.build(store, starting_balance=1000.0, risk_pct=1.0, currency="USDT")
    assert result["balance"] == pytest.approx(1020.0)


def test_legacy_rows_without_a_stored_risk_amount_fall_back_to_config(store):
    trade = _open_with_risk(store, risk_amount=None)  # as if saved before this feature shipped
    _close(store, trade, r_multiple=2.0, closed_at=TS + STEP)

    result = balance.build(store, starting_balance=1000.0, risk_pct=1.0, currency="USDT")
    assert result["balance"] == 1020.0  # falls back to starting_balance * risk_pct / 100


def test_open_trades_are_reported_as_at_risk_not_realized(store):
    _open_with_risk(store, risk_amount=15.0)
    result = balance.build(store, starting_balance=1000.0, risk_pct=1.0, currency="USDT")
    assert result["balance"] == 1000.0  # unaffected until closed
    assert result["open_trades"] == 1
    assert result["at_risk"] == 15.0


def test_curve_accumulates_in_close_order(store):
    t1 = _open_with_risk(store, risk_amount=10.0, ts=TS, symbol="XBTUSDTM")
    t2 = _open_with_risk(store, risk_amount=10.0, ts=TS + STEP, symbol="ETHUSDTM")
    _close(store, t1, r_multiple=1.0, closed_at=TS + 10 * STEP)
    _close(store, t2, r_multiple=-1.0, closed_at=TS + 20 * STEP)

    curve = balance.build(store, starting_balance=1000.0, risk_pct=1.0, currency="USDT")["curve"]
    assert [p["balance"] for p in curve] == [1000.0, 1010.0, 1000.0]


def test_currency_and_risk_pct_pass_through(store):
    result = balance.build(store, starting_balance=500.0, risk_pct=2.5, currency="USDC")
    assert result["currency"] == "USDC"
    assert result["risk_per_trade_pct"] == 2.5
    assert result["starting_balance"] == 500.0
