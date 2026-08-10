import pytest

from bot.config import Config
from bot.models import Candle, Side
from bot.notifier import format_signal
from bot.strategies import build_strategy

BASE_ENV = {
    "TELEGRAM_BOT_TOKEN": "123:abc",
    "TELEGRAM_CHAT_ID": "@channel",
}


def _candles(prices: list[float]) -> list[Candle]:
    return [
        Candle(ts=1_700_000_000_000 + i * 900_000, open=p, high=p * 1.01, low=p * 0.99, close=p, volume=100.0)
        for i, p in enumerate(prices)
    ]


def test_config_requires_telegram_credentials():
    with pytest.raises(ValueError, match="TELEGRAM_BOT_TOKEN"):
        Config.from_env({})


def test_config_rejects_granularity_kucoin_does_not_support():
    with pytest.raises(ValueError, match="GRANULARITY"):
        Config.from_env({**BASE_ENV, "GRANULARITY": "7"})


def test_strategy_params_are_collected_by_prefix():
    config = Config.from_env({**BASE_ENV, "STRAT_EMA_FAST": "9", "SYMBOLS": "solusdtm"})
    assert config.strategy_params["EMA_FAST"] == "9"
    assert config.symbols == ["SOLUSDTM"]


def test_unknown_strategy_names_are_rejected():
    with pytest.raises(KeyError):
        build_strategy("does_not_exist")


def test_no_signal_before_warmup():
    strategy = build_strategy("ema_rsi")
    assert strategy.evaluate("XBTUSDTM", _candles([100.0] * 10)) is None


def test_flat_market_produces_no_signal():
    strategy = build_strategy("ema_rsi")
    assert strategy.evaluate("XBTUSDTM", _candles([100.0] * 200)) is None


def _walk_forward(strategy, prices: list[float], symbol: str = "XBTUSDTM"):
    """Replay the series candle by candle, the way the runner does live."""
    candles = _candles(prices)
    signals = []
    for i in range(strategy.warmup, len(candles) + 1):
        signal = strategy.evaluate(symbol, candles[:i])
        if signal is not None:
            signals.append(signal)
    return signals


# Measured reversals: gentle enough that RSI is still under the filter when the
# EMAs cross. A sharper V-bounce is deliberately rejected by the RSI gate —
# see test_overextended_bounce_is_filtered_out.
DOWN_THEN_UP = [200.0 - i for i in range(120)] + [80.0 + i * 0.8 for i in range(60)]
UP_THEN_DOWN = [100.0 + i for i in range(120)] + [220.0 - i * 0.8 for i in range(60)]


def test_downtrend_reversing_up_gives_a_long_with_stop_below_entry():
    strategy = build_strategy("ema_rsi")
    signals = _walk_forward(strategy, DOWN_THEN_UP)
    assert signals, "expected at least one signal on a trend reversal"
    signal = signals[0]
    assert signal.side is Side.LONG
    assert signal.stop_loss < signal.price
    assert all(tp > signal.price for tp in signal.take_profits)


def test_uptrend_reversing_down_gives_a_short_with_stop_above_entry():
    strategy = build_strategy("ema_rsi")
    signals = _walk_forward(strategy, UP_THEN_DOWN)
    assert signals, "expected at least one signal on a trend reversal"
    signal = signals[0]
    assert signal.side is Side.SHORT
    assert signal.stop_loss > signal.price
    assert all(tp < signal.price for tp in signal.take_profits)


def test_overextended_bounce_is_filtered_out():
    """A vertical V-recovery crosses the EMAs with RSI ~74 — the filter must veto it."""
    strategy = build_strategy("ema_rsi")
    violent = [200.0 - i for i in range(120)] + [80.0 + i * 3 for i in range(40)]
    assert _walk_forward(strategy, violent) == []


def test_signal_is_anchored_to_the_last_closed_candle():
    strategy = build_strategy("ema_rsi")
    candles = _candles(DOWN_THEN_UP)
    for i in range(strategy.warmup, len(candles) + 1):
        signal = strategy.evaluate("XBTUSDTM", candles[:i])
        if signal is not None:
            assert signal.candle_ts == candles[i - 1].ts
            assert signal.price == candles[i - 1].close
            return
    pytest.fail("no signal produced")


def test_formatted_message_escapes_html_and_names_the_pair():
    strategy = build_strategy("ema_rsi")
    signal = _walk_forward(strategy, DOWN_THEN_UP, symbol="XBT<USDTM")[0]
    text = format_signal(signal, granularity=15)
    assert "XBT&lt;USDTM" in text
    assert "LONG" in text
    assert "15m" in text


def test_config_rejects_non_positive_starting_balance():
    with pytest.raises(ValueError, match="STARTING_BALANCE"):
        Config.from_env({**BASE_ENV, "STARTING_BALANCE": "0"})


def test_config_rejects_risk_per_trade_out_of_range():
    with pytest.raises(ValueError, match="RISK_PER_TRADE_PCT"):
        Config.from_env({**BASE_ENV, "RISK_PER_TRADE_PCT": "0"})
    with pytest.raises(ValueError, match="RISK_PER_TRADE_PCT"):
        Config.from_env({**BASE_ENV, "RISK_PER_TRADE_PCT": "150"})


def test_config_balance_defaults_are_sane():
    config = Config.from_env(BASE_ENV)
    assert config.starting_balance == 1000.0
    assert config.risk_per_trade_pct == 1.0
    assert config.balance_currency == "USDT"
