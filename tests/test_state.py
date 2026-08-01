from bot.models import Side, Signal
from bot.state import SignalState

GRAN = 15
MINUTE = 60 * 1000


def _signal(ts: int, side: Side = Side.LONG) -> Signal:
    return Signal(symbol="XBTUSDTM", side=side, strategy="ema_rsi", candle_ts=ts, price=100.0)


def test_first_signal_always_sends(tmp_path):
    state = SignalState(str(tmp_path / "state.json"))
    assert state.should_send(_signal(1000), GRAN, cooldown_candles=3)


def test_same_candle_is_not_resent(tmp_path):
    state = SignalState(str(tmp_path / "state.json"))
    sig = _signal(1_700_000_000_000)
    state.record(sig)
    assert not state.should_send(sig, GRAN, cooldown_candles=3)


def test_same_direction_waits_out_cooldown(tmp_path):
    state = SignalState(str(tmp_path / "state.json"))
    base = 1_700_000_000_000
    state.record(_signal(base))
    assert not state.should_send(_signal(base + 2 * GRAN * MINUTE), GRAN, cooldown_candles=3)
    assert state.should_send(_signal(base + 3 * GRAN * MINUTE), GRAN, cooldown_candles=3)


def test_reversal_bypasses_cooldown(tmp_path):
    state = SignalState(str(tmp_path / "state.json"))
    base = 1_700_000_000_000
    state.record(_signal(base, Side.LONG))
    assert state.should_send(_signal(base + GRAN * MINUTE, Side.SHORT), GRAN, cooldown_candles=3)


def test_state_survives_restart(tmp_path):
    path = str(tmp_path / "state.json")
    sig = _signal(1_700_000_000_000)
    SignalState(path).record(sig)
    assert not SignalState(path).should_send(sig, GRAN, cooldown_candles=3)


def test_corrupt_state_file_does_not_crash(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{not json")
    assert SignalState(str(path)).should_send(_signal(1000), GRAN, cooldown_candles=3)
