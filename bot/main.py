"""Signal bot entry point: poll KuCoin Futures, run the strategy, post to Telegram."""

from __future__ import annotations

import asyncio
import logging
import signal
import time

from .config import Config
from .exchange import KuCoinError, KuCoinFutures
from .models import Signal
from .notifier import TelegramNotifier, format_signal
from .state import SignalState
from .strategies import build_strategy

log = logging.getLogger("bot")


async def run(config: Config) -> None:
    strategy = build_strategy(config.strategy, config.strategy_params)
    state = SignalState(config.state_path)
    exchange = KuCoinFutures()
    notifier = TelegramNotifier(
        config.telegram_token, config.telegram_chat_id, dry_run=config.dry_run
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    try:
        await _preflight(config, strategy, exchange, notifier)

        while not stop.is_set():
            started = time.time()
            for symbol in config.symbols:
                if stop.is_set():
                    break
                await _process_symbol(symbol, config, strategy, exchange, notifier, state)

            wait = _seconds_until_next_run(config, elapsed=time.time() - started)
            log.debug("sleeping %.1fs until next check", wait)
            try:
                await asyncio.wait_for(stop.wait(), timeout=wait)
            except asyncio.TimeoutError:
                pass
    finally:
        log.info("shutting down")
        await exchange.aclose()
        await notifier.aclose()


async def _preflight(
    config: Config,
    strategy,
    exchange: KuCoinFutures,
    notifier: TelegramNotifier,
) -> None:
    """Fail fast on bad config: wrong token, unknown symbols, broken kline format."""
    username = await notifier.verify()
    log.info("telegram bot: @%s", username)

    active = set(await exchange.active_symbols())
    unknown = [s for s in config.symbols if s not in active]
    if unknown:
        raise SystemExit(
            f"these symbols are not active KuCoin Futures contracts: {', '.join(unknown)}. "
            f"KuCoin uses names like XBTUSDTM (BTC) and ETHUSDTM."
        )

    probe = await exchange.closed_klines(config.symbols[0], config.granularity, limit=5)
    log.info(
        "kline probe ok: %s last close=%s at %s",
        config.symbols[0],
        probe[-1].close,
        probe[-1].opened_at,
    )

    if config.send_startup_message:
        await notifier.send(
            "🤖 Бот сигналов запущен\n"
            f"Пары: {', '.join(config.symbols)}\n"
            f"Таймфрейм: {config.granularity}m · стратегия: {strategy.name}"
        )


async def _process_symbol(
    symbol: str,
    config: Config,
    strategy,
    exchange: KuCoinFutures,
    notifier: TelegramNotifier,
    state: SignalState,
) -> None:
    try:
        candles = await exchange.closed_klines(symbol, config.granularity, config.history_candles)
    except KuCoinError as exc:
        log.error("could not fetch candles for %s: %s", symbol, exc)
        return

    if len(candles) < strategy.warmup:
        log.warning(
            "%s: only %d closed candles, strategy needs %d — skipping",
            symbol,
            len(candles),
            strategy.warmup,
        )
        return

    try:
        result: Signal | None = strategy.evaluate(symbol, candles)
    except Exception:
        log.exception("strategy %s raised on %s", strategy.name, symbol)
        return

    if result is None:
        return

    if not state.should_send(result, config.granularity, config.cooldown_candles):
        log.info("%s: %s suppressed (duplicate or cooldown)", symbol, result.side.value)
        return

    if await notifier.send(format_signal(result, config.granularity)):
        state.record(result)
        log.info("%s: sent %s @ %s", symbol, result.side.value, result.price)


def _seconds_until_next_run(config: Config, elapsed: float) -> float:
    if config.poll_interval_seconds > 0:
        return max(1.0, config.poll_interval_seconds - elapsed)

    period = config.granularity * 60
    now = time.time()
    next_close = (int(now) // period + 1) * period
    return max(1.0, next_close + config.candle_lag_seconds - now)


def main() -> None:
    try:
        config = Config.from_env()
    except ValueError as exc:
        raise SystemExit(f"Ошибка конфигурации: {exc}")

    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    log.info(
        "starting: symbols=%s granularity=%sm strategy=%s dry_run=%s",
        ",".join(config.symbols),
        config.granularity,
        config.strategy,
        config.dry_run,
    )
    try:
        asyncio.run(run(config))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
